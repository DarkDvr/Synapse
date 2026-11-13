// The stopwatches: one per role card, one for the session, on a single interval.
//
// They are persisted per chat in localStorage, because a stopwatch that resets when
// the page reloads is a stopwatch that lies about how long a turn took. One interval
// for all of them: HH:MM:SS needs a second's resolution, and a text node per tick
// costs nothing measurable.
//
// One thing comes from app.js: the status line's "last event" age, which shares the
// tick.
import { state } from './state.js';
import { $ } from './dom.js';
import { hhmmss } from './format.js';
import { currentRun } from './run-view.js';
import { isBusy } from './projects.js';
import { paintRates } from './rate-view.js';

const missing = (name) => () => {
  throw new Error(`clocks.js: ${name} was not wired at boot`);
};
const wired = { renderLastEventAge: missing('renderLastEventAge') };

/** Hand this module the one thing that lives in app.js. Called once, at boot. */
export function clocksWiring(fns) {
  Object.assign(wired, fns);
}

// ── clocks ──────────────────────────────────────────────────────
// Three stopwatches: how long a card has been working right now, how long that
// role has worked in total this session, and how much wall time the session has
// spent working at all. Two of them are display-only.
//
// Deliberately client-side and derived from what is already on screen — a live
// run for a worker, the open turn for the Architect — because the server has no
// opinion about "working" that the cards do not already show. Totals are kept in
// localStorage per session, so a reload restores them; the current interval is
// restarted from now on load, since time spent with the page closed is not time
// we can honestly claim to have measured.

export const clockKey = (id) => `synapse.clocks.${id}`;

export function loadClocks(sessionId) {
  const c = { sessionId: sessionId || null, session: { ms: 0, since: null }, roles: {}, ticks: 0 };
  if (!sessionId) return c;
  try {
    const raw = JSON.parse(localStorage.getItem(clockKey(sessionId)) || 'null');
    if (raw && typeof raw === 'object') {
      c.session.ms = Math.max(0, Number(raw.session?.ms) || 0);
      for (const [role, v] of Object.entries(raw.roles || {})) {
        c.roles[role] = {
          ms: Math.max(0, Number(v?.ms) || 0),
          since: null,
          last: Math.max(0, Number(v?.last) || 0),
        };
      }
    }
  } catch { /* a corrupt stopwatch is not worth an error */ }
  return c;
}

function saveClocks() {
  const c = state.clocks;
  if (!c?.sessionId) return;
  try {
    const roles = {};
    for (const [role, v] of Object.entries(c.roles)) roles[role] = { ms: v.ms, last: v.last };
    localStorage.setItem(clockKey(c.sessionId), JSON.stringify({ session: { ms: c.session.ms }, roles }));
  } catch { /* full or blocked storage must not break a turn */ }
}

/** Is this card doing work right now? The same reading its dot uses. */
export function roleIsWorking(role) {
  const run = currentRun();
  const form = (state.forms || [])[0];
  const perm = (state.permissions || [])[0];
  if (role === 'architect') {
    // Waiting on the operator is not work, and neither is waiting on a worker —
    // the worker's own card is the one that should be counting.
    if (form && form.sessionId === state.sessionId) return false;
    if (perm && perm.sessionId === state.sessionId) return false;
    if (run) return false;
    return isBusy(state.sessionId);
  }
  if (!run || run.role !== role) return false;
  // A worker stopped on a question is waiting, exactly as its card says.
  return !(form && form.sessionId && form.sessionId !== state.sessionId);
}

/**
 * Advance one role's stopwatch, whether or not its card is on screen.
 *
 * The clock used to be driven by the cards in the DOM, so switching to another project
 * stopped it: the reading belonged to a chat that was no longer displayed, and the time
 * spent looking elsewhere was lost (12 Nov). Now the reading is tied to the *session*:
 * it stops only when that session stops working, and a visit to another chat leaves it
 * alone — the card shows the full time when you come back.
 *
 * Pure, so the rule can be tested without a page.
 */
export function advanceClock(rec, { sessionId = null, busy = false, busySince = null, now = Date.now() } = {}) {
  let changed = false;
  if (busy) {
    // Start where the session became busy, not when this page noticed: a turn that began
    // before the page was opened still reads its true length.
    if (!rec.since) { rec.since = Number(busySince) || now; changed = true; }
    if (rec.sessionId !== sessionId) { rec.sessionId = sessionId; changed = true; }
    return changed;
  }
  // Not busy for the chat on screen. If the open reading belongs to another chat, leave
  // it: that chat may be working while we look elsewhere.
  if (rec.since && rec.sessionId === sessionId) {
    rec.last = Math.max(0, now - rec.since);
    rec.ms += rec.last;
    rec.since = null;
    changed = true;
  }
  return changed;
}

export function tickClocks() {
  const now = Date.now();
  wired.renderLastEventAge();
  // The worker's lease clock: a plain text update, no rebuild.
  for (const el of document.querySelectorAll('[data-lease-until]')) {
    const until = Number(el.dataset.leaseUntil) || 0;
    const text = hhmmss(Math.max(0, until - now));
    if (el.textContent !== text) el.textContent = text;
  }
  // The plan's per-step stopwatches, before the early return below: they are
  // driven by the harness's run records (data-ms) plus this run's start, so they
  // do not depend on the card clocks existing yet.
  for (const el of document.querySelectorAll('.plan-spent')) {
    // A settled step has no stopwatch: "not run" is the fact, and ticking it back
    // to 00:00:00 (and re-hiding it) undid the sentence a second after it appeared.
    if (el.dataset.settled) continue;
    const base = Number(el.dataset.ms) || 0;
    const since = Number(el.dataset.since) || 0;
    const ms = base + (since ? now - since : 0);
    el.classList.toggle('is-zero', ms === 0);
    const text = hhmmss(ms);
    if (el.textContent !== text) el.textContent = text;
  }
  const c = state.clocks;
  if (!c) return;
  let changed = false;
  let anyWorking = false;

  // The Architect's clock follows its *session*, not the cards on screen: a different
  // project in the panel must not stop it (12 Nov).
  const arch = (c.roles.architect ||= { ms: 0, since: null, last: 0 });
  const open = state.sessionId;
  const archBusy = Boolean(open) && isBusy(open);
  if (advanceClock(arch, { sessionId: open, busy: archBusy, busySince: state.busySince?.get(open), now })) changed = true;
  if (archBusy) anyWorking = true;

  for (const card of document.querySelectorAll('#topology .role-card')) {
    const role = card.dataset.role;
    // The Architect was advanced above, from the session rather than from this card.
    if (role === 'architect') continue;
    const working = roleIsWorking(role);
    if (working) anyWorking = true;
    const rec = (c.roles[role] ||= { ms: 0, since: null, last: 0 });
    if (working && !rec.since) rec.since = now;
    else if (!working && rec.since) {
      rec.last = now - rec.since;
      rec.ms += rec.last;
      rec.since = null;
      changed = true;
    }
  }

  // The session clock is the union of the cards: it runs while any of them works,
  // so it is stopped by a question, by a permission prompt, and by a finished
  // project — all of which show as "nobody is working" on the cards themselves.
  if (anyWorking && !c.session.since) c.session.since = now;
  else if (!anyWorking && c.session.since) {
    c.session.ms += now - c.session.since;
    c.session.since = null;
    changed = true;
  }

  paintClocks(now);
  // Persist on a real transition, and every so often while running: the totals
  // only move at transitions, so this is a handful of writes per run.
  c.ticks += 1;
  if (changed || c.ticks % 15 === 0) saveClocks();
}

/**
 * How long a role's work took, from the record rather than from this page.
 *
 * `GET /api/plan` sums every completed run for a task out of `runs.jsonl`, and the
 * live run adds its own elapsed time on top. That means the number is the same
 * after a reload as it was before one — which is what a stopwatch kept in
 * localStorage could never do: it started again from zero on every page load, and
 * knew nothing about time spent before this browser was open.
 */
export function roleTime(role, now) {
  // The Architect has no task in the plan, so the plan has nothing to say about
  // it. Its clock is the one tickClocks keeps per card: time it was actually
  // working, which the same reading that lights its dot stops for a waiting
  // question, a permission prompt and a delegation in flight.
  if (role === 'architect') {
    const rec = state.clocks?.roles?.architect;
    if (!rec) return { total: 0, running: 0, last: 0 };
    const running = rec.since ? Math.max(0, now - rec.since) : 0;
    return { total: rec.ms + running, running, last: rec.last || 0 };
  }
  const tasks = state.planState?.plan?.tasks || [];
  const spent = state.planState?.spent || {};
  const live = currentRun();
  let total = 0;
  let running = 0;
  let last = 0;
  for (const t of tasks) {
    if (t.role !== role) continue;
    const base = Number(spent[t.id]) || 0;
    total += base;
    if (base > 0) last = base;
    if (live && live.task === t.id) {
      running = Math.max(0, now - (Number(live.startedAt) || now));
      total += running;
    }
  }
  return { total, running, last };
}

export function paintClocks(now) {
  const c = state.clocks;
  if (!c) return;
  for (const card of document.querySelectorAll('#topology .role-card')) {
    const el = card.querySelector('.role-clock');
    if (!el) continue;
    const { total, running, last } = roleTime(card.dataset.role, now);
    if (!total) {
      el.textContent = '';
      continue;
    }
    // No air around the slash: at the narrowest card the pair is the widest thing on
    // the line, and two spaces there was 8px the rate could not have (13 Nov).
    el.textContent = `${hhmmss(running || last || 0)}/${hhmmss(total)}`;
  }
  const clock = $('planClock');
  if (clock) {
    clock.textContent = hhmmss(c.session.ms + (c.session.since ? now - c.session.since : 0));
  }
  paintRates(now);
}
