const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const blocked = new net.BlockList();
const blockedV6 = new net.BlockList();
for (const [ip, bits] of [['0.0.0.0',8],['10.0.0.0',8],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['100.64.0.0',10],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(ip,bits,'ipv4');
for (const [ip,bits] of [['::',96],['::ffff:0:0',96],['fc00::',7],['fe80::',10],['ff00::',8]]) blockedV6.addSubnet(ip,bits,'ipv6');
function isPublic(address) { const family = net.isIP(address); return !!family && !(family === 4 ? blocked : blockedV6).check(address, family === 4 ? 'ipv4' : 'ipv6'); }
async function request(urlString, { method = 'GET', headers = {}, body, signal, publicOnly = false, maxBytes = 4*1024*1024, timeout = 180000, redirects = 0 } = {}) {
  const url = new URL(urlString);
  if (!['https:','http:'].includes(url.protocol) || url.username || url.password) throw new Error('仅支持不含凭据的 HTTP(S) 地址');
  let lookup;
  if (publicOnly) {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await dns.lookup(hostname, { all: true });
    if (!addresses.length || addresses.some(item => !isPublic(item.address))) throw new Error('网页工具仅访问公网；服务器内网资源请使用已授权主机工具');
    const selected = addresses[0];
    lookup = (_name, options, callback) => options?.all ? callback(null, [selected]) : callback(null, selected.address, selected.family);
  }
  signal?.throwIfAborted();
  const result = await new Promise((resolve,reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, { method, headers, signal, lookup }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > maxBytes) { req.destroy(new Error('响应超过大小限制')); return; } chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8'), url: url.href }));
    });
    // Wall-clock deadline, not only socket inactivity.
    const timer = setTimeout(() => req.destroy(new Error('网络请求超时')), timeout);
    req.on('close', () => clearTimeout(timer)); req.on('error', reject);
    if (body) req.write(body); req.end();
  });
  if (result.status >= 300 && result.status < 400 && result.headers.location) {
    if (!publicOnly) throw new Error('模型接口发生重定向，请填写最终 API 地址');
    if (redirects >= 4) throw new Error('网页重定向过多');
    return request(new URL(result.headers.location, url).href, { signal, publicOnly, maxBytes, timeout, redirects: redirects+1 });
  }
  return result;
}
async function completion(settings, apiKey, messages, tools, signal) {
  const base = settings.baseUrl.replace(/\/+$/, '');
  const result = await request(base.endsWith('/chat/completions') ? base : base + '/chat/completions', {
    method: 'POST', signal, headers: { 'Content-Type':'application/json', ...(apiKey ? { Authorization: 'Bearer '+apiKey } : {}) },
    body: JSON.stringify({ model: settings.model, messages, stream: false, ...(tools?.length ? { tools, tool_choice: 'auto' } : {}) }),
  });
  if (result.status < 200 || result.status >= 300) throw new Error(`模型接口返回 HTTP ${result.status}。请检查地址、密钥、模型权限或额度。`);
  let response; try { response = JSON.parse(result.text); } catch { throw new Error('模型接口未返回有效 JSON'); }
  const choice = response.choices?.[0];
  if (!choice?.message || choice.finish_reason === 'length') throw new Error(choice?.finish_reason === 'length' ? '模型回复被长度限制截断，请调整服务端模型输出限制后继续' : '模型接口响应不兼容 Chat Completions');
  const raw = choice.message;
  const calls = raw.tool_calls || [];
  if (!Array.isArray(calls) || calls.length > 16) throw new Error('模型返回的工具调用数量无效');
  const ids = new Set();
  for (const call of calls) {
    if (call.type !== 'function' || typeof call.id !== 'string' || !call.id || ids.has(call.id) || typeof call.function?.name !== 'string' || typeof call.function.arguments !== 'string' || call.function.arguments.length > 300000) throw new Error('模型返回了不完整或重复的工具调用');
    ids.add(call.id);
  }
  return { message: { role: 'assistant', content: typeof raw.content === 'string' ? raw.content.slice(0,60000) : null, ...(calls.length ? { tool_calls: calls } : {}), ...(typeof raw.reasoning_content === 'string' ? { reasoning_content: raw.reasoning_content.slice(0,60000) } : {}) }, tokens: Number(response.usage?.total_tokens) || 0 };
}
function decode(text) { return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g, x => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&#39;':"'",'&nbsp;':' '})[x]).replace(/&#(x[0-9a-f]+|\d+);/gi,(_m,n)=>{const code=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return code<=0x10ffff?String.fromCodePoint(code):'';}); }
function htmlText(html) { return decode(html.replace(/<(script|style|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ').replace(/<[^>]*>/g,' ')).replace(/[ \t]+/g,' ').replace(/\n\s*\n/g,'\n').trim(); }
async function fetchPage(url, signal, offset = 0) {
  const result = await request(url, { publicOnly: true, signal, maxBytes: 2*1024*1024, timeout: 25000, headers: { 'User-Agent': 'Termlo/1.0 Research', Accept: 'text/html,text/plain,application/json' } });
  if (result.status < 200 || result.status >= 300) throw new Error('网页读取失败：HTTP '+result.status);
  const type = result.headers['content-type'] || '';
  if (!/text|json|xml/.test(type)) throw new Error('网页工具目前只读取文本、HTML 和 JSON，请选择文档网页');
  const main = result.text.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || result.text;
  const text = /html/.test(type) ? htmlText(main) : result.text;
  return { url: result.url, retrievedAt: new Date().toISOString(), text: text.slice(offset,offset+18000), offset, totalCharacters:text.length, nextOffset:text.length>offset+18000?offset+18000:null, truncated: text.length > offset+18000 };
}
function searchResults(html) {
  const anchors=[...html.matchAll(/<a\b([^>]*\bclass="result__a"[^>]*)>([\s\S]*?)<\/a>/gi)];
  const snippets=[...html.matchAll(/<a\b[^>]*\bclass="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)];
  const items=[];
  for(let i=0;i<anchors.length&&items.length<6;i++) {
    const match=anchors[i], href=decode(match[1].match(/\bhref="([^"]+)"/i)?.[1]||'');
    try {const link=new URL(href,'https://duckduckgo.com');const url=new URL(link.searchParams.get('uddg')||link.href);if(!['https:','http:'].includes(url.protocol))continue;items.push({title:htmlText(match[2]),url:url.href,excerpt:htmlText(snippets[i]?.[1]||'').slice(0,1800)});}catch{}
  }
  return items;
}
async function searchWeb(query, signal) {
  const result = await request('https://html.duckduckgo.com/html/?q='+encodeURIComponent(query), { publicOnly: true, signal, maxBytes: 1024*1024, timeout: 25000 });
  if (result.status !== 200) throw new Error('搜索服务暂不可用，可直接读取已知官方文档 URL');
  const items=searchResults(result.text);
  if (!items.length) throw new Error('搜索服务没有返回可解析结果，可直接读取已知官方文档 URL');
  return { query, provider:'DuckDuckGo', retrievedAt: new Date().toISOString(), results: items };
}
module.exports = { request, completion, fetchPage, searchWeb, isPublic, htmlText, searchResults };
