// Is the open session's own turn still running?
//
// Two answers exist and both are needed. `state.busy` is the page's event flag: up on
// `execution.started`, down when the turn ends. The newest message is the engine's own
// record: an assistant message without `completed` is one it will still add to. A page
// opened mid-turn has the message before it has the event, and a turn that ended while
// another chat was on screen never reached the flag at all — which is how a one-line
// thinking pane came to sit under a finished Architect post (13 Nov).
import { state } from './state.js';

export function turnLive() {
  if (state.busy) return true;
  const msgs = state.messages || [];
  const last = msgs[msgs.length - 1];
  return Boolean(last && last.type === 'assistant' && !last.completed && !last.error);
}

/**
 * The composer's answer: is this turn working?
 *
 * The engine's own list of active sessions decides — `state.busySessions`, refreshed by the
 * poll and by the status events. The transcript cannot: between two steps of one turn its
 * last message is *complete* (that is the step which issued the tool call), so a transcript
 * rule cleared `busy` right after every tool call. The Stop button went away, and the
 * thinking pane — which belongs to a live turn — was dropped and rebuilt by the next
 * render, which is the jump the operator reported (21 Nov).
 *
 * The list is also what stops a restarted app breathing for ever: after a restart it is
 * empty, and an assistant message the old run left incomplete means nothing.
 */
export function busyNow(sessionId, active = state.busySessions) {
  return Boolean(sessionId) && Boolean(active && typeof active.has === 'function' && active.has(sessionId));
}
