//logsPage.js
//完整日志

import { api } from '../api.js';
import { $, escapeHTML, mapTag } from '../utils.js';

//视图状态
const MAX_DOM_ROWS = 2000;
const POLL_INTERVAL_MS = 1500;
const SCROLL_NEAR_BOTTOM_PX = 12;

let buffer = [];
let lastId = 0;
let levelOn = { info: true, warn: true, err: true, ok: true };
let moduleFilter = '';
let textFilter = '';
let tail = true;
let pollTimer = null;
let bootstrapped = false;

const knownModules = new Set();

function rowHTML(it, kw) {
  const lvl = mapTag(it.level);
  const msg = highlight(it.message, kw);
  const mod = it.module || '—';
  return `
    <div class="lv-row" data-id="${it.id}" title="${escapeHTML(it.datetime || it.time)}">
      <span class="lv-time">${escapeHTML(it.time)}</span>
      <span class="lv-level ${lvl}">${escapeHTML(it.level)}</span>
      <span class="lv-msg"><span class="lv-module">[${escapeHTML(mod)}]</span> ${msg}</span>
    </div>
  `;
}

function highlight(text, kw) {
  text = String(text ?? '');
  if (!kw) return escapeHTML(text);
  const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let out = '', last = 0, m;
  while ((m = re.exec(text)) !== null) {
    out += escapeHTML(text.slice(last, m.index));
    out += `<span class="lv-mark">${escapeHTML(m[0])}</span>`;
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex++; 
  }
  out += escapeHTML(text.slice(last));
  return out;
}

//过滤
function passesFilters(it) {
  const lvl = mapTag(it.level);
  if (!levelOn[lvl]) return false;
  if (moduleFilter && it.module !== moduleFilter) return false;
  if (textFilter) {
    const text = (it.message || '') + ' ' + (it.module || '');
    if (!text.toLowerCase().includes(textFilter)) return false;
  }
  return true;
}

function isAtBottom(el) {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_NEAR_BOTTOM_PX;
}
function scrollToBottom(el) {
  el.scrollTop = el.scrollHeight;
}

function rerenderAll() {
  const vp = $('log-viewport');
  if (!vp) return;
  const visible = buffer.filter(passesFilters);
  // DOM 限制
  const slice = visible.length > MAX_DOM_ROWS ? visible.slice(-MAX_DOM_ROWS) : visible;
  vp.innerHTML = slice.map((it) => rowHTML(it, textFilter)).join('');
  updateStatusbar(visible.length);
  if (tail) scrollToBottom(vp);
}

function appendNew(items) {
  if (!items.length) return;
  const vp = $('log-viewport');
  if (!vp) return;

  const wasAtBottom = isAtBottom(vp);

  for (const it of items) {
    buffer.push(it);
    if (it.module) knownModules.add(it.module);
  }
  if (buffer.length > MAX_DOM_ROWS * 2) buffer = buffer.slice(-MAX_DOM_ROWS);

  const passed = items.filter(passesFilters);
  if (passed.length) {
    const html = passed.map((it) => rowHTML(it, textFilter)).join('');
    vp.insertAdjacentHTML('beforeend', html);
    while (vp.children.length > MAX_DOM_ROWS) vp.removeChild(vp.firstElementChild);
  }

  if (tail && wasAtBottom) {
    scrollToBottom(vp);
    pendingNew = 0;
  } else {
    pendingNew += passed.length;
  }

  updateStatusbar(undefined);
  refreshModuleDropdown();
}

let pendingNew = 0;

function updateStatusbar(visibleCount) {
  if (visibleCount === undefined) {
    visibleCount = buffer.filter(passesFilters).length;
  }
  const shown = Math.min(visibleCount, MAX_DOM_ROWS);
  $('log-shown') && ($('log-shown').textContent = String(shown));
  $('log-buf')   && ($('log-buf').textContent   = String(buffer.length));
  $('log-total') && ($('log-total').textContent = String(buffer.length));

  const pausedTip = $('log-paused-tip');
  if (pausedTip) {
    if (!tail && pendingNew > 0) {
      pausedTip.hidden = false;
      $('log-pending').textContent = String(pendingNew);
    } else {
      pausedTip.hidden = true;
    }
  }

  if (buffer.length && $('log-last-time')) {
    $('log-last-time').textContent = buffer[buffer.length - 1].time;
  }
}

function refreshModuleDropdown() {
  const sel = $('log-module');
  if (!sel) return;
  const current = sel.value;
  const have = new Set(Array.from(sel.options).map((o) => o.value));
  for (const m of knownModules) {
    if (!have.has(m)) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      sel.appendChild(opt);
    }
  }
  if (current) sel.value = current;
}

//数据拉取
async function fetchInitial() {
  const data = await api.logs(500);
  if (!data) return;
  const items = Array.isArray(data) ? data : (data.items || []);
  buffer = items.slice();
  lastId = (data && data.last_id) || (items.length ? items[items.length - 1].id || 0 : 0);
  items.forEach((it) => it.module && knownModules.add(it.module));
  refreshModuleDropdown();
  rerenderAll();
}

async function fetchIncremental() {
  if (lastId == null) return;
  const data = await api.logsSince(lastId, 500);
  if (!data) return;
  const items = Array.isArray(data) ? data : (data.items || []);
  if (data && data.last_id) lastId = data.last_id;
  else if (items.length) lastId = items[items.length - 1].id || lastId;
  if (items.length) appendNew(items);
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(fetchIncremental, POLL_INTERVAL_MS);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function bindOnce() {
  if (bootstrapped) return;
  bootstrapped = true;

  //搜索
  let debounce;
  $('log-filter')?.addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      textFilter = e.target.value.trim().toLowerCase();
      rerenderAll();
    }, 100);
  });

  $('log-module')?.addEventListener('change', (e) => {
    moduleFilter = e.target.value;
    rerenderAll();
  });

  document.querySelectorAll('#log-levels .level-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.level;
      levelOn[k] = !levelOn[k];
      btn.classList.toggle('active', levelOn[k]);
      rerenderAll();
    });
  });

  //下载
  $('log-download')?.addEventListener('click', () => {
    const lines = buffer.filter(passesFilters).map(
      (it) => `[${it.datetime || it.time}] [${(it.level || '').toUpperCase()}] [${it.module || '-'}] ${it.message}`
    );
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `neobot-${stamp}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  $('log-clear')?.addEventListener('click', () => {
    const vp = $('log-viewport');
    if (vp) vp.innerHTML = '';
    buffer = [];
    pendingNew = 0;
    updateStatusbar(0);
  });

  const vp = $('log-viewport');
  vp?.addEventListener('scroll', () => {
    const bottom = isAtBottom(vp);
    if (bottom) {
      tail = true;
      pendingNew = 0;
      updateStatusbar(undefined);
    } else {
      tail = false;
    }
  });

  $('log-resume')?.addEventListener('click', (e) => {
    e.preventDefault();
    tail = true;
    pendingNew = 0;
    scrollToBottom(vp);
    updateStatusbar(undefined);
  });
}

//入口
export async function setupLogsPage() {
  bindOnce();
}

export async function enterLogsPage() {
  await fetchInitial();
  startPolling();
}

export function leaveLogsPage() {
  stopPolling();
}
