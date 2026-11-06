// Single or Multi, and the waits the automation obeys.
//
// Single keeps every tool but denies delegation, so the Architect answers everything
// itself in one chat. A dedicated agent for this is the obvious design and it fails:
// the free tier rejects every request from a custom agent with a provider auth error
// (measured). A permission ruleset on an ordinary session works, and — unlike denying
// everything — leaves the tools usable.
//
// Nothing comes from app.js: the mode is state, and the waits are config.
import { state } from './state.js';
import { $ } from './dom.js';
import { architectSelection } from './run-view.js';
import { settleChatBox } from './chat-geometry.js';
import { renderKeep } from './run-menu.js';

// Single mode keeps every tool but denies delegation, so the Architect answers
// everything itself in one chat. A dedicated agent for this is the obvious
// design and it fails: the free tier rejects every request from a custom agent
// with a provider auth error (measured). A permission ruleset on an ordinary
// session works, and — unlike denying everything — leaves the tools usable.
export const SINGLE_PERMISSIONS = [{ action: 'subagent', resource: '*', effect: 'deny' }];
export const sessionMode = (s) => (s?.single ? 'single' : 'multi');

/**
 * A wait from Settings → Automation, in seconds. 0 is real: the harness acts at
 * once. The menu, the cards and the shutdown note say the number that is
 * actually set rather than a stale "20".
 */
export function automationWaitSec(key, fallback) {
  const raw = state.config?.automation?.[key];
  const n = raw === undefined || raw === null || raw === '' ? fallback : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export const answerWaitSec = () => automationWaitSec('answerSec', 30);

export function chatBody(projectId) {
  const body = { projectId, permissions: SINGLE_PERMISSIONS };
  const model = architectSelection();
  if (model) body.model = model;
  return body;
}

export function renderMode() {
  const btn = $('modeToggle');
  const label = $('modeLabel');
  if (!btn || !label) return;
  const single = state.mode === 'single';
  label.textContent = single ? 'Single' : 'Multi';
  btn.classList.toggle('is-single', single);
  btn.setAttribute('aria-pressed', String(single));
  const busy = Boolean(state.busyInfo?.busy) || state.compacting;
  btn.disabled = busy;
  btn.title = busy
    ? 'Switch modes when the project is idle — work is happening now.'
    : single
    ? 'Single: one Architect, all the tools, no delegation — it answers everything itself. Click for Multi.'
    : 'Multi: the Architect can delegate to subagents and the role cards are shown. Click for Single.';
  const input = $('promptInput');
  if (input) input.placeholder = single ? 'Message' : 'Message the Architect…';
  document.body.dataset.mode = state.mode;
  renderKeep();
  // The keep-building flag only exists in Multi, so switching modes changes the
  // composer row's height — and with it the room the transcript has, without the
  // dock's own height changing. That is a change only the transcript can see, so
  // it settles it here rather than a frame later.
  settleChatBox();
}
