// One line of news in the corner: what happened, and a sentence about it.
//
// Every part of the page says things this way — saved, refused, stopped, missing —
// so it is a module rather than a function in app.js: the composer, the settings
// panes and the provider editor all need it, and none of them should have to be
// wired to app.js for it.
import { esc } from './format.js';
import { $ } from './dom.js';

// ── toast ───────────────────────────────────────────────────────
export function toast(title, body, ms = 4200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="toast-icon">◈</span><div><strong>${esc(title)}</strong>${body ? `<p>${esc(body)}</p>` : ''}</div>`;
  $('toastRegion').appendChild(el);
  setTimeout(() => el.remove(), ms);
}
