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
  const c = { sessionId: sessionId || null, session: { ms: 0, since: null, last: 0 }, roles: {}, ticks: 0, at: 0 };
  if (!sessionId) return c;
  try {
    const raw = JSON.parse(localStorage.getItem(clockKey(sessionId)) || 'null');
    if (raw && typeof raw === 'object') {
      c.session.ms = Math.max(0, Number(raw.session?.ms) || 0);
      // `since` is absolute: the turn may have started before the page was closed or
      // before this project was opened. Keeping it is what lets the time away count
      // (16 Nov). A stale one is reconciled against the transcript on open.
      c.session.since = Number(raw.session?.since) || null;
      c.session.last = Math.max(0, Number(raw.session?.last) || 0);
      c.at = Math.max(0, Number(raw.at) || 0);
      for (const [role, v] of Object.entries(raw.roles || {})) {
        c.roles[role] = {
          ms: Math.max(0, Number(v?.ms) || 0),
          since: Number(v?.since) || null,
          last: Math.max(0, Number(v?.last) || 0),
          pausedMs: Math.max(0, Number(v?.pausedMs) || 0),
          waitSince: Number(v?.waitSince) || null,
          runKey: String(v?.runKey || ''),
        };
      }
    }
  } catch { /* a corrupt stopwatch is not worth an error */ }
  return c;
}

/** Write the reading now; called on a transition, on a timer, and before a page goes. */
export function flushClocks() {
  saveClocks();
}

function saveClocks() {
  const c = state.clocks;
  if (!c?.sessionId) return;
  try {
    const roles = {};
    for (const [role, v] of Object.entries(c.roles)) {
      roles[role] = {
        ms: v.ms,
        since: v.since,
        last: v.last,
        pausedMs: v.pausedMs || 0,
        waitSince: v.waitSince || null,
        runKey: v.runKey || '',
      };
    }
    c.at = Date.now();
    localStorage.setItem(
      clockKey(c.sessionId),
      JSON.stringify({ session: { ms: c.session.ms, since: c.session.since, last: c.session.last }, roles, at: c.at }),
    );
  } catch { /* full or blocked storage must not break a turn */ }
}

/** Is this card doing work right now? The same reading its dot uses. */
export function roleIsWorking(role) {
  const run = currentRun();
  const waiting = (sessionId) => Boolean(sessionId) && (
    (state.forms || []).some((form) => form.sessionId === sessionId) ||
    (state.permissions || []).some((perm) => perm.sessionId === sessionId)
  );
  if (role === 'architect') {
    // Waiting on the operator is not work, and neither is waiting on a worker —
    // the worker's own card is the one that should be counting.
    if (waiting(state.sessionId)) return false;
    if (run) return false;
    return isBusy(state.sessionId) || state.busy === true;
  }
  if (!run || run.role !== role) return false;
  // A worker stopped on its own question or permission card is waiting, exactly as
  // its card says. The card used to look only for a form, and it compared the form's
  // session with the *open* chat, so a worker's permission kept its clock running
  // while the operator was looking at the card (16 Nov).
  return !waiting(run.workerId);
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
export function advanceClock(rec, { sessionId = null, busy = false, busySince = null, endedAt = null, now = Date.now() } = {}) {
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
    // The transcript knows when the turn really ended; a page that opens after a
    // project finished behind it would otherwise bill the time it was closed (16 Nov).
    const end = Number(endedAt) >= rec.since ? Number(endedAt) : now;
    rec.last = Math.max(0, end - rec.since);
    rec.ms += rec.last;
    rec.since = null;
    changed = true;
  }
  return changed;
}

/**
 * A rough total for a chat whose stopwatch was never written down: the sum of the
 * completed assistant turns the transcript still holds. Used only when a project has
 * no saved reading at all — a chat that ran entirely in the background can still show
 * that it did some work when it is first opened (16 Nov).
 */
export function transcriptWorkMs(messages = []) {
  let total = 0;
  for (const m of messages) {
    if (m?.type !== 'assistant' || !m.completed) continue;
    const started = Number(m.created) || 0;
    const ended = Number(m.completed) || 0;
    if (started && ended > started) total += ended - started;
  }
  return total;
}

/**
 * Close a stopwatch whose chat finished while this page was elsewhere or closed.
 *
 * The transcript's last completed assistant message is the honest end time; the last
 * local save is the fallback when there is no such message. Without this, opening a
 * project after its turn finished billed the downtime as work (16 Nov).
 */
export function reconcileClocks({ busy = false, endedAt = null, fallbackMs = 0, now = Date.now() } = {}) {
  const c = state.clocks;
  if (!c) return;
  let changed = false;
  // A chat never opened while it worked has no saved `since`; the transcript's own turn
  // lengths are the only honest record left.
  if (Number(fallbackMs) > 0) {
    for (const rec of [c.session, c.roles.architect]) {
      if (rec && !rec.since && !rec.ms) {
        rec.ms = Number(fallbackMs);
        rec.last = Number(fallbackMs);
        changed = true;
      }
    }
  }
  if (busy) {
    if (changed) {
      saveClocks();
      paintClocks(now);
    }
    return;
  }
  const known = Number(endedAt) || 0;
  const saved = Number(c.at) || 0;
  for (const rec of [c.session, c.roles.architect]) {
    if (!rec?.since) continue;
    const end = known >= rec.since ? known : saved >= rec.since ? saved : now;
    rec.last = Math.max(0, end - rec.since);
    rec.ms += rec.last;
    rec.since = null;
    changed = true;
  }
  if (changed) {
    saveClocks();
    paintClocks(now);
  }
}


export function tickClocks() {
  const now = Date.now();
  wired.renderLastEventAge();
  // The lease clock: a plain text update, no rebuild. At zero it says so — a card that
  // still says "00:00:00" reads as a broken countdown rather than as a lease that ended.
  for (const el of document.querySelectorAll('[data-lease-until]')) {
    const until = Number(el.dataset.leaseUntil) || 0;
    const text = until > now ? hhmmss(until - now) : 'ended';
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
  const archBusy = Boolean(open) && roleIsWorking('architect');
  if (advanceClock(arch, { sessionId: open, busy: archBusy, busySince: state.busySince?.get(open), now })) changed = true;
  if (archBusy) anyWorking = true;

  for (const card of document.querySelectorAll('#topology .role-card')) {
    const role = card.dataset.role;
    // The Architect was advanced above, from the session rather than from this card.
    if (role === 'architect') continue;
    const working = roleIsWorking(role);
    const live = currentRun();
    const runKey = live && live.role === role ? `${live.task}|${Number(live.startedAt) || 0}` : '';
    const rec = (c.roles[role] ||= { ms: 0, since: null, last: 0, pausedMs: 0, waitSince: null, runKey: '' });
    // A new run starts with no pause behind it; the same run keeps the pause already
    // accumulated (a page reload in the middle of a permission card).
    if (rec.runKey !== runKey) {
      rec.runKey = runKey;
      rec.pausedMs = 0;
      rec.waitSince = null;
      changed = true;
    }
    if (runKey) {
      if (!working && !rec.waitSince) {
        rec.waitSince = now;
        changed = true;
      } else if (working && rec.waitSince) {
        rec.pausedMs += Math.max(0, now - rec.waitSince);
        rec.waitSince = null;
        changed = true;
      }
    }
    if (working) anyWorking = true;
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
    if (live && live.role === role && live.task === t.id) {
      const rec = state.clocks?.roles?.[role];
      const key = `${live.task}|${Number(live.startedAt) || 0}`;
      const paused = rec && rec.runKey === key
        ? (Number(rec.pausedMs) || 0) + (rec.waitSince ? Math.max(0, now - rec.waitSince) : 0)
        : 0;
      running = Math.max(0, now - (Number(live.startedAt) || now) - paused);
      total += running;
    }
  }
  return { total, running, last };
}

export function paintClocks(now) {
  if (typeof document === 'undefined') return;
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
