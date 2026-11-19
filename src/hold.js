// "Hold the timers": while the operator is reading, the harness stops taking decisions for them.
//
// Auto-Answer answers a waiting question after a wait, and an unanswered permission card is
// allowed once when its timer runs out. Both are the harness acting on the operator's behalf
// after a delay — which is wrong the moment the operator is deliberately standing still: a
// selection holds the chat so they can read it, and a question must not be answered under
// their eyes (19 Nov).
//
// The hold is a deadline, not a switch: the page renews it while it is paused, and if the page
// dies the hold expires by itself. A stuck flag on the operator's machine is the failure this
// design is built to avoid.
let until = 0;

/** Hold the timers for `ms`. Returns the deadline, which is what the page echoes back. */
export function setHold(ms) {
  const wait = Math.max(0, Math.min(10 * 60_000, Number(ms) || 0));
  until = wait ? Date.now() + wait : 0;
  return { until, held: isHeld() };
}

/** Let the timers run again. */
export function clearHold() {
  until = 0;
  return { until: 0, held: false };
}

/** Are the timers held right now? */
export const isHeld = () => until > Date.now();
