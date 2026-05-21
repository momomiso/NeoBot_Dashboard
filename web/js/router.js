//router.js
//hash路由

const ROUTES = ['dashboard', 'plugins', 'bots', 'logs'];
const DEFAULT_ROUTE = 'dashboard';

const listeners = new Set();

function currentRoute() {
  const hash = (location.hash || '').replace(/^#\/?/, '');
  return ROUTES.includes(hash) ? hash : DEFAULT_ROUTE;
}

function applyRoute(route) {

  document.querySelectorAll('.page').forEach((el) => {
    el.classList.toggle('active', el.dataset.page === route);
  });

  document.querySelectorAll('.nav .nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.route === route);
  });

  const labelMap = { dashboard: '仪表盘', plugins: '插件', bots: '机器人', logs: '日志' };
  const crumb = document.querySelector('.crumbs .current');
  if (crumb) crumb.textContent = labelMap[route] || route;

  listeners.forEach((fn) => {
    try { fn(route); } catch (e) { console.error('[router] listener error:', e); }
  });
}

export const router = {
  //监听路由变化
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  //跳转
  go(route) {
    if (!ROUTES.includes(route)) return;
    if (currentRoute() === route) {
      applyRoute(route);
      return;
    }
    location.hash = `#/${route}`;
  },

  //取当前路由名
  current: currentRoute,

  init() {
    window.addEventListener('hashchange', () => applyRoute(currentRoute()));
    document.querySelectorAll('.nav .nav-item[data-route]').forEach((btn) => {
      btn.addEventListener('click', () => this.go(btn.dataset.route));
    });
    applyRoute(currentRoute());
  },
};
