//app.js
//应用入口

import { router }            from './router.js';
import { toast }             from './ui/toast.js';
import { renderOverview }    from './views/overview.js';
import { renderSparkline }   from './views/sparkline.js';
import { renderBots }        from './views/bots.js';
import { renderPlugins }     from './views/plugins.js';
import { renderLogs }        from './views/logs.js';
import { renderSystem }      from './views/system.js';
import { setupPluginsPage,
         fetchAndRender as fetchPluginsPage } from './views/pluginsPage.js';
import { setupLogsPage,
         enterLogsPage, leaveLogsPage }       from './views/logsPage.js';
import { enterBotsPage, leaveBotsPage }        from './views/botsPage.js';
import { api }               from './api.js';
import { escapeHTML, mapTag } from './utils.js';

function topbarBtn(title) {
  return Array.from(document.querySelectorAll('.icon-btn')).find(
    (b) => b.getAttribute('title') === title,
  );
}

function setupHotkeys() {
  const searchInput = document.querySelector('.search input');
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      searchInput?.focus();
    }
    if (e.key === 'Escape') closeAllPopovers();
  });
}

function setupRefreshButton() {
  const btn = topbarBtn('刷新');
  if (!btn) return;
  const svg = btn.querySelector('svg');
  btn.addEventListener('click', async () => {
    if (svg) svg.classList.add('spinning');
    try {
      await refreshCurrentPage();
      toast('已刷新', 'ok', 1500);
    } catch (e) {
      console.error('refresh failed', e);
      toast('刷新失败:' + (e?.message || e), 'err');
    } finally {
      setTimeout(() => svg && svg.classList.remove('spinning'), 600);
    }
  });
}

const THEME_KEY = 'neobot-dashboard-theme';
const SUN_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
       stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="4"/>
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
  </svg>`;
const MOON_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
       stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
  </svg>`;

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.body.dataset.theme = theme;
  const btn = topbarBtn('主题');
  if (btn) btn.innerHTML = theme === 'dark' ? SUN_SVG : MOON_SVG;
}

function setupTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
  topbarBtn('主题')?.addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || 'light';
    const next = cur === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
}

function closeAllPopovers() {
  document.querySelectorAll('.popover').forEach((p) => p.remove());
}
async function showNotificationsPopover(anchor) {
  closeAllPopovers();
  const data = await api.logs(200);
  const raw = Array.isArray(data) ? data : (data && data.items) || [];
  const alerts = raw
    .slice().reverse()  // 新在前
    .filter((it) => ['warning', 'error', 'critical'].includes(String(it.level || '').toLowerCase()))
    .slice(0, 12);
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.innerHTML = `
    <div class="popover-header">
      <span>近期告警 · ${alerts.length} 条</span>
      <button class="popover-close" aria-label="关闭">&times;</button>
    </div>
    <div class="popover-body">
      ${alerts.length === 0
        ? `<div class="popover-empty">暂无告警 🎉</div>`
        : alerts.map((it) => `
            <div class="popover-item">
              <span class="tag ${mapTag(it.level)}">${escapeHTML(it.level)}</span>
              <div class="popover-item-body">
                <div class="popover-item-msg">${escapeHTML(it.message)}</div>
                <div class="popover-item-meta">${escapeHTML(it.time)} · ${escapeHTML(it.module)}</div>
              </div>
            </div>`).join('')}
    </div>`;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${r.bottom + 8 + window.scrollY}px`;
  pop.style.right = `${window.innerWidth - r.right}px`;
  pop.querySelector('.popover-close')?.addEventListener('click', closeAllPopovers);
  setTimeout(() => {
    document.addEventListener('click', function onDocClick(e) {
      if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) {
        closeAllPopovers();
        document.removeEventListener('click', onDocClick);
      }
    });
  }, 0);
}
function setupNotifications() {
  topbarBtn('通知')?.addEventListener('click', (e) => {
    e.stopPropagation();
    showNotificationsPopover(topbarBtn('通知'));
  });
}

function setupSearch() {
  const input = document.querySelector('.search input');
  if (!input) return;
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const kw = input.value.trim().toLowerCase();
    if (!kw) {
      await Promise.all([renderPlugins(), renderLogs()]);
      return;
    }
    const box = document.getElementById('plugin-grid');
    box && Array.from(box.children).forEach((chip) => {
      const name = chip.querySelector('.pname')?.textContent?.toLowerCase() || '';
      chip.style.display = name.includes(kw) ? '' : 'none';
    });
    const logBox = document.getElementById('log-list');
    logBox && Array.from(logBox.children).forEach((row) => {
      const text = row.textContent?.toLowerCase() || '';
      row.style.display = text.includes(kw) ? '' : 'none';
    });
  });
}

async function refreshDashboard() {
  await Promise.all([
    renderOverview(), renderBots(), renderPlugins(), renderLogs(), renderSystem(),
    renderSparkline(),
  ]);
}

async function refreshCurrentPage() {
  switch (router.current()) {
    case 'dashboard': return refreshDashboard();
    case 'plugins':   return fetchPluginsPage();
    case 'bots':      return enterBotsPage();
    case 'logs':      return enterLogsPage();
    default:          return;
  }
}

function startPolling() {
  setInterval(() => {
    if (router.current() !== 'dashboard') return;
    renderLogs(); renderSystem();
  }, 3000);
  setInterval(() => {
    if (router.current() !== 'dashboard') return;
    renderOverview(); renderBots(); renderPlugins();
  }, 10000);
  setInterval(() => {
    if (router.current() !== 'plugins') return;
    fetchPluginsPage();
  }, 20000);
}

function main() {
  setupHotkeys();
  setupTheme();
  setupRefreshButton();
  setupNotifications();
  setupSearch();
  setupPluginsPage();
  setupLogsPage();

  let prevRoute = null;
  router.on((route) => {
    if (prevRoute === 'logs' && route !== 'logs') leaveLogsPage();
    if (prevRoute === 'bots' && route !== 'bots') leaveBotsPage();
    if (route === 'dashboard')  refreshDashboard();
    else if (route === 'plugins') fetchPluginsPage();
    else if (route === 'logs')    enterLogsPage();
    else if (route === 'bots')    enterBotsPage();
    prevRoute = route;
  });

  router.init();
  startPolling();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
