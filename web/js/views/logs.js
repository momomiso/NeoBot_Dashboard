//logs.js
//日志

import { api } from '../api.js';
import { $, escapeHTML, mapTag } from '../utils.js';

function renderRow(it) {
  return `
    <div class="log-row">
      <span class="time">${escapeHTML(it.time)}</span>
      <span class="tag ${mapTag(it.level)}">${escapeHTML(it.level)}</span>
      <span class="msg">
        <span class="hl">[${escapeHTML(it.module)}]</span>
        ${escapeHTML(it.message)}
      </span>
    </div>
  `;
}

export async function renderLogs() {
  const data = await api.logs(80);
  const list = Array.isArray(data) ? data : (data && data.items) || [];
  const box = $('log-list');
  if (!box) return;
  if (!list.length) {
    box.innerHTML =
      '<div style="padding:12px;color:var(--text-muted);font-size:12px">暂无日志</div>';
    return;
  }

  const ordered = list.slice().reverse();
  box.innerHTML = ordered.map(renderRow).join('');
}
