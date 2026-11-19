// The switch between the two chats: one address, one line, no half-switched page.
//
// The rebuild is a preview — `?chat=v2` draws the conversation with the new renderer, and
// everything else on the page runs the path it always ran. What is worth a test is not the
// drawing (the lab does that) but the switch itself: the old chat is the default, a typo in
// the address is not a switch, and a page that asked for the rebuild but never mounted it
// still draws a chat rather than nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installPage } from './fake-page.mjs';

/** Load the switch with the address the page would have. */
async function withAddress(search) {
  const page = installPage();
  page.window.location.search = search;
  const module = await import('../web/chat-render.js');
  return { page, module };
}

test('the old chat is what the app draws, unless the address asks for the rebuild', async () => {
  const plain = await withAddress('');
  assert.equal(plain.module.chatRenderer(), 'v1');
  assert.equal(plain.module.chatIsV2(), false);

  const asked = await withAddress('?chat=v2');
  assert.equal(asked.module.chatRenderer(), 'v2');
  assert.equal(asked.module.chatIsV2(), true);
});

test('a misspelled address is not a switch', async () => {
  for (const search of ['?chat=v1', '?chat=V2', '?chat=v2x', '?chat=', '?Chat=v2']) {
    const { module } = await withAddress(search);
    assert.equal(module.chatRenderer(), 'v1', `${search} switched the chat`);
  }
});

test('a page that asked for the rebuild but mounted nothing still draws a chat', async () => {
  // The fallback is the point: a switch that fails silently leaves the operator with an
  // empty conversation and no way to tell whether the run or the page is broken.
  const { page, module } = await withAddress('?chat=v2');
  const { state } = await import('../web/state.js');
  const { transcriptWiring } = await import('../web/transcript.js');
  const { chatScrollWiring } = await import('../web/chat-scroll.js');
  const { tracesWiring } = await import('../web/traces.js');
  // The subset of app.js's boot wiring the old renderer needs to draw anything at all.
  transcriptWiring({ renderRoleActivity() {}, mountAskPost() {}, renderPermissions: () => '', compactPostOf: () => null });
  chatScrollWiring({ renderTranscript: module.renderTranscript, traceOf: () => null, currentRun: () => null, askHost: () => null });
  tracesWiring({ renderTranscript: module.renderTranscript });
  state.messages = [{ id: 'm1', type: 'assistant', created: 1, completed: 2, parts: [{ type: 'text', text: 'The report is on its way.' }] }];
  state.renderSig = '';
  module.renderTranscript();
  assert.match(page.el('transcript').innerHTML, /The report is on its way\./);
});
