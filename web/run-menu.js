// The cog between Stop and Send: the standing decisions a run makes for you.
//
// Four switches, one each, because the two they replaced had to be moved together —
// an operator who wanted questions answered also got every permission allowed. The
// waits are not here: they are one global set in Settings → Automation, and a row
// only names the one it obeys.
//
// Nothing comes from app.js: this is a menu over the config and the state.
import { state } from './state.js';
import { esc } from './format.js';
import { $ } from './dom.js';
import { api } from './api.js';
import { automationWaitSec } from './mode.js';
import { toast } from './toast.js';
import { anyAutomationOn, AUTOMATION_ROWS, AUTOMATION_DEFAULTS } from './automation.js';
import { findSession } from './projects.js';
import { renderTranscript } from './transcript.js';

/**
 * The automation switches, behind the cog between Stop and Send.
 *
 * Four rows now, one switch each, because the two they replaced had to be moved
 * together: an operator who wanted questions answered also got every permission
 * allowed. The cog is quiet gray with a clear gear, yellow on hover or while the
 * menu is open, and green while any switch is on, so the composer says a standing
 * decision is in force without a second control on the row.
 *
 * The waits are not here: they are one global set in Settings → Automation, and
 * the rows only name the one they obey.
 */
export function renderKeep() {
  const btn = $('runBtn');
  if (!btn) return;
  btn.hidden = state.view !== 'session' || !state.sessionId;
  // Green while any switch is on — a standing decision the operator can see
  // without opening the menu. All off: gray.
  const awake = state.config?.automation?.keepAwake === true;
  btn.classList.toggle('is-on', anyAutomationOn(state.automation) || awake);
  const on = AUTOMATION_ROWS.filter((row) => state.automation?.[row.key] === true).map((row) => row.label);
  if (awake) on.push('Keep PC Awake');
  btn.title = on.length ? `Automation: ${on.join(', ')}` : 'Automation — four switches, all off';
  for (const row of AUTOMATION_ROWS) {
    const el = $(row.id || `run_${row.key}`);
    if (!el) continue;
    el.setAttribute('aria-checked', String(state.automation?.[row.key] === true));
    const hint = el.querySelector('small');
    if (hint) hint.textContent = row.hint;
  }
  const powerRow = $('run_keepAwake');
  if (powerRow) {
    powerRow.setAttribute('aria-checked', String(awake));
    const hint = powerRow.querySelector('small');
    if (hint) {
      hint.textContent = awake && state.config?.automation?.keepDisplay === true
        ? 'Holding Windows awake, monitor included — Settings decides that half'
        : 'Stop Windows sleeping — Settings decides whether the monitor stays on';
    }
  }
}

export function closeRunMenu() {
  const menu = $('runMenu');
  const btn = $('runBtn');
  if (menu) {
    menu.hidden = true;
    // The menu is positioned fixed while open (so the dock's `overflow: hidden`
    // cannot clip it); the next open measures afresh.
    menu.style.position = '';
    menu.style.left = '';
    menu.style.top = '';
    menu.style.right = '';
    menu.style.bottom = '';
  }
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

/** Place the open menu above the cog, in viewport coordinates. Fixed, not
 *  absolute: the chat dock clips its children, and a short window put the menu
 *  above the dock's top edge and out of sight (28 Oct). If there is no room
 *  above, it opens below instead of past the top of the window. */
export function positionRunMenu() {
  const menu = $('runMenu');
  const btn = $('runBtn');
  if (!menu || !btn || menu.hidden) return;
  const b = btn.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const left = Math.min(Math.max(8, b.right - w), window.innerWidth - w - 8);
  const above = b.top - h - 8;
  const top = above >= 8 ? above : Math.min(b.bottom + 8, window.innerHeight - h - 8);
  menu.style.position = 'fixed';
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(Math.max(8, top))}px`;
  menu.style.right = 'auto';
  menu.style.bottom = 'auto';
}

export function toggleRunMenu() {
  const menu = $('runMenu');
  const btn = $('runBtn');
  if (!menu || !btn) return;
  const open = menu.hidden;
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (open) {
    positionRunMenu();
    $('run_keepBuilding')?.focus();
  }
}

/**
 * Toggle the machine's wake lock from the cog.
 *
 * The answer is the config's `automation.keepAwake`, not a per-project switch: the
 * PC is one PC. Settings > Automation owns the amplified half (the monitor), and
 * the server applies both now — no restart.
 */
export async function togglePower() {
  const next = !(state.config?.automation?.keepAwake === true);
  try {
    const res = await api('POST', '/api/power', { awake: next });
    state.config = {
      ...(state.config || {}),
      automation: { ...(state.config?.automation || {}), ...(res.automation || {}) },
    };
    state.power = res.power || state.power;
    renderKeep();
    toast(
      next ? 'PC Kept Awake' : 'Wake Lock Released',
      next
        ? state.config?.automation?.keepDisplay === true
          ? 'Windows will not sleep, and the monitor stays on (Settings > Automation).'
          : 'Windows will not sleep or hibernate until you release it.'
        : 'Windows may sleep again.',
    );
  } catch (err) {
    toast('Could Not Keep The PC Awake', err.message);
  }
}

/**
 * Toggle one of the four switches for the open project.
 *
 * The server answers with the whole set, so the page never guesses what moved —
 * and the answer is written back onto the session in the rail, so opening another
 * project and coming back shows the same four.
 */
export async function setAutomationSwitch(key, next) {
  const row = AUTOMATION_ROWS.find((r) => r.key === key);
  if (!state.sessionId || !row) return;
  try {
    const r = await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/automation`, {
      patch: { [key]: next === true },
    });
    state.automation = { ...AUTOMATION_DEFAULTS, ...(r.automation || {}) };
    const session = findSession(state.sessionId);
    if (session) session.automation = state.automation;
    renderKeep();
    renderTranscript();
    const on = state.automation[key] === true;
    toast(`${row.label} ${on ? 'On' : 'Off'}`, on ? row.on : row.off);
  } catch (err) {
    toast(`Could Not Change ${row.label}`, err.message);
  }
}

/**
 * A chat is born in Single mode: one Architect, every tool, delegation denied.
 * The mode is applied to each message at send, so nothing about it has to be
 * decided at creation time.
 */
