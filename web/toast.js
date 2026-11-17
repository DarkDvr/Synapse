// One line of news in the corner: what happened, and a sentence about it.
//
// Every part of the page says things this way — saved, refused, stopped, missing —
// so it is a module rather than a function in app.js: the composer, the settings
// panes and the provider editor all need it, and none of them should have to be
// wired to app.js for it.
//
// A notice is not a modal and must not become one: it leaves on its own, and a
// second notice stacks under the first. It does not leave while the pointer is on
// it — the operator is reading, and a line that vanishes mid-sentence has to be
// brought back by repeating the action that produced it.
import { esc } from './format.js';
import { $ } from './dom.js';

/** How long a notice stays, in milliseconds, unless the caller says otherwise.
 *  Five seconds is long enough to read two lines and short enough not to sit over
 *  the chat; hovering pauses it (see below). */
export const TOAST_MS = 5200;

// ── toast ───────────────────────────────────────────────────────
export function toast(title, body, ms = TOAST_MS) {
  const region = $('toastRegion');
  if (!region) return null;
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="toast-icon">◈</span><div><strong>${esc(title)}</strong>${body ? `<p>${esc(body)}</p>` : ''}</div>`;
  region.appendChild(el);

  // The countdown starts when the notice appears and stops while it is hovered.
  // `remaining` is what is left, so a hover at 4.9s and a hover at 0.1s behave
  // differently — the first leaves almost at once, the second stays a while.
  let remaining = Math.max(800, Number(ms) || TOAST_MS);
  let timer = null;
  let started = 0;
  const leave = () => el.remove();
  const arm = () => {
    started = Date.now();
    timer = setTimeout(leave, remaining);
  };
  const pause = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    remaining = Math.max(400, remaining - (Date.now() - started));
  };
  const resume = () => {
    if (timer || !el.isConnected) return;
    arm();
  };
  el.addEventListener('mouseenter', pause);
  el.addEventListener('mouseleave', resume);
  arm();
  return el;
}
