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
