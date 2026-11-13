// The Architect's own turn has no run, so nothing was watching it.
//
// A delegated run is watched by the runner: a stall clock, a loop guard, a limit on how
// many times it may be rescued. The operator's own turn — the Architect in Single mode, or
// any chat the operator drives — had none of that, because there is nothing to wait on: the
// page sends a prompt and the engine works. So the loop guard could be switched on and still
// catch nothing, which is exactly what happened on 12–13 Nov: the model re-read one README
// slice for half an hour with the switch on.
//
// This is the missing watcher, and it is deliberately gentle:
//
//   - it only watches a session the engine says is **active**, and stops when it is not;
//   - it nudges by **steer**, which joins the live turn at its next step. It never
//     interrupts, never ends the turn and never sends anything after one — a turn that
//     has ended is a turn the operator is reading, not one to wake;
//   - one nudge per `quietMs`, and a note to the operator at the third, so the model is
//     given a chance to change course before anyone is told it is stuck.
//
// The detection is the runner's own rule (`loop-detect.js`): the same call four times, or
// the same answer three times, in a window of twelve. Nothing is invented here.

import { toolSignature, loopStrike, LOOP_WINDOW, LOOP_NUDGE } from './loop-detect.js';
// One definition of a target: offsets and limits included, so paging a file is not a loop.
import { toolTarget } from './runs.js';

export function createTurnGuard({
  engine,
  sessionId,
  dir = '',
  log = console,
  notify = null,
  everyMs = 4000,
  quietMs = 90_000,
  strikesBeforeTelling = 3,
  now = () => Date.now(),
  setInterval: setTimer = setInterval,
  clearInterval: clearTimer = clearInterval,
} = {}) {
  let timer = null;
  let stopped = false;
  let window = [];
  const seen = new Set();
  let strikes = 0;
  let lastNudge = 0;
  let told = false;

  const stop = () => {
    stopped = true;
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const active = await engine.listActiveSessions().catch(() => []);
      if (!Array.isArray(active) || !active.includes(sessionId)) {
        // The turn is over: a guard that keeps polling would nudge the next turn for the
        // last one's repeats.
        stop();
        return;
      }
      const messages = await engine.getMessages(sessionId).catch(() => null);
      if (!Array.isArray(messages)) return;
      for (const message of messages) {
        for (const part of message?.parts || []) {
          if (part?.type !== 'tool' || !part.name) continue;
          const id = String(part.id || '');
          if (id && seen.has(id)) continue;
          if (id) seen.add(id);
          const input = typeof part.input === 'object' && part.input ? part.input : {};
          // The runner's own target rule, not a second, weaker one: this guard used to
          // compare only the path, so five reads of *different slices* of one file struck
          // as "the same target 4 times" (13 Nov).
          const target = toolTarget(input);
          const call = toolSignature({
            name: String(part.name),
            target: String(target ?? ''),
            output: String(part.output ?? ''),
          });
          if (!call.sig.split('\u0000')[1]) continue; // no target, no signature
          window.push(call);
          if (window.length > LOOP_WINDOW) window.shift();
          const strike = loopStrike(window);
          if (!strike) continue;
          const at = now();
          if (at - lastNudge < quietMs) continue;
          lastNudge = at;
          strikes += 1;
          const what =
            strike.kind === 'output'
              ? `${part.name} returned the same answer ${strike.times} times`
              : `${part.name} was called on the same target ${strike.times} times`;
          log.warn?.(`loop guard: ${what} in ${sessionId} — nudging the turn`);
          try {
            await engine.prompt(sessionId, `[harness] ${LOOP_NUDGE}`, { delivery: 'steer' });
          } catch (err) {
            log.warn?.(`loop guard: the nudge did not reach ${sessionId}: ${err.message}`);
          }
          if (!told && strikes >= strikesBeforeTelling) {
            told = true;
            notify?.({
              kind: 'note',
              title: 'This Looks Like A Loop',
              body: `${what}. The model has been nudged ${strikes} times; Stop is in the composer if it does not recover.`,
              ts: at,
            });
          }
        }
      }
    } catch (err) {
      // A guard must never take a turn down with it.
      log.warn?.(`loop guard: ${err.message}`);
    }
  };

  return {
    start() {
      if (timer || stopped) return this;
      timer = setTimer(() => {
        tick();
      }, everyMs);
      return this;
    },
    stop,
    /** For a test: run one poll now. */
    poll: tick,
    state: () => ({ strikes, window: window.length, stopped }),
  };
}
