// Small DOM helpers shared by every page. No framework: pages render HTML strings built
// with html`` (which escapes interpolations) and attach behaviour with event delegation.
import { icon } from '../ui/icons.js';

export const api = window.termlo;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ESCAPES[c]);

// Marks a string as already-safe HTML so html`` does not escape it again.
class Safe { constructor(value) { this.value = value; } toString() { return this.value; } }
export const raw = value => new Safe(String(value));

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, i) => {
    if (Array.isArray(value)) out += value.map(v => (v instanceof Safe ? v.value : escape(v))).join('');
    else if (value instanceof Safe) out += value.value;
    else if (value === false || value === null || value === undefined) out += '';
    else out += escape(value);
    out += strings[i + 1];
  });
  return new Safe(out);
}

export const ico = (name, size) => raw(icon(name, size ? { size } : {}));

export function $(selector, root = document) { return root.querySelector(selector); }
export function $$(selector, root = document) { return [...root.querySelectorAll(selector)]; }

export function render(element, content) {
  element.innerHTML = content instanceof Safe ? content.value : escape(content);
}

// Delegated events: on(root, 'click', '[data-action="x"]', handler)
export function on(root, type, selector, handler) {
  root.addEventListener(type, event => {
    const target = event.target.closest(selector);
    if (target && root.contains(target)) handler(event, target);
  });
}

// ---- formatting -----------------------------------------------------------------
export function bytes(value) {
  if (!Number.isFinite(value)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = value, unit = 0;
  while (n >= 1024 && unit < units.length - 1) { n /= 1024; unit++; }
  return `${n >= 10 || unit === 0 ? Math.round(n) : n.toFixed(1)} ${units[unit]}`;
}

export function when(value) {
  if (!value) return '';
  const date = new Date(value);
  const now = new Date();
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) + ' ' + time;
}

export function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)} 秒`;
  if (ms < 60000) return `${Math.round(ms / 1000)} 秒`;
  return `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒`;
}

export const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ---- toasts -----------------------------------------------------------------------
export function toast(text, { tone, action, onAction, timeout = 4000 } = {}) {
  const region = $('#toasts');
  const item = document.createElement('div');
  item.className = 'toast';
  if (tone) item.dataset.tone = tone;
  const iconName = { success: 'status-success', danger: 'status-error', warning: 'status-warning' }[tone] || 'status-info';
  render(item, html`${ico(iconName)}<span class="toast-text">${text}</span>${action ? html`<button class="btn btn-sm btn-ghost" type="button">${action}</button>` : ''}<button class="btn btn-icon btn-sm btn-ghost" type="button" data-close aria-label="关闭" title="关闭">${ico('close', 'sm')}</button>`);
  const close = () => item.remove();
  item.querySelector('[data-close]').addEventListener('click', close);
  if (action) item.querySelector('.btn:not([data-close])').addEventListener('click', () => { close(); onAction?.(); });
  region.append(item);
  while (region.childElementCount > 3) region.firstElementChild.remove();
  if (timeout) setTimeout(close, tone === 'danger' ? timeout * 2 : timeout);
  return close;
}

export const fail = error => toast(message(error), { tone: 'danger' });

// ---- dialogs ----------------------------------------------------------------------
// dialog({ title, body, actions: [{ label, value, tone }], form }) -> Promise<{ value, data }>
export function dialog({ title, body = '', actions = [{ label: '确定', value: 'ok', tone: 'primary' }], wide = false, onOpen }) {
  return new Promise(resolve => {
    const element = document.createElement('dialog');
    element.className = 'dialog' + (wide ? ' dialog-wide' : '');
    const id = 'd' + Math.random().toString(36).slice(2);
    element.setAttribute('aria-labelledby', id);
    render(element, html`
      <form method="dialog" novalidate>
        <div class="dialog-header">
          <h2 class="dialog-title" id="${id}">${title}</h2>
          <button class="btn btn-icon btn-ghost" value="cancel" formnovalidate aria-label="关闭" title="关闭">${ico('close')}</button>
        </div>
        <div class="dialog-body">${body}</div>
        ${actions.length ? html`<div class="dialog-footer">
          ${actions.map(a => html`<button class="btn ${a.tone ? 'btn-' + a.tone : ''}" value="${a.value}" ${a.value === 'cancel' ? raw('formnovalidate') : ''}>${a.label}</button>`)}
        </div>` : ''}
      </form>`);
    document.body.append(element);
    const form = element.querySelector('form');
    form.addEventListener('submit', event => {
      const value = event.submitter?.value || 'ok';
      if (value !== 'cancel' && !form.checkValidity()) { event.preventDefault(); form.reportValidity(); return; }
      element.returnValue = value;
    });
    element.addEventListener('close', () => {
      const data = Object.fromEntries(new FormData(form));
      element.remove();
      resolve({ value: element.returnValue || 'cancel', data, form });
    });
    element.showModal();
    onOpen?.(element);
  });
}

export async function confirm({ title, text, action, tone = 'danger' }) {
  const { value } = await dialog({
    title,
    body: html`<p>${text}</p>`,
    actions: [{ label: '取消', value: 'cancel', tone: 'ghost' }, { label: action, value: 'ok', tone }],
  });
  return value === 'ok';
}

// ---- tiny store --------------------------------------------------------------------
export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    set(patch) { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; listeners.forEach(fn => fn(state)); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

// Single-selection groups (tabs, segmented) with roving tabindex and arrow keys.
export function selectable(container, itemSelector, stateAttribute, onSelect) {
  const items = () => $$(itemSelector, container);
  const choose = (item, focus) => {
    for (const el of items()) { el.setAttribute(stateAttribute, String(el === item)); el.tabIndex = el === item ? 0 : -1; }
    if (focus) item.focus();
    onSelect?.(item);
  };
  for (const el of items()) el.tabIndex = el.getAttribute(stateAttribute) === 'true' ? 0 : -1;
  container.addEventListener('click', event => { const item = event.target.closest(itemSelector); if (item) choose(item, false); });
  container.addEventListener('keydown', event => {
    const keys = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 };
    const current = event.target.closest(itemSelector);
    if (!current) return;
    const list = items(), index = list.indexOf(current);
    let next;
    if (event.key in keys) next = list[(index + keys[event.key] + list.length) % list.length];
    else if (event.key === 'Home') next = list[0];
    else if (event.key === 'End') next = list.at(-1);
    if (!next) return;
    event.preventDefault();
    choose(next, true);
  });
}

export function uid(prefix = 'x') {
  return prefix + '-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// Popup menu anchored to a button. items: [{ label, icon, danger, run } | 'separator']
// items: { label, icon, run, danger, hint } | 'separator'. Opens below the anchor element,
// or at the pointer when the anchor is a { x, y, focus } point (right-click menus).
export function menu(anchor, items) {
  document.querySelector('.menu[data-popup]')?.remove();
  const element = document.createElement('div');
  element.className = 'menu';
  element.dataset.popup = '';
  element.setAttribute('role', 'menu');
  render(element, html`${items.map((item, i) => item === 'separator'
    ? html`<hr class="menu-sep">`
    : html`<button class="menu-item ${item.danger ? 'menu-item-danger' : ''}" type="button" role="menuitem" data-index="${i}">${item.icon ? ico(item.icon, 'sm') : ''}<span class="menu-label">${item.label}</span>${item.hint ? html`<kbd class="menu-hint">${item.hint}</kbd>` : ''}</button>`)}`);
  document.body.append(element);
  const point = !(anchor instanceof Element);
  const box = point ? { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y } : anchor.getBoundingClientRect();
  const width = element.offsetWidth, height = element.offsetHeight;
  element.style.left = Math.max(8, Math.min(point ? box.left : box.right - width, innerWidth - width - 8)) + 'px';
  element.style.top = (box.bottom + height + 8 > innerHeight ? box.top - height - 4 : box.bottom + 4) + 'px';
  const close = () => { element.remove(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true); (point ? anchor.focus : anchor)?.focus?.(); };
  const outside = event => { if (!element.contains(event.target)) close(); };
  const key = event => {
    const buttons = [...element.querySelectorAll('.menu-item')];
    const index = buttons.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'ArrowDown') { event.preventDefault(); buttons[(index + 1) % buttons.length].focus(); }
    if (event.key === 'ArrowUp') { event.preventDefault(); buttons[(index - 1 + buttons.length) % buttons.length].focus(); }
  };
  element.addEventListener('click', event => {
    const button = event.target.closest('[data-index]');
    if (!button) return;
    close();
    items[Number(button.dataset.index)].run();
  });
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key, true); });
  element.querySelector('.menu-item')?.focus();
}

// Right-click menu at the pointer. focus: the element that gets focus back afterwards.
export function contextMenu(event, items, focus = event.target.closest('button, a, [tabindex]')) {
  event.preventDefault();
  menu({ x: event.clientX, y: event.clientY, focus }, items);
}
