// One local server's live counter, polled only while a turn is waiting.
//
// This is a capability probe as much as a data feed: a server without `/metrics`
// answers 404 once, the poll stops, and the waiting line keeps the engine's own
// generic state. Nothing here is allowed to turn a failed probe into a claim
// about the model.
import { api } from './api.js';

let timer = 0;
let run = 0;

/** Stop the current feed. A late answer is ignored by the run counter. */
export function stopWaitMetrics() {
  run += 1;
  if (timer) clearInterval(timer);
  timer = 0;
}

/**
 * Start a feed for `providerId`.
 *
 * `onUpdate` is called with the normalised shape from `src/provider-live.js`.
 * The first call happens immediately, so a server that is already prefilling
 * shows its count without waiting a whole second.
 */
export function startWaitMetrics(providerId, onUpdate) {
  stopWaitMetrics();
  const id = String(providerId || '').trim();
  if (!id || typeof onUpdate !== 'function') return;
  const mine = run;
  let inFlight = false;

  const poll = async () => {
    if (mine !== run || inFlight) return;
    inFlight = true;
    let out;
    try {
      out = await api('GET', `/api/providers/live?id=${encodeURIComponent(id)}`);
    } catch (err) {
      out = { ok: false, reachable: false, reason: String(err?.message || err) };
    } finally {
      inFlight = false;
    }
    if (mine !== run) return;
    onUpdate(out);
    // The route itself is missing (an older server, before a restart) or the
    // provider is not one of ours: there is nothing to poll for. The engine's
    // line is the fallback.
    if (!out || out.ok === false) stopWaitMetrics();
  };

  poll();
  timer = setInterval(poll, 1000);
}
