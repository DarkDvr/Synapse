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

test('only a lease tool wears a clock — another call in the same run does not', () => {
  state.leases = new Map([['f:/scenario|t1', lease()]]);
  const other = trace();
  other.notes = [{ at: 10, text: 'call', tool: { name: 'shell', target: 'npm test' } }];
  assert.doesNotMatch(renderTrace(other), /tool-lease-clock/);
});

test('the lease line and the card read the same clock', () => {
  state.leases = new Map([['f:/scenario|t1', lease()]]);
  const line = renderLease(leaseFor({ dir: 'F:/scenario', task: 't1' }));
  const card = renderTrace(trace());
  const from = (html) => (html.match(/data-lease-until="(\d+)"/) || [])[1];
  assert.equal(from(line), from(card), 'two clocks for one lease');
  assert.ok(page.document, 'the fake page is installed');
});
