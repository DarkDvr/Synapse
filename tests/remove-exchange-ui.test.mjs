// The delete chip and what it marks: only the last exchange, only while the chat is
// idle, and only after the server has said the boundary is clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installPage } from './fake-page.mjs';

installPage();
const { state } = await import('../web/state.js');
const { renderTranscript, transcriptWiring } = await import('../web/transcript.js');
const { chatScrollWiring } = await import('../web/chat-scroll.js');
const { renderRemoveChip, previewRemoveExchange, endRemovePreview, removeExchangeClick, resetRemoveExchange } =
  await import('../web/remove-exchange.js');

chatScrollWiring({
  renderTranscript,
  traceOf: () => null,
  currentRun: () => null,
  askHost: () => null,
});
transcriptWiring({
  renderRoleActivity() {},
  mountAskPost() {},
  renderPermissions: () => '',
  compactPostOf: () => null,
});

const messages = [
  { id: 'u1', type: 'user', text: 'First', created: 1 },
  { id: 'a1', type: 'assistant', completed: 2, created: 2, parts: [{ type: 'text', text: 'One' }] },
  { id: 'u2', type: 'user', text: 'Second', created: 3 },
  { id: 'a2', type: 'assistant', completed: 4, created: 4, parts: [{ type: 'text', text: 'Two' }] },
];

function reset({ mode = 'single', busy = false, available = true } = {}) {
  const page = installPage();
  state.messages = messages.map((m) => ({ ...m }));
  state.sessionId = 'ses_test';
  state.mode = mode;
  state.removeInfo = available ? { available: true, messageID: 'u2', count: 3 } : { available: false, reason: 'no' };
  state.busy = busy;
  state.busyInfo = null;
  state.streaming = false;
  state.compacting = false;
  state.stopping = false;
  state.canStop = false;
  state.runs = new Map();
  state.forms = [];
  state.permissions = [];
  state.lease = null;
  state.busySessions = new Set();
  state.modeNote = null;
  state.traces = new Map();
  state.sessionTrace = { key: '', stream: null };
  state.alarms = [];
  state.errors = [];
  state.leases = new Map();
  state.open = new Set();
  state.renderSig = '';
  return page;
}

test('only the last prompt and its answer are marked', () => {
  const page = reset();
  renderTranscript();
  const html = page.el('transcript').innerHTML;
  assert.equal((html.match(/data-remove-target="1"/g) || []).length, 2);
  assert.match(html, /Second/);
  assert.match(html, /Two/);
  const btn = page.el('removeChip');
  assert.equal(btn.hidden, false);
  assert.equal(btn.textContent, 'Remove Exchange');
});

test('hover previews only the posts that would go', () => {
  const page = reset();
  renderTranscript();
  previewRemoveExchange();
  assert.equal(page.el('transcript').classList.contains('is-remove-preview'), true);
  endRemovePreview();
  assert.equal(page.el('transcript').classList.contains('is-remove-preview'), false);
});

test('a first click asks; reset puts the chip back', () => {
  const page = reset();
  renderTranscript();
  removeExchangeClick();
  assert.equal(page.el('removeChip').textContent, 'Remove Exchange?');
  assert.equal(page.el('removeChip').classList.contains('is-confirm'), true);
  assert.equal(page.el('transcript').classList.contains('is-remove-confirm'), true);
  resetRemoveExchange();
  assert.equal(page.el('removeChip').classList.contains('is-confirm'), false);
  assert.equal(page.el('transcript').classList.contains('is-remove-confirm'), false);
});

test('busy, Multi and an unavailable boundary hide the chip', () => {
  let page = reset({ busy: true });
  renderTranscript();
  assert.equal(page.el('removeChip').hidden, true);

  page = reset({ mode: 'multi' });
  renderTranscript();
  assert.equal(page.el('removeChip').hidden, true);

  page = reset({ available: false });
  renderTranscript();
  assert.equal(page.el('removeChip').hidden, true);
  assert.doesNotMatch(page.el('transcript').innerHTML, /data-remove-target/);
});
