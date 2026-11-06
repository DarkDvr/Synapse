// Everything the page does to the server goes through here.
//
// It was a function in the middle of app.js, beside the code that draws the screen,
// which meant a settings pane and a chat transcript reached the network the same way
// the composer did — through the file that wires every event handler. One door is
// better: one place that sets the client header, one place that keeps the server's
// clock, one place that turns a refusal into an error the caller can read.
import { state } from './state.js';

/**
 * One request.
 *
 * The error it throws carries `status` and `body`, because the page decides what to
 * show by them: a 409 with `{ waiting: true }` is a card to answer, a 409 with
 * `{ notBusy: true }` is "send it as a message", and a 503 is "the engine is not
 * answering".
 */
export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      // Who is asking, as far as presence is concerned: the Settings lock and the
      // name in "started from laptop" both come from this header.
      ...(state.clientId ? { 'x-client-id': state.clientId } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  // Two clocks. Every countdown here compares a timestamp the server wrote with
  // "now" on this machine, and a remote PC's clock can be minutes off - which is
  // why a countdown that had just started read "picked now" in the other room
  // (4 Nov). The HTTP Date header is the server's own time; the difference is
  // kept and added wherever a server timestamp is compared.
  const date = res.headers.get('date');
  if (date) {
    const server = Date.parse(date);
    if (Number.isFinite(server)) state.clockSkew = server - Date.now();
  }
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error(json?.error || `${method} ${path} → ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/** "Now" on the server's clock, as this page understands it (see api()). */
export const serverNow = () => Date.now() + (Number(state.clockSkew) || 0);
