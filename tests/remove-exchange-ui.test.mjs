// The delete control and what it marks: only the last exchange, only while the chat
// is idle, and only after the server has said the boundary is clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installPage } from './fake-page.mjs';

installPage();
const { state } = await import('../web/state.js');
const { renderTranscript, transcriptWiring } = await import('../web/transcript.js');
const { chatScrollWiring } = await import('../web/chat-scroll.js');
const {
  removeButtonHtml,
  previewRemoveExchange,
  endRemovePreview,
  removeExchangeClick,
  resetRemoveExchange,
} = await import('../web/remove-exchange.js');

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

test('the button is in the last message header, left of Reuse', () => {
  const page = reset();
  renderTranscript();
  const html = page.el('transcript').innerHTML;
  assert.equal((html.match(/data-remove-target="1"/g) || []).length, 2);
  assert.equal((html.match(/data-remove-msg=/g) || []).length, 1);
  assert.match(html, /data-remove-msg="u2"/);
  assert.doesNotMatch(html, /data-remove-msg="u1"/);
  const removeAt = html.indexOf('data-remove-msg="u2"');
  const reuseAt = html.indexOf('data-reuse-msg="u2"');
  assert.ok(removeAt >= 0 && removeAt < reuseAt, 'Remove sits before Reuse');
});

test('the button refuses to render for an earlier message', () => {
  reset();
  assert.equal(removeButtonHtml({ id: 'u1', type: 'user' }, true), '');
  assert.match(removeButtonHtml({ id: 'u2', type: 'user' }, true), /data-remove-msg="u2"/);
});

test('hover previews the posts in red', () => {
  const page = reset();
  renderTranscript();
  previewRemoveExchange();
  assert.equal(page.el('transcript').classList.contains('is-remove-preview'), true);
  endRemovePreview();
  assert.equal(page.el('transcript').classList.contains('is-remove-preview'), false);
});

test('a first click asks; reset returns the button to idle', () => {
  const page = reset();
  renderTranscript();
  removeExchangeClick();
  state.renderSig = '';
  renderTranscript();
  const asked = page.el('transcript').innerHTML;
  assert.match(asked, /Remove Exchange\?/);
  assert.match(asked, /is-confirm/);
  assert.equal(page.el('transcript').classList.contains('is-remove-confirm'), true);
  resetRemoveExchange();
  state.renderSig = '';
  renderTranscript();
  const idle = page.el('transcript').innerHTML;
  assert.match(idle, /Remove Exchange/);
  assert.doesNotMatch(idle, /Remove Exchange\?/);
  assert.equal(page.el('transcript').classList.contains('is-remove-confirm'), false);
});

test('busy, Multi and an unavailable boundary hide the button', () => {
  for (const options of [{ busy: true }, { mode: 'multi' }, { available: false }]) {
    const page = reset(options);
    renderTranscript();
    assert.doesNotMatch(page.el('transcript').innerHTML, /data-remove-msg/);
  }
});
