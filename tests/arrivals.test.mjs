// A line that arrives slides in, and one that was already there does not move.
//
// The transcript is rebuilt from one string on every delta, so "new" is a comparison of
// row names before and after the draw — that is what this file tests, not the animation
// itself (a picture would be needed for that; the CSS is one keyframe).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installPage } from './fake-page.mjs';

installPage();
const { renderMessage, planArrivals } = await import('../web/transcript.js');
const { renderTrace } = await import('../web/traces.js');

test('a post and its parts carry the name the slide is keyed on', () => {
  const user = renderMessage({ id: 'm1', type: 'user', text: 'go', created: 1 });
  assert.match(user, /data-line="msg:m1"/, 'a message has no name, so a new one could not slide');

  const post = renderMessage(
    {
      id: 'm2',
      type: 'assistant',
      created: 2,
      parts: [
        { type: 'reasoning', text: 'thinking', _k: 'm2:0' },
        { type: 'text', text: 'Done.', _k: 'm2:1' },
        { type: 'tool', name: 'read', input: {}, status: 'completed', _k: 'm2:2' },
      ],
    },
    '',
  );
  assert.match(post, /data-line="msg:m2"/);
  assert.match(post, /data-line="part:m2:0"/, 'a reasoning line has no name');
  assert.match(post, /data-line="part:m2:1"/, 'an answer has no name');
  assert.match(post, /data-tool-card="m2:2"/, 'a tool card has no name');
});

test('a worker trace names the lines that arrive, and not the ones folded away', () => {
  const notes = [];
  for (let i = 0; i < 6; i += 1) notes.push({ at: i, text: `step ${i}` });
  notes.push({ at: 10, steer: true, text: 'watch the labels' });
  const html = renderTrace({ key: 'k1', role: 'coder-1', task: 't1', startedAt: 1, notes });
  assert.match(html, /data-line="k1:n:5:/, 'the newest step has no name');
  assert.match(html, /data-line="k1:n:10:/, 'a steer has no name');
  assert.doesNotMatch(html, /data-line="k1:n:0:/, 'a step inside the older-entries fold was named');
});

test('a new row slides; a new row inside a new row does not', () => {
  const before = ['line:msg:a', 'line:part:a:0'];
  const plan = planArrivals(
    [
      { key: 'line:msg:a', holder: '' },
      { key: 'line:part:a:0', holder: 'line:msg:a' },
      { key: 'line:msg:b', holder: '' },
      { key: 'line:part:b:0', holder: 'line:msg:b' },
      { key: 'line:part:a:1', holder: 'line:msg:a' },
    ],
    before,
    1000,
  );
  assert.equal(plan.get('line:msg:b'), 0, 'a new post does not slide');
  assert.equal(plan.has('line:part:b:0'), false, 'a part slides on top of its post, which reads as a shake');
  assert.equal(plan.get('line:part:a:1'), 0, 'a new part in an old post does not slide');
});

test('a row rebuilt mid-slide keeps its place in the slide', () => {
  planArrivals([{ key: 'line:msg:slow', holder: '' }], [], 2000);
  const later = planArrivals([{ key: 'line:msg:slow', holder: '' }], ['line:msg:slow'], 2120);
  assert.equal(later.get('line:msg:slow'), 120, 'the second draw restarted the slide instead of continuing it');
  const done = planArrivals([{ key: 'line:msg:slow', holder: '' }], ['line:msg:slow'], 2300);
  assert.equal(done.has('line:msg:slow'), false, 'the slide did not let go');
});

// The page's own echo and the post it opens for a turn are replaced by the engine's
// message a few hundred milliseconds later. That is one row, not two arrivals.
test('the engine replacing a row that is already sliding does not dip it again', () => {
  planArrivals([{ key: 'line:msg:local-7', holder: '' }], [], 5000);
  const swapped = planArrivals([{ key: 'line:msg:engine-x', holder: '' }], ['line:msg:local-7'], 5120);
  assert.equal(swapped.get('line:msg:engine-x'), 120, 'the successor started again instead of continuing');
});

test('a settled row replaced in its own place does not start sliding', () => {
  const plan = planArrivals([{ key: 'line:msg:fresh', holder: '' }], ['line:msg:settled'], 6000);
  assert.equal(plan.size, 0, 'a row that took the place of a settled row slid in from nothing');
});

test('a catch-up draw is not a wave of slides', () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ key: `line:many:${i}`, holder: '' }));
  const plan = planArrivals(rows, [], 3000);
  assert.equal(plan.size, 0, 'nine rows at once is a chat catching up, and each one faded in');
});
