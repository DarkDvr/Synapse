// What the page actually renders, asked of the page's own code.
//
// These replace the "search the source for a phrase" style for the chat: the module is
// imported against a fake window and asked for the markup. A test that fails here means
// the page stopped doing something, not that a sentence moved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installPage } from './fake-page.mjs';

installPage();
const { state } = await import('../web/state.js');
const { renderTranscript, transcriptWiring, renderMessage } = await import('../web/transcript.js');
const { chatScrollWiring } = await import('../web/chat-scroll.js');
const { traceKeyOf } = await import('../web/traces.js');

// The five things app.js hands these modules at boot. A renderer that is missing one
// throws by design, so the test names them out loud rather than mocking them away.
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

/** A clean page: fresh elements, empty state, nothing left from the last case. */
const reset = (messages = []) => {
  const page = installPage();
  state.messages = messages;
  state.sessionId = 'ses_test';
  state.sessionTrace = { key: '', stream: null };
  state.traces = new Map();
  state.alarms = [];
  state.errors = [];
  state.leases = new Map();
  state.open = new Set();
  state.permissions = [];
  state.forms = [];
  state.renderSig = '';
  return page.el('transcript');
};

test('an empty chat says so, and a message is drawn', () => {
  const empty = reset([]);
  renderTranscript();
  assert.equal(empty.classList.contains('is-empty'), true, 'an empty chat is not marked empty');

  const page = reset([
    { id: 'm1', type: 'user', text: 'Build the settings gear', created: Date.now() },
    { id: 'm2', type: 'assistant', completed: true, created: Date.now(), parts: [{ type: 'text', text: 'It is done.' }] },
  ]);
  renderTranscript();
  const html = page.innerHTML;
  assert.match(html, /Build the settings gear/, 'the operator sentence is missing');
  assert.match(html, /It is done\./, 'the answer is missing');
  assert.match(html, /msg user/, 'the message has no speaker');
});

test('a persona mode note is drawn as a harness line, with its Compact action', () => {
  const page = reset([{ id: 'm0', type: 'user', text: 'work', created: Date.now() }]);
  state.modeNote = { at: Date.now(), kind: 'off', persona: 'Vekra' };
  renderTranscript();
  assert.match(page.innerHTML, /data-mode-note/);
  assert.match(page.innerHTML, /Vekra was the Single-mode persona/);
  assert.match(page.innerHTML, /data-mode-compact/);
  // Clicking back and forth replaces the one note in place; it never stacks.
  state.modeNote = { at: Date.now() + 1, kind: 'on', persona: 'Vekra' };
  renderTranscript();
  assert.equal((page.innerHTML.match(/data-mode-note/g) || []).length, 1);
  assert.match(page.innerHTML, /Vekra is back as the Single-mode persona/);
  state.modeNote = null;
  renderTranscript();
  assert.doesNotMatch(page.innerHTML, /data-mode-note/);
});

test('a worker trace renders its steer, its permission and one older-entries fold', async () => {
  const { renderTrace } = await import('../web/traces.js');
  const notes = [];
  for (let i = 0; i < 6; i += 1) notes.push({ at: i, text: `step ${i}` });
  notes.push({ at: 10, steer: true, text: 'watch the labels' });
  notes.push({ at: 11, pending: true, steer: true, text: 'and the margins' });
  notes.push({
    at: 12,
    perm: { effect: 'deny', asked: true, decidedBy: 'operator', action: 'shell', resolved: ['Stop-Process -Name python'], reason: 'outside the project' },
  });
  const html = renderTrace({ key: 'k', role: 'coder-1', task: 't6', startedAt: 1, notes });
  // Six steps and the permission line are the timeline; the four newest stay open, so
  // three entries fold together with nothing of their own to say which kind they were.
  assert.match(html, /Older entries \(3\)/, 'the older history is not one fold');
  assert.match(html, /step 0/, 'the folded history lost its first step');
  assert.match(html, /watch the labels/, 'the steer is missing');
  assert.match(html, /is-steer is-pending/, 'the pending steer is not marked');
  assert.match(html, /class="tool-perm state-pill err"/, 'the refused permission has no chip');
  assert.match(html, /outside the project/, 'the refusal reason is not in the tooltip');
});

test('a message renders its own text even when a picture is attached', () => {
  const html = renderMessage(
    { id: 'm3', type: 'user', text: 'look at this', created: Date.now(), files: [{ name: 'shot.png', mime: 'image/png' }] },
    '',
  );
  assert.match(html, /look at this/);
  assert.match(html, /shot\.png/, 'the attachment chip is missing');
  assert.ok(traceKeyOf({ dir: 'F:\\x', task: 't1' }), 'the trace key helper is usable from a test');
});

test('a report that grows inside a part is redrawn, not left at its first words', () => {
  // The report is text inside a part that already exists, so the "nothing changed"
  // signature must not be a part count: the count stayed the same while the report
  // grew, and on 18 Nov it was never redrawn under a question that had just opened.
  const messages = [
    { id: 'm1', type: 'assistant', created: Date.now(), parts: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'Done — and it ' }] },
  ];
  const page = reset(messages);
  renderTranscript();
  assert.match(page.innerHTML, /Done — and it/, 'the first words are missing');
  messages[0] = {
    ...messages[0],
    parts: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'Done — and it works. Both halves verified.' }],
  };
  renderTranscript();
  assert.match(page.innerHTML, /Both halves verified/, 'the grown text was not redrawn');
});

test('a post with no parts says "…" only when there is nothing to show yet', () => {
  // The page opens an assistant post on the turn's first token, before the engine has
  // written any part of it. The ellipsis tells the operator "this is coming"; once the
  // live thinking panel is in the post, the ellipsis would sit above the words it is
  // waiting for. This was a phrase test ("the source must contain `!(m.live && tail)`");
  // it is a render now (10 Nov).
  const waiting = renderMessage({ id: 'live', type: 'assistant', live: true, parts: [], created: Date.now() }, '');
  assert.match(waiting, /…/, 'an empty post with nothing below it lost its ellipsis');
  const streaming = renderMessage(
    { id: 'live', type: 'assistant', live: true, parts: [], created: Date.now() },
    '<div class="trace is-live is-own">thinking…</div>',
  );
  assert.match(streaming, /thinking…/, 'the live panel is missing from the post');
  assert.doesNotMatch(streaming, /class="msg-text">…</, 'the ellipsis is still above the live panel');
});
