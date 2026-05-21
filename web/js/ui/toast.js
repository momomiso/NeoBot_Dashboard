// js/ui/toast.js —— 简易 toast 通知

const CONTAINER_ID = 'toasts';

function getContainer() {
  let el = document.getElementById(CONTAINER_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = CONTAINER_ID;
    el.className = 'toasts';
    document.body.appendChild(el);
  }
  return el;
}

/**
 * 弹一个 toast。
 * @param {string} text
 * @param {'info'|'ok'|'warn'|'err'} kind
 * @param {number} duration ms
 */
export function toast(text, kind = 'info', duration = 4000) {
  const c = getContainer();
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="dismiss">×</span>${text}`;
  el.querySelector('.dismiss').addEventListener('click', () => el.remove());
  c.appendChild(el);
  if (duration > 0) {
    setTimeout(() => {
      el.style.transition = 'opacity .2s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 200);
    }, duration);
  }
  return el;
}
