// What the one waiting line says, asked of the pure resolver.
//
// The page may have engine events, a local server's live counter, both, or
// neither. These cases pin the judgement: a fact that is more specific wins, a
// missing fact falls back, and no state invents a connection or a token count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WAIT, waitBegin, waitStep, waitRetry, waitMetrics, waitEnd, waitingText } from '../web/waiting.js';

const at = 1_700_000_000_000;
const now = at;

test('a cloud turn starts at the honest generic state', () => {
  const wait = waitBegin({ sessionId: 's1', at, local: false });
  assert.equal(wait.phase, WAIT.waiting);
  assert.equal(waitingText(wait, now), 'Waiting for the model…');
});

test('a local turn starts connecting', () => {
  const wait = waitBegin({ sessionId: 's1', at, local: true });
  assert.equal(wait.phase, WAIT.connecting);
  assert.equal(waitingText(wait, now), 'Connecting…');
});

test('a live prefill count wins over the generic wait', () => {
  const started = waitBegin({ sessionId: 's1', at, local: true });
  const wait = waitMetrics(started, {
    ok: true,
    reachable: true,
    state: 'prefill',
    read: 8192,
    total: 108553,
    generated: 0,
    elapsed: 10,
  }, now);
  assert.equal(wait.phase, WAIT.prefill);
  assert.equal(waitingText(wait, now), 'Reading prompt 8,192 / 108,553… 10s');
});

test('a reachable server with no prompt count is simply connected', () => {
  const started = waitBegin({ sessionId: 's1', at, local: true });
  const wait = waitMetrics(started, { ok: true, reachable: true, state: 'connected' }, now);
  assert.equal(wait.phase, WAIT.connected);
  assert.equal(waitingText(wait, now), 'Connected — waiting for the prompt…');
});

test('the server’s own load and queue words are kept', () => {
  const started = waitBegin({ sessionId: 's1', at, local: true });
  const loading = waitMetrics(started, { ok: true, reachable: true, state: 'loading' }, now);
  assert.equal(waitingText(loading, now), 'Model loading…');
  const queued = waitMetrics(started, { ok: true, reachable: true, state: 'queued' }, now);
  assert.equal(waitingText(queued, now), 'Queued…');
});

test('a generating metric ends the wait even before the next engine step', () => {
  const started = waitBegin({ sessionId: 's1', at, local: true });
  const wait = waitMetrics(started, {
    ok: true,
    reachable: true,
    state: 'generating',
    generated: 12,
  }, now);
  assert.equal(wait.phase, WAIT.thinking);
  assert.equal(waitingText(wait, now), 'Thinking…');
});

test('a missing metrics endpoint falls back to waiting, not to a false connection', () => {
  const started = waitBegin({ sessionId: 's1', at, local: true });
  const wait = waitMetrics(started, { ok: false, reachable: false }, now);
  assert.equal(wait.phase, WAIT.waiting);
  assert.equal(waitingText(wait, now), 'Waiting for the model…');
});

test('the engine step turns the line into thinking and a stale metric cannot take it back', () => {
  const started = waitBegin({ sessionId: 's1', at, local: true });
  const prefill = waitMetrics(started, { ok: true, reachable: true, state: 'prefill', read: 10, total: 100 }, now);
  const step = waitStep(prefill, now + 500);
  assert.equal(step.phase, WAIT.thinking);
  assert.equal(waitingText(step, now + 500), 'Thinking…');
  const stale = waitMetrics(step, { ok: true, reachable: true, state: 'prefill', read: 10, total: 100 }, now + 900);
  assert.equal(stale.phase, WAIT.thinking);
});

test('a retry names the reason and counts down when the engine gave a time', () => {
  const started = waitBegin({ sessionId: 's1', at, local: false });
  const wait = waitRetry(started, { at, retryAt: at + 20_000, detail: '429 Too Many Requests' });
  assert.equal(wait.phase, WAIT.retry);
  assert.equal(waitingText(wait, now + 1000), 'Retrying in 19s — 429 Too Many Requests');
});

test('a retry without a known time still says what happened', () => {
  const started = waitBegin({ sessionId: 's1', at, local: false });
  const wait = waitRetry(started, { at, detail: 'connection reset' });
  assert.equal(waitingText(wait, now + 5000), 'Retrying… — connection reset');
});

test('elapsed seconds appear once there is something to see', () => {
  const started = waitBegin({ sessionId: 's1', at, local: false });
  assert.equal(waitingText(started, at + 4000), 'Waiting for the model… 4s');
});

test('ending clears the line', () => {
  assert.equal(waitEnd(), null);
  assert.equal(waitingText(null, now), '');
});

test('the line never grows into a paragraph', () => {
  const started = waitBegin({ sessionId: 's1', at, local: false });
  const wait = waitRetry(started, {
    at,
    detail: 'x'.repeat(400),
  });
  assert.ok(waitingText(wait, now).length < 120, waitingText(wait, now));
});
