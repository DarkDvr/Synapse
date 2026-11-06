// The shape of a refusal.
//
// Every route used to build one by hand: `const err = new Error('…'); err.status =
// 409; throw err;` — and the client reads `status`, `body` and `busy` off it. The
// shape worked, but it was re-invented in thirty-eight places, and a new route had
// to remember all of it. One helper, one shape.
import { busyMessage } from './busy.js';

/**
 * An error the page can act on.
 *
 * @param status  the HTTP status the route answers with
 * @param message the sentence the operator reads
 * @param extra   `{ body, busy }` — a card the page needs, or the busy state that
 *                refused a send
 */
export function fail(status, message, extra = null) {
  const err = new Error(String(message || 'Something went wrong.'));
  err.status = Number(status) || 500;
  if (extra?.body) err.body = extra.body;
  if (extra?.busy) err.busy = extra.busy;
  return err;
}

/** The refusal every "one conversation per project" route answers with. */
export function refuseBusy(info) {
  const err = fail(409, busyMessage(info));
  err.busy = info;
  return err;
}
