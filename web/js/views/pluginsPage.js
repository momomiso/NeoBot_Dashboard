//pluginsPage.js
//插件管理
import { api } from '../api.js';
import { $, escapeHTML, authFetch } from '../utils.js';
import { toast } from '../ui/toast.js';

let rawList = [];
let filter = '';
let sortKey = 'name';
let manageAllowed = false;
let manageDisabledReason = '';

function fmtSize(b) {
  if (!b || b < 0) return '—';
  const u = ['B','KB','MB','GB']; let v = b, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const KIND_LABEL = { 'package': '目录', 'single-file': '单文件', 'module': '模块' };
const STATUS_LABEL = { loaded: '已加载', error: '异常', disabled: '已禁用' };

const PUZZLE_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
       stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 4a2 2 0 1 0-4 0v2H6a2 2 0 0 0-2 2v4h2a2 2 0 1 1 0 4H4v4a2 2 0 0 0 2 2h4v-2a2 2 0 1 1 4 0v2h4a2 2 0 0 0 2-2v-4h-2a2 2 0 1 1 0-4h2V8a2 2 0 0 0-2-2h-4z"/>
  </svg>`;

function transform(list) {
  let out = list.slice();
  if (filter) {
    out = out.filter((p) =>
      (p.name || '').toLowerCase().includes(filter) ||
      (p.author || '').toLowerCase().includes(filter) ||
      (p.path || '').toLowerCase().includes(filter)
    );
  }
  if (sortKey === 'name')       out.sort((a, b) => (a.name||'').localeCompare(b.name||''));
  else if (sortKey === 'mtime') out.sort((a, b) => (b.mtime||0) - (a.mtime||0));
  else if (sortKey === 'size')  out.sort((a, b) => (b.size_bytes||0) - (a.size_bytes||0));
  return out;
}

function versionBadge(p) {
  // 没repo字段,没法检查更新,不显示
  if (!p.repo) return '';
  const us = p.update_status || 'unknown';
  //没拉到远程版本(还没点过"检查更新"或拉取失败)不显示
  if (us === 'unknown') return '';
  const labels = {
    latest: '最新',
    available: `可更新 → ${escapeHTML(p.remote_version || '')}`,
    ahead: '本地更新',
  };
  return `<span class="ver-tag ${us}" data-update="${us}">${labels[us] || ''}</span>`;
}

function renderRow(p) {
  const status = p.status || 'loaded';
  const enabled = status !== 'disabled';
  const isSelfDashboard = p.name === 'dashboard';
  const canManage = manageAllowed && p.manageable;
  const canOperate = manageAllowed && (p.manageable || isSelfDashboard);
  const desc = p.description
    ? `<div class="plg-desc" title="${escapeHTML(p.description)}">${escapeHTML(p.description)}</div>`
    : `<div class="plg-desc empty">(无描述)</div>`;
  const auth = p.author ? `<div class="plg-author">by ${escapeHTML(p.author)}</div>` : '';

  const toggleHTML = `
    <label class="toggle" title="${enabled ? '已启用,点击禁用' : '已禁用,点击启用'}">
      <input type="checkbox" data-toggle="${escapeHTML(p.name)}"
             ${enabled ? 'checked' : ''} ${canManage ? '' : 'disabled'}/>
      <span class="slider"></span>
    </label>
  `;

  const canUpdate = p.repo && p.update_status === 'available';
  const updateBtn = p.repo
    ? `<button data-act="update" data-name="${escapeHTML(p.name)}" ${canUpdate ? '' : 'disabled'}>
         ${canUpdate ? '更新到最新版' : '已是最新版'}
       </button>`
    : `<button disabled title="plugin.toml 未声明 repo,无法自动更新">更新</button>`;
  const actionsHTML = `
    <div class="actions-menu">
      <button class="actions-trigger" data-name="${escapeHTML(p.name)}"
              ${canOperate ? '' : 'disabled'}>配置 ▾</button>
    </div>
  `;
  p._actionsHTML = `
    ${updateBtn}
    <button data-act="open-toml" data-name="${escapeHTML(p.name)}">查看 plugin.toml</button>
    ${p.repo ? `<button data-act="open-repo" data-name="${escapeHTML(p.name)}">打开仓库</button>` : ''}
    <hr/>
    <button class="danger" data-act="uninstall" data-name="${escapeHTML(p.name)}">卸载</button>
  `;

  return `
    <tr data-row="${escapeHTML(p.name)}">
      <td><div class="plg-icon">${PUZZLE_ICON}</div></td>
      <td>
        <div class="plg-name">${escapeHTML(p.name)}</div>
        <div class="plg-path">${escapeHTML(p.path)}</div>
      </td>
      <td>
        <span class="plg-version">${escapeHTML(p.version || '—')}</span>
        ${versionBadge(p)}
      </td>
      <td><span class="badge kind-${escapeHTML(p.kind || 'module')}">${escapeHTML(KIND_LABEL[p.kind] || p.kind || '')}</span></td>
      <td><span class="badge status-${escapeHTML(status)}">${escapeHTML(STATUS_LABEL[status] || status)}</span></td>
      <td>${desc}${auth}</td>
      <td>${toggleHTML}</td>
      <td>${actionsHTML}</td>
      <td><span class="plg-size">${escapeHTML(fmtSize(p.size_bytes))}</span></td>
      <td><span class="plg-time">${escapeHTML(fmtTime(p.mtime))}</span></td>
    </tr>
  `;
}

function renderTable() {
  const list = transform(rawList);
  const tbody = $('plg-tbody');
  if (!tbody) return;
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="plg-empty">${rawList.length ? '没有匹配的插件' : '插件目录为空'}</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(renderRow).join('');
  for (const p of list) {
    const row = tbody.querySelector(`tr[data-row="${CSS.escape(p.name)}"]`);
    if (row) row.dataset.actionsHtml = p._actionsHTML;
  }
}

function renderSummary() {
  const total = rawList.length;
  const loaded   = rawList.filter((p) => p.status === 'loaded').length;
  const errored  = rawList.filter((p) => p.status === 'error').length;
  const withToml = rawList.filter((p) => p.has_manifest).length;
  $('plg-total')     && ($('plg-total').textContent = total);
  $('plg-loaded')    && ($('plg-loaded').textContent = loaded);
  $('plg-error')     && ($('plg-error').textContent = errored);
  $('plg-with-toml') && ($('plg-with-toml').textContent = withToml);
}

export async function fetchAndRender() {
  const data = await api.plugins();
  if (!data) return;
  const list = Array.isArray(data) ? data : (data.items || []);
  const root = (data && data.root) || '';
  rawList = list;
  const rootEl = $('plg-root-path');
  if (rootEl) rootEl.textContent = root || '—';
  manageAllowed = true;
  renderSummary();
  renderTable();
}

//调远端管理API
async function postJSON(path, body) {
  const r = await authFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : null,
  });
  let data;
  try { data = await r.json(); } catch { data = {}; }
  return { ok: r.ok, status: r.status, data };
}

async function actInstall(repo, branch) {
  const { ok, data } = await postJSON('/api/plugins/install', { repo, branch });
  if (ok) toast(data.message || '安装成功', 'ok');
  else toast(data.error || '安装失败', 'err');
  return ok;
}
async function actUninstall(name) {
  if (!confirm(`确认卸载插件 ${name}?\n该操作会删除磁盘上的目录。`)) return;
  const { ok, data } = await postJSON(`/api/plugins/${encodeURIComponent(name)}/uninstall`);
  if (ok) toast(data.message || '已卸载', 'ok');
  else toast(data.error || '卸载失败', 'err');
  await fetchAndRender();
}
async function actToggle(name) {
  const { ok, data } = await postJSON(`/api/plugins/${encodeURIComponent(name)}/toggle`);
  if (ok) toast(data.message || (data.enabled ? '已启用' : '已禁用'), 'ok');
  else { toast(data.error || '操作失败', 'err'); }
  await fetchAndRender();
}
async function actUpdate(name) {
  toast(`正在更新 ${name}…`, 'info');
  const { ok, data } = await postJSON(`/api/plugins/${encodeURIComponent(name)}/update`);
  if (ok) toast(data.message || '更新成功', 'ok');
  else toast(data.error || '更新失败', 'err');
  await fetchAndRender();
}
async function actCheckUpdates() {
  toast('正在检查更新…', 'info');
  const r = await authFetch('/api/plugins/check-updates?force=1');
  if (!r.ok) return toast('检查失败', 'err');
  toast('检查完成', 'ok');
  await fetchAndRender();
}

function openInstallDialog() {
  if (!manageAllowed) {
    toast('插件列表尚未加载完成,稍后再试。', 'warn');
    return;
  }
  const dlg = $('install-dialog');
  if (!dlg) return;
  $('install-repo').value = '';
  $('install-branch').value = 'main';
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

function closeActionsPop() {
  document.querySelectorAll('.actions-pop').forEach((p) => p.remove());
}
function openActionsPop(triggerBtn) {
  closeActionsPop();
  const row = triggerBtn.closest('tr');
  if (!row) return;
  const name = triggerBtn.dataset.name;
  if (!name) return;

  const p = rawList.find((x) => x.name === name);
  if (!p) return;

  const pop = document.createElement('div');
  pop.className = 'actions-pop';
  document.body.appendChild(pop);
  const rect = triggerBtn.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top = `${rect.bottom + 4}px`;
  pop.style.right = `${window.innerWidth - rect.right}px`;
  pop.style.zIndex = '500';

  const addBtn = (label, onClick, opts = {}) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (opts.danger) b.className = 'danger';
    if (opts.disabled) {
      b.disabled = true;
      if (opts.title) b.title = opts.title;
    } else {
      b.onclick = (e) => {
        e.stopPropagation();
        closeActionsPop();
        try { onClick(); } catch (err) { console.error(err); }
      };
    }
    pop.appendChild(b);
    return b;
  };
  const addSeparator = () => {
    const hr = document.createElement('hr');
    pop.appendChild(hr);
  };

  //更新
  if (!p.repo) {
    addBtn('更新', null, { disabled: true, title: 'plugin.toml 未声明 repo' });
  } else if (p.update_status === 'available') {
    addBtn(`更新到 ${p.remote_version || '最新版'}`, () => actUpdate(name));
  } else {
    addBtn('已是最新版', null, { disabled: true });
  }

  //查看plugin.toml
  addBtn('查看 plugin.toml', () => openTomlInBrowser(name));

  //打开GitHub
  if (p.repo) addBtn('打开 GitHub 仓库', () => openRepoInBrowser(name));

  addSeparator();

  //卸载
  if (p.name === 'dashboard') {
    addBtn('不能卸载 dashboard 自身', null, {
      disabled: true,
      title: '请在终端使用命令卸载此插件'
    });
  } else {
    addBtn('卸载', () => actUninstall(name), { danger: true });
  }

  //滚动缩放窗口关闭
  const closeOnScroll = () => closeActionsPop();
  window.addEventListener('scroll', closeOnScroll, { once: true, passive: true });
  window.addEventListener('resize', closeOnScroll, { once: true });

  setTimeout(() => {
    document.addEventListener('click', function once(e) {
      if (!pop.contains(e.target) && e.target !== triggerBtn && !triggerBtn.contains(e.target)) {
        closeActionsPop();
        document.removeEventListener('click', once);
      }
    });
  }, 0);
}

let bootstrapped = false;
export function setupPluginsPage() {
  if (bootstrapped) return;
  bootstrapped = true;

  $('plg-filter')?.addEventListener('input', (e) => {
    filter = e.target.value.trim().toLowerCase();
    renderTable();
  });
  $('plg-sort')?.addEventListener('change', (e) => {
    sortKey = e.target.value;
    renderTable();
  });
  $('plg-refresh')?.addEventListener('click', fetchAndRender);
  $('plg-check')?.addEventListener('click', actCheckUpdates);
  $('plg-install')?.addEventListener('click', openInstallDialog);

  $('plg-tbody')?.addEventListener('click', (e) => {
    const t = e.target;
    const trig = t.closest('.actions-trigger');
    if (trig && !trig.disabled) {
      e.stopPropagation();
      openActionsPop(trig);
      return;
    }
    const act = t.closest('[data-act]');
    if (act) {
      const name = act.dataset.name;
      closeActionsPop();
      switch (act.dataset.act) {
        case 'uninstall':  return actUninstall(name);
        case 'update':     return actUpdate(name);
        case 'open-toml':  return openTomlInBrowser(name);
        case 'open-repo':  return openRepoInBrowser(name);
      }
    }
    const tag = t.closest('.ver-tag.available');
    if (tag) {
      const row = tag.closest('tr');
      const name = row?.dataset.row;
      if (name && confirm(`将插件 ${name} 更新到远程版本?`)) actUpdate(name);
    }
  });

  $('plg-tbody')?.addEventListener('change', (e) => {
    if (e.target.matches('[data-toggle]')) {
      const name = e.target.dataset.toggle;
      actToggle(name);
    }
  });

  const dlg = $('install-dialog');
  if (dlg) {
    dlg.querySelectorAll('[data-close]').forEach((b) =>
      b.addEventListener('click', () => dlg.close()));
    $('install-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const repo = $('install-repo').value.trim();
      const branch = $('install-branch').value.trim() || 'main';
      if (!repo) return;
      $('install-submit').disabled = true;
      $('install-submit').textContent = '下载中…';
      try {
        const ok = await actInstall(repo, branch);
        if (ok) { dlg.close(); await fetchAndRender(); }
      } finally {
        $('install-submit').disabled = false;
        $('install-submit').textContent = '下载并安装';
      }
    });
  }
}

function openTomlInBrowser(name) {
  const path = `app/data/plugins/${name}/plugin.toml`;
  window.prompt('插件配置路径(请在服务器上用文本编辑器修改):', path);
}
function openRepoInBrowser(name) {
  const p = rawList.find((x) => x.name === name);
  if (p && p.repo) {
    const url = p.repo.startsWith('http') ? p.repo : `https://github.com/${p.repo}`;
    window.open(url, '_blank');
  }
}
