// Streaming Chat Completions client (OpenAI-compatible).
// Text deltas are reported as they arrive; tool calls are returned only once complete.
const http = require('node:http');
const https = require('node:https');

const IDLE_TIMEOUT_MS = 120000;
const TOTAL_TIMEOUT_MS = 600000;
const MAX_TOOL_CALLS = 16;

class ModelError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

function endpoint(baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : base + '/chat/completions';
}

// Parses an SSE byte stream into JSON payloads. Returns a feed(chunk) function.
function sseParser(onData) {
  let buffer = '';
  return chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index).replace(/^\r?\n\r?\n/, '');
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { onData(JSON.parse(data)); } catch { /* ignore keep-alive or malformed lines */ }
    }
  };
}

// Accumulates streamed deltas into one assistant message.
// onReasoning receives the model's thinking as it streams (shown live, never stored as an answer).
function accumulator(onText, onReasoning = () => {}) {
  const state = { content: '', reasoning: '', calls: [], finish: null, usage: null, error: null };
  return {
    state,
    add(payload) {
      if (payload.error) { state.error = payload.error.message || JSON.stringify(payload.error); return; }
      if (payload.usage) state.usage = payload.usage;
      const choice = payload.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) state.finish = choice.finish_reason;
      const delta = choice.delta || choice.message || {};
      if (typeof delta.content === 'string' && delta.content) { state.content += delta.content; onText(delta.content); }
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) { state.reasoning += reasoning; onReasoning(reasoning); }
      for (const [position, part] of (delta.tool_calls || []).entries()) {
        const index = Number.isInteger(part.index) ? part.index : position;
        const call = state.calls[index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (part.id) call.id = part.id;
        if (part.function?.name) call.function.name += part.function.name;
        if (typeof part.function?.arguments === 'string') call.function.arguments += part.function.arguments;
      }
    },
  };
}

function finalize(state) {
  if (state.error) throw new ModelError('模型接口返回错误：' + String(state.error).slice(0, 300), { retryable: true });
  if (state.finish === 'length') throw new ModelError('模型回复被长度限制截断，请换用输出上限更大的模型或简化任务');
  const calls = state.calls.filter(Boolean);
  if (calls.length > MAX_TOOL_CALLS) throw new ModelError('模型一次返回的工具调用过多');
  const seen = new Set();
  calls.forEach((call, i) => {
    if (!call.id) call.id = `call_${Date.now().toString(36)}_${i}`;
    if (seen.has(call.id) || !call.function.name || call.function.arguments.length > 300000) throw new ModelError('模型返回了不完整或重复的工具调用', { retryable: true });
    seen.add(call.id);
    if (!call.function.arguments.trim()) call.function.arguments = '{}';
  });
  if (!state.content && !calls.length) throw new ModelError('模型返回了空回复', { retryable: true });
  const message = { role: 'assistant', content: state.content || null };
  if (calls.length) message.tool_calls = calls;
  if (state.reasoning) message.reasoning_content = state.reasoning.slice(0, 60000);
  const usage = state.usage || {};
  return {
    message,
    tokens: Number(usage.total_tokens) || 0,
    usage: {
      prompt: Number(usage.prompt_tokens) || 0,
      completion: Number(usage.completion_tokens) || 0,
      cached: Number(usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens) || 0,
    },
  };
}

function complete({ baseUrl, model, apiKey, messages, tools, signal, onText = () => {}, onReasoning = () => {} }) {
  const url = new URL(endpoint(baseUrl));
  const body = JSON.stringify({
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
  });
  const { state, add } = accumulator(onText, onReasoning);

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = error => { if (!settled) { settled = true; cleanup(); reject(error); } };
    const done = () => { if (!settled) { try { const result = finalize(state); settled = true; cleanup(); resolve(result); } catch (error) { fail(error); } } };

    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) },
    }, response => {
      const status = response.statusCode;
      if (status >= 300 && status < 400) { response.resume(); return fail(new ModelError('模型接口发生重定向，请填写最终 API 地址', { status })); }
      if (status < 200 || status >= 300) {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { if (text.length < 2000) text += chunk; });
        response.on('end', () => {
          let detail = '';
          try { detail = JSON.parse(text).error?.message || ''; } catch { detail = text.slice(0, 200); }
          fail(new ModelError(`模型接口返回 HTTP ${status}${detail ? '：' + String(detail).slice(0, 200) : ''}`, { status, retryable: status === 429 || status >= 500 }));
        });
        return;
      }
      response.setEncoding('utf8');
      const isStream = String(response.headers['content-type'] || '').includes('text/event-stream');
      let raw = '';
      const feed = sseParser(add);
      response.on('data', chunk => {
        idle.refresh();
        if (isStream) feed(chunk);
        else if ((raw += chunk).length > 8 * 1024 * 1024) req.destroy(new ModelError('模型响应过大'));
      });
      response.on('end', () => {
        if (!isStream) {
          // Some providers ignore stream:true and answer with a single JSON body.
          try { add(JSON.parse(raw)); } catch { return fail(new ModelError('模型接口未返回有效数据', { retryable: true })); }
        }
        done();
      });
      response.on('error', error => fail(new ModelError('模型连接中断：' + error.message, { retryable: true })));
    });

    const idle = setTimeout(() => req.destroy(new ModelError('模型接口长时间无响应', { retryable: true })), IDLE_TIMEOUT_MS);
    const total = setTimeout(() => req.destroy(new ModelError('模型请求超时', { retryable: true })), TOTAL_TIMEOUT_MS);
    const abort = () => req.destroy(new ModelError('已取消'));
    function cleanup() { clearTimeout(idle); clearTimeout(total); signal?.removeEventListener('abort', abort); }

    if (signal?.aborted) return fail(new ModelError('已取消'));
    signal?.addEventListener('abort', abort, { once: true });
    req.on('error', error => fail(error instanceof ModelError ? error : new ModelError('无法连接模型接口：' + error.message, { retryable: true })));
    req.end(body);
  });
}

module.exports = { complete, ModelError, sseParser, accumulator, finalize };
