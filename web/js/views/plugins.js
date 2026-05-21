//plugins.js
//插件

import { api } from '../api.js';
import { $, escapeHTML } from '../utils.js';

const PUZZLE_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
       stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 4a2 2 0 1 0-4 0v2H6a2 2 0 0 0-2 2v4h2a2 2 0 1 1 0 4H4v4a2 2 0 0 0 2 2h4v-2a2 2 0 1 1 4 0v2h4a2 2 0 0 0 2-2v-4h-2a2 2 0 1 1 0-4h2V8a2 2 0 0 0-2-2h-4z"/>
  </svg>
`;

function renderChip(p) {
  const off = p.status !== 'loaded';
  return `
    <div class="plugin-chip ${off ? 'off' : ''}">
      <div class="pi">${PUZZLE_ICON}</div>
      <div>
        <div class="pname">${escapeHTML(p.name)}</div>
        <div class="pver">${escapeHTML(p.version || '—')}</div>
      </div>
      <span class="pdot"></span>
    </div>
  `;
}

export async function renderPlugins() {
  const box = $('plugin-grid');
  if (!box) return;
  let data;
  try {
    data = await api.plugins();
  } catch (e) {
    console.error('[plugins chip] api.plugins() threw:', e);
    box.innerHTML = `<div style="padding:16px;color:var(--err);font-size:12.5px">加载失败:${e.message || e}</div>`;
    return;
  }
  if (data == null) {
    box.innerHTML =
      '<div style="padding:16px;color:var(--err);font-size:12.5px">加载失败,请打开 F12 → Console 查看具体错误</div>';
    return;
  }
  const list = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);
  if (!list.length) {
    box.innerHTML =
      '<div style="padding:16px;color:var(--text-muted);font-size:12.5px">暂无插件</div>';
    return;
  }
  box.innerHTML = list.map(renderChip).join('');
}
