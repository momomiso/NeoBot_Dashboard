//bots.js
//机器人列表

import { api } from '../api.js';
import { $, escapeHTML, fmtNum } from '../utils.js';

function fmtLatency(ms) {
  if (ms == null || !isFinite(ms)) return { text: '—', color: '' };
  const n = Math.round(ms);
  let color = 'var(--text)';
  if (n < 200)      color = 'var(--ok, #16a34a)';
  else if (n < 600) color = 'var(--text)';
  else              color = 'var(--err, #dc2626)';
  return { text: `${n} ms`, color };
}

function renderRow(b) {
  const on = b.status === 'on';
  const grad = on
    ? 'linear-gradient(135deg,#22c55e,#16a34a)'
    : 'linear-gradient(135deg,#94a3b8,#64748b)';
  const initial = escapeHTML(b.avatar_initial || 'N');
  const subtitle = b.user_id
    ? `${escapeHTML(b.platform)} · ${escapeHTML(b.user_id)}`
    : escapeHTML(b.platform);
  const lat = fmtLatency(b.latency_ms);

  const ageTitle = (b.latency_age_sec != null)
    ? `测量于 ${b.latency_age_sec} 秒前`
    : '尚未测量';

  const avatarHTML = b.avatar_url
    ? `<img src="${escapeHTML(b.avatar_url)}" alt="${escapeHTML(b.name || 'Bot')}"
            onerror="this.remove(); this.parentElement.textContent='${initial}'">`
    : initial;

  return `
    <div class="bot-row">
      <div class="bot-avatar ${b.avatar_url ? 'has-img' : ''}" style="${b.avatar_url ? '' : `background:${grad};`}">
        ${avatarHTML}
      </div>
      <div class="bot-info">
        <div class="name">${escapeHTML(b.name)}
          <span class="status-pill ${on ? 'on' : 'off'}">
            <span class="dot"></span>${on ? '在线' : '离线'}
          </span>
        </div>
        <div class="platform">${subtitle}</div>
      </div>
      <div class="bot-stat">
        <div class="num">${fmtNum(b.message_count)}</div>
        <div>消息总数</div>
      </div>
      <div class="bot-stat" title="${escapeHTML(ageTitle)}">
        <div class="num" style="color:${lat.color}">${lat.text}</div>
        <div>延迟</div>
      </div>
    </div>
  `;
}

export async function renderBots() {
  const list = await api.bots();
  if (!Array.isArray(list)) return;
  const box = $('bot-list');
  if (!list.length) {
    box.innerHTML =
      '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:12.5px">暂无机器人</div>';
    return;
  }
  box.innerHTML = list.map(renderRow).join('');
}
