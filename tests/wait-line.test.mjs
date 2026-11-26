// The waiting line is one node whose text is replaced in place. The renderer
// must draw the resolver's latest answer, not a second post and not a stale
// "Thinking…" behind a more specific state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installPage } from './fake-page.mjs';

installPage();
const { state } = await import('../web/state.js');
const { renderMessage } = await import('../web/transcript.js');

const livePost = () => ({
  id: 'local-live-test',
  type: 'assistant',
  live: true,
  created: 1_700_000_000_000,
  parts: [],
});

test('the live placeholder is the resolver line, with a hook for the timer', () => {
  state.wait = { phase: 'prefill', at: Date.now() - 10_000, read: 8192, total: 108553, elapsed: 10 };
  const html = renderMessage(livePost(), '');
  assert.match(html, /data-wait/);
  assert.match(html, /Reading prompt 8,192 \/ 108,553/);
  assert.doesNotMatch(html, />Thinking…</);
});

test('no state yet keeps the old honest placeholder', () => {
  state.wait = null;
  const html = renderMessage(livePost(), '');
  assert.match(html, /data-wait/);
  assert.match(html, />Thinking…</);
});

test('the line is one node, not a post of its own', () => {
  state.wait = { phase: 'waiting', at: Date.now(), detail: '', read: 0, total: 0, elapsed: 0 };
  const html = renderMessage(livePost(), '');
  assert.equal((html.match(/data-wait/g) || []).length, 1);
  assert.doesNotMatch(html, /Reading prompt/);
});
