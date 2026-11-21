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
const { chatNotesWiring, leaseFor, leaseClock, renderLease } = await import('../web/chat-notes.js');
const { tracesWiring, renderTrace } = await import('../web/traces.js');

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

test('the lease card is drawn from the lease, not from the call that asked', () => {
  state.leases = new Map([['f:/scenario|t1', lease()]]);
  // The worker's MCP lease call never reaches the trace: the page's tool notes are the polled
  // shell calls, and this call is over in forty milliseconds. The card still appears (21 Nov —
  // the operator watched a worker say "call the lease" and saw nothing).
  const bare = trace();
  bare.notes = [{ at: 10, text: 'read a file', tool: { name: 'read', target: 'src/app.js' } }];
  const html = renderTrace(bare);
  assert.match(html, /class="tool-card trace-card is-lease"/, 'no lease card for a run holding a lease');
  assert.match(html, /tool-lease-clock/, 'the card has no countdown');
  assert.match(html, /re-running the suites/, 'the card does not say what the time is for');
});

test('an ended lease says so on its card, and keeps no clock', () => {
  state.leases = new Map([['f:/scenario|t1', lease({ expired: true })]]);
  const html = renderTrace(trace());
  assert.match(html, /is-lease is-expired/, 'the ended lease is not marked');
  assert.match(html, /ended .* asking whether it needs more/, 'the card does not say what happened');
  assert.doesNotMatch(html, /tool-lease-clock/, 'a clock is left on an ended lease');
});

test('only the lease card wears a clock — another call in the same run does not', () => {
  state.leases = new Map([['f:/scenario|t1', lease()]]);
  const other = trace();
  other.notes = [{ at: 10, text: 'call', tool: { name: 'shell', target: 'npm test' } }];
  const html = renderTrace(other);
  const clocks = (html.match(/tool-lease-clock/g) || []).length;
  assert.equal(clocks, 1, 'one lease, one clock');
  const beforeCard = html.slice(0, html.indexOf('is-lease'));
  assert.doesNotMatch(beforeCard, /tool-lease-clock/, 'the shell call wears a clock it did not ask for');
});

test('the lease line and the card read the same clock', () => {
  state.leases = new Map([['f:/scenario|t1', lease()]]);
  const line = renderLease(leaseFor({ dir: 'F:/scenario', task: 't1' }));
  const card = renderTrace(trace());
  const from = (html) => (html.match(/data-lease-until="(\d+)"/) || [])[1];
  assert.equal(from(line), from(card), 'two clocks for one lease');
  assert.ok(page.document, 'the fake page is installed');
});
