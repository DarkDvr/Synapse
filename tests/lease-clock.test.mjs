// The lease's countdown, on the tool call that asked for it.
//
// A lease is a worker's estimate of how long a long command will take, and the operator gave it
// their screen for that long. The card for the call that asked says "completed" the moment the
// request lands — which says nothing about how long the screen is still gone. The clock does,
// and it is the same element the lease line uses (`data-lease-until`), so one ticker in the page
// keeps both of them honest without a rebuild (20 Nov).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installPage } from './fake-page.mjs';

const page = installPage();
const { state } = await import('../web/state.js');
const { chatNotesWiring, leaseFor, leaseClock, renderLease, noteLease, callLeaseClock, leaseOfMessages } = await import('../web/chat-notes.js');
const { tracesWiring, renderTrace, noteLeaseLine } = await import('../web/traces.js');
const { parseToolInput, toolNameLabel, toolTarget } = await import('../web/format.js');

chatNotesWiring({
  currentProject: () => ({ directory: 'F:/scenario' }),
  dirKey: (dir) => String(dir || '').replace(/\\/g, '/').toLowerCase(),
  roleLabel: (role) => (role === 'coder-1' ? 'Coder 1' : ''),
});
tracesWiring({ renderTranscript() {} });

const lease = (over = {}) => ({
  dir: 'F:/scenario',
  task: 't1',
  role: 'coder-1',
  until: Date.now() + 300_000,
  minutes: 5,
  reason: 're-running the suites',
  extended: false,
  expired: false,
  ...over,
});

const trace = () => ({
  key: 'k1',
  dir: 'F:/scenario',
  role: 'coder-1',
  task: 't1',
  startedAt: 1,
  notes: [{ at: 10, text: 'call', tool: { name: 'synapse-lease_lease', target: 're-running the suites' } }],
});

test('the call that asked for a lease carries its countdown in front of the target', () => {
  state.config = { ui: { workerCards: true } };
  state.leases = new Map([['f:/scenario|t1', lease()]]);
  const html = renderTrace(trace());
  assert.match(html, /class="tool-lease-clock"/, 'no clock on the lease card');
  assert.match(html, /data-lease-until="\d+"/, 'the clock is not wired to the page ticker');
  assert.match(html, /tool-lease-clock[^>]*>[^<]*<\/span><span class="tool-target"/, 'the clock does not sit in front of the description');
});

test('a lease that has ended leaves no clock behind', () => {
  state.leases = new Map([['f:/scenario|t1', lease({ expired: true })]]);
  assert.equal(leaseClock({ name: 'synapse-lease_lease' }, leaseFor({ dir: 'F:/scenario', task: 't1' })), '');
});

test('a lease posts in the stream, at its moment, above the thinking pane', () => {
  const t = trace();
  t.notes = [{ at: 10, text: 'read a file', tool: { name: 'read', target: 'src/app.js' } }];
  t.stream = { text: 'thinking about the suites', ended: false };
  const ok = noteLeaseLine(t, {
    kind: 'lease',
    leaseKind: 'granted',
    dir: 'F:/scenario',
    task: 't1',
    role: 'coder-1',
    minutes: 30,
    reason: 're-running the suites',
    until: Date.now() + 1_800_000,
  });
  assert.ok(ok, 'the lease never reached the timeline');
  const html = renderTrace(t);
  // The operator asked for exactly this: a lease that posts like any other tool call, so it
  // is the newest line, sits above the thinking pane, and moves up as the work goes on.
  const card = html.indexOf('is-lease');
  const pane = html.indexOf('thinking about the suites');
  assert.ok(card > 0, 'no lease card in the stream');
  assert.ok(pane === -1 || card < pane, 'the lease card is not above the thinking pane');
  assert.match(html, /tool-lease-clock/, 'the card has no countdown');
  assert.match(html, /re-running the suites/, 'the card does not say what the time is for');
});

test('the newest lease keeps the clock, and the card it replaced keeps its estimate', () => {
  const t = trace();
  const now = Date.now();
  noteLeaseLine(t, { kind: 'lease', leaseKind: 'granted', dir: 'F:/scenario', task: 't1', role: 'coder-1', minutes: 5, reason: 'first stretch', until: now + 300_000 });
  noteLeaseLine(t, { kind: 'lease', leaseKind: 'extended', dir: 'F:/scenario', task: 't1', role: 'coder-1', minutes: 10, reason: 'more time', until: now + 600_000, extended: true });
  const html = renderTrace(t);
  assert.equal((html.match(/tool-lease-clock/g) || []).length, 1, 'two leases ticking at once');
  assert.match(html, /is-lease is-past/, 'the replaced card still claims to be the lease');
  assert.match(html, /00:05:00/, 'the replaced card lost its estimate');
});

test('the harness asking for more time marks the card that is waiting', () => {
  const t = trace();
  noteLeaseLine(t, { kind: 'lease', leaseKind: 'granted', dir: 'F:/scenario', task: 't1', role: 'coder-1', minutes: 30, reason: 'the suites', until: Date.now() - 1000 });
  noteLeaseLine(t, { kind: 'lease', leaseKind: 'expired', dir: 'F:/scenario', task: 't1' });
  const html = renderTrace(t);
  assert.match(html, /is-lease is-expired/, 'the ended lease is not marked');
  assert.match(html, /asking whether it needs more/, 'the card does not say what happened');
  assert.doesNotMatch(html, /tool-lease-clock/, 'a clock is left on an ended lease');
});

test('only the lease card wears a clock — another call in the same run does not', () => {
  const t = trace();
  t.notes = [{ at: 10, text: 'shell', tool: { name: 'shell', target: 'npm test' } }];
  noteLeaseLine(t, { kind: 'lease', leaseKind: 'granted', dir: 'F:/scenario', task: 't1', role: 'coder-1', minutes: 30, reason: 're-running the suites', until: Date.now() + 1_800_000 });
  const html = renderTrace(t);
  assert.equal((html.match(/tool-lease-clock/g) || []).length, 1, 'one lease, one clock');
});

test('the call in the conversation wears the timer, and says ended when it passes', () => {
  // A chat turn is not a run: nothing sends a note, so the call itself is the record.
  const at = Date.now() - 60_000;
  const call = { type: 'tool', name: 'synapse-lease_lease', input: { minutes: 30, reason: 'the suite' } };
  const live = leaseOfMessages([{ created: at, parts: [call] }]);
  assert.equal(live.minutes, 30, 'the call did not become a lease');
  assert.match(callLeaseClock({ name: 'synapse-lease_lease' }, live), /data-lease-until="\d+"/, 'no timer on the call');
  const old = leaseOfMessages([{ created: at - 40 * 60_000, parts: [call] }]);
  assert.match(callLeaseClock({ name: 'synapse-lease_lease' }, old), /is-ended/, 'a passed lease shows a number');
  // Another tool is not a lease and never wears one.
  assert.equal(callLeaseClock({ name: 'shell' }, live), '');
});

test('the stream line is the event, and the head carries the state while it is in force', () => {
  state.leases = new Map([['f:/scenario|t1', lease()]]);
  const t = trace();
  noteLeaseLine(t, { kind: 'lease', leaseKind: 'granted', dir: 'F:/scenario', task: 't1', role: 'coder-1', minutes: 30, reason: 're-running the suites', until: lease().until });
  const html = renderTrace(t);
  const head = html.slice(0, html.indexOf('trace-lines'));
  // The line moved up into "12 earlier steps" after the lease was taken, and the operator
  // asked where it had gone — a state that can fold away is a state you cannot see (21 Nov).
  assert.match(head, /class="trace-lease"/, 'the head does not say a lease is in force');
  assert.match(head, /data-lease-until="\d+"/, 'the head chip is not on the page ticker');
  assert.match(html, /is-lease/, 'the stream line went missing');
  state.leases.set('f:/scenario|t1', lease({ expired: true }));
  assert.doesNotMatch(renderTrace(t), /class="trace-lease"/, 'an ended lease still sits on the head');
});

test('the lease line and the card read the same clock', () => {
  state.leases = new Map([['f:/scenario|t1', lease()]]);
  const t = trace();
  noteLeaseLine(t, { kind: 'lease', leaseKind: 'granted', dir: 'F:/scenario', task: 't1', role: 'coder-1', minutes: 30, reason: 're-running the suites', until: lease().until });
  const line = renderLease(leaseFor({ dir: 'F:/scenario', task: 't1' }));
  const card = renderTrace(t);
  const from = (html) => (html.match(/data-lease-until="(\d+)"/) || [])[1];
  assert.equal(from(line), from(card), 'two clocks for one lease');
  assert.ok(page.document, 'the fake page is installed');
});

test('an MCP query string is still a lease', () => {
  // The engine delivered this call as `minutes=5&reason=the+suites`; JSON-only
  // parsing made the card raw and the runner blind (24 Nov).
  const call = { type: 'tool', name: 'synapse-lease_lease', input: 'minutes=5&reason=the+suites' };
  assert.deepEqual(parseToolInput(call.input), { minutes: '5', reason: 'the suites' });
  assert.equal(toolNameLabel(call.name), 'Lease');
  assert.equal(toolTarget(call), 'the suites');
  const live = leaseOfMessages([{ created: Date.now() - 60_000, parts: [call] }]);
  assert.equal(live.minutes, 5, 'the query minutes did not become a lease');
  assert.equal(live.reason, 'the suites');
  assert.match(callLeaseClock(call, live), /data-lease-until="\d+"/, 'the lease has no clock');
  // The engine sometimes puts the same query on the part's title instead of input.
  const titled = { type: 'tool', name: 'synapse-lease_lease', title: 'minutes=3&reason=the+install' };
  const fromTitle = leaseOfMessages([{ created: Date.now() - 60_000, parts: [titled] }]);
  assert.equal(fromTitle.minutes, 3, 'a query in the title did not become a lease');
  assert.equal(fromTitle.reason, 'the install');
});
