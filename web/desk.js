// The screen badge: a worker is using this PC's mouse and keyboard, and this is how
// the operator takes it back.
//
// The permission lasts the run, not one command, so the badge has to be reachable at
// any moment — it is the only way out short of stopping the run.
import { state } from './state.js';
import { esc } from './format.js';
import { $ } from './dom.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { roleLabel } from './run-view.js';

/**
 * The screen lease badge: who has the operator's mouse, keyboard and focus.
 *
 * Shown from the server's answer, not from an event, so a page opened mid-lease
 * or a stream that dropped still tells the truth. Take Back is the one control:
 * the work keeps running, it just cannot take the screen again without asking.
 */
export function renderDesk() {
  const badge = $('deskBadge');
  if (!badge) return;
  const desk = state.desk;
  if (!desk) {
    badge.hidden = true;
    return;
  }
  const who = [desk.role ? roleLabel(desk.role) : '', desk.task || ''].filter(Boolean).join(' · ');
  const project = String(desk.dir || '').split(/[\\/]/).filter(Boolean).pop() || '';
  $('deskBadgeTitle').textContent = 'Screen in use';
  $('deskBadgeWho').textContent = `${who || 'A worker'} may use your mouse and keyboard${project ? ` (${project})` : ''}.`;
  badge.hidden = false;
}

export async function takeBackScreen() {
  try {
    await api('POST', '/api/desk/release', { why: 'the operator took it back' });
  } catch (err) {
    toast('Could Not Take the Screen Back', err.message);
    return;
  }
  state.desk = null;
  renderDesk();
  toast('Screen Taken Back', 'The AI cannot take your mouse or keyboard again without asking.');
}
