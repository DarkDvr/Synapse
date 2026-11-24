// Which chats are working, which need the operator, and what that is worth saying.
//
// With one chat on screen the page only had to watch that one: `noteWorking` read
// the open session and played the finished-work chime. With several chats open at
// once a chat can finish, or stop on a card, while the operator is reading another —
// and silence there is a lie: the work is done, or it is waiting for them. This
// module turns "what every chat is doing" into those two rare events.
//
// Two rules it keeps from the chime it extends:
//
// - **A gap is not a finish.** In Multi with Keep Building on, the Architect reads a
//   report and starts the next task seconds later. The finish is therefore held back
//   for a few seconds and dropped if the chat starts working again — the same rule
//   `workWillContinue` applies to the open chat with the plan in hand (31 Oct).
// - **A stop is not a finish.** A chat the operator stopped says so with quiet, and
//   `quiet()` is how the page tells it.
//
// A blocked chat gets a shorter grace: a card the gate answers itself comes and goes
// in under a second, and that must not knock (the same reason the card is painted
// after a 200ms refresh).
import { dirKey } from './run-view.js';

/** What every chat is doing, keyed by directory. */
export function chatStates({ projects = [], runs = null, busySessions = null, permissions = [], forms = [] } = {}) {
  const out = new Map();
  const live = runs instanceof Map ? runs : new Map();
  const busy = busySessions instanceof Set ? busySessions : new Set(busySessions || []);
  const blocked = new Set();
  for (const ask of [...(permissions || []), ...(forms || [])]) {
    const key = dirKey(ask?.directory || '');
    if (key) blocked.add(key);
  }
  for (const project of projects || []) {
    const key = dirKey(project?.directory);
    if (!key) continue;
    out.set(key, {
      working: live.has(key) || (project.sessions || []).some((s) => busy.has(s.id)),
      blocked: blocked.has(key),
    });
  }
  // A run whose project the rail has not loaded yet: the work is still real.
  for (const key of live.keys()) if (!out.has(key)) out.set(key, { working: true, blocked: blocked.has(key) });
  return out;
}

/**
 * Turn two readings into the events worth a sound.
 *
 * Pure, so the rules are tested without a clock: the first reading is the baseline
 * (a page opened on a finished chat says nothing), a finished chat is reported only
 * once, and the open chat's finish is left to `noteWorking`, which has its plan.
 */
export function transitions(before, after, { skipFinished = new Set() } = {}) {
  const out = [];
  if (!before || !before.size) return out;
  for (const [key, now] of after) {
    const was = before.get(key);
    if (!was) continue;
    if (was.working && !now.working && !skipFinished.has(key)) out.push({ type: 'finished', key });
    if (!was.blocked && now.blocked) out.push({ type: 'blocked', key });
  }
  return out;
}

/**
 * How long a finish is held back before it is worth a sound.
 *
 * A gap is not a finish: the Architect reads a worker's report and starts the next turn
 * a second or two later, and with Keep Building on it starts the next task. The runner's
 * report wake is not instant either — measured 5s between a worker finishing and the
 * "wake sent" line — so four seconds chimed over the Architect's judging turn (24 Nov).
 * Ten seconds clears that wake and still lets a real finish speak.
 */
export const FINISH_GRACE_MS = 10000;

/**
 * Wait out the gap before saying a chat has finished — the same rule for the open chat.
 *
 * `stillGoing()` is asked now and again when the grace is up: a chat that started working
 * in between is not finished and must make no sound. `cancel()` is what "work resumed"
 * calls; `run()` fires only when the gap turned out to be an end.
 *
 * The open chat used to chime the moment its work stopped, with the plan as its only
 * guard (`workWillContinue`). With Keep Building off the plan is *right* that no task is
 * left — and yet the Architect still owes its turn, judging the report it was just handed.
 * On 21 Nov the chime played into exactly that gap, over a report the Architect was
 * reading, and the workflow went on (21 Nov).
 */
export function holdFinish(stillGoing, run, {
  delayMs = FINISH_GRACE_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
} = {}) {
  if (typeof stillGoing === 'function' && stillGoing()) return { cancel() {} };
  let handle = setTimer(() => {
    handle = 0;
    if (typeof stillGoing === 'function' && stillGoing()) return;
    run?.();
  }, delayMs);
  return {
    cancel() {
      if (!handle) return;
      clearTimer(handle);
      handle = 0;
    },
  };
}

/**
 * The page's watcher: reads the states, waits out the gap, and calls back once.
 *
 * `setTimer`/`clearTimer` are injectable so a test can run the callbacks at once.
 * `quiet(dir)` marks a chat whose work was stopped by the operator: its end is not
 * "finished" and must not chime. The mark is dropped the moment it works again.
 */
export function createAttention({
  onFinished = null,
  onBlocked = null,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  finishDelayMs = FINISH_GRACE_MS,
  blockDelayMs = 1200,
} = {}) {
  let last = null;
  const finishing = new Map();
  const knocking = new Map();
  const quiet = new Set();

  function drop(map, key) {
    if (!map.has(key)) return;
    clearTimer(map.get(key));
    map.delete(key);
  }

  function note(states, { openDir = '' } = {}) {
    const before = last;
    last = states;
    if (!before) return; // the first look is the baseline, not news
    const open = dirKey(openDir);
    for (const [key, now] of states) {
      const was = before.get(key);
      if (!was) continue;
      if (was.working && !now.working) {
        if (key !== open && !quiet.has(key) && !finishing.has(key)) {
          finishing.set(
            key,
            setTimer(() => {
              finishing.delete(key);
              if (last.get(key)?.working || quiet.has(key)) return;
              onFinished?.(key);
            }, finishDelayMs),
          );
        }
      } else if (now.working) {
        drop(finishing, key);
        quiet.delete(key);
      }
      if (!was.blocked && now.blocked) {
        if (!knocking.has(key)) {
          knocking.set(
            key,
            setTimer(() => {
              knocking.delete(key);
              if (!last.get(key)?.blocked) return;
              onBlocked?.(key);
            }, blockDelayMs),
          );
        }
      } else if (!now.blocked) {
        drop(knocking, key);
      }
    }
    // A chat that left the rail keeps no timer.
    for (const key of [...finishing.keys()]) if (!states.has(key)) drop(finishing, key);
    for (const key of [...knocking.keys()]) if (!states.has(key)) drop(knocking, key);
  }

  /** This chat's work was stopped by the operator: its end is not a finish. */
  function quietUntil(dir) {
    const key = dirKey(dir);
    if (key) quiet.add(key);
  }

  return { note, quietUntil, state: () => ({ finishing: [...finishing.keys()], knocking: [...knocking.keys()], quiet: [...quiet] }) };
}
