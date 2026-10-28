// The forms half of Full auto: a form nobody answers is answered after a minute
// with the recommended (or top) option. It runs on the server, so a closed
// browser cannot stop it; it must answer once and never retry a failure in a loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFormAuto } from '../src/form-auto.js';

const quiet = { channel: () => ({ info() {}, warn() {} }) };
const form = () => ({
  id: 'f1',
  sessionID: 'ses_1',
  title: 'Which one?',
  fields: [{ key: 'q', type: 'string', options: [{ label: 'B', value: 'b' }, { label: 'A (Recommended)', value: 'a' }] }],
});

function fake({ forms = [form()], meta = {}, fail = false } = {}) {
  const replies = [];
  const engine = {
    async listForms() {
      return forms;
    },
    async getSession() {
      return { id: 'ses_1', metadata: { synapse: meta } };
    },
    async replyForm(sessionId, formId, answer) {
      if (fail) throw new Error('reply refused');
      replies.push({ sessionId, formId, answer });
    },
  };
  return { engine, replies };
}

test('full auto answers a form after the minute, with the recommended option', async () => {
  let now = 1000;
  const { engine, replies } = fake();
  const seenAnswers = [];
  const auto = createFormAuto({
    engine,
    logger: quiet,
    timeoutMs: 60_000,
    now: () => now,
    onAnswered: (r) => seenAnswers.push(r),
  });
  auto.setFullAuto('ses_1', true);

  await auto.tick();
  assert.equal(replies.length, 0, 'not before the minute');
  now += 59_000;
  await auto.tick();
  assert.equal(replies.length, 0, 'still within the minute');
  now += 2_000;
  await auto.tick();
  assert.equal(replies.length, 1, 'answered after it');
  assert.deepEqual(replies[0], { sessionId: 'ses_1', formId: 'f1', answer: { q: 'a' } });
  assert.equal(seenAnswers.length, 1, 'the caller records the answer');

  await auto.tick();
  assert.equal(replies.length, 1, 'a settled form is not answered twice');
});

test('full auto is off unless the session says so', async () => {
  let now = 1000;
  const { engine, replies } = fake();
  const auto = createFormAuto({ engine, logger: quiet, timeoutMs: 60_000, now: () => now });
  await auto.tick();
  now += 120_000;
  await auto.tick();
  assert.equal(replies.length, 0);
});

test('a session saved with the timeout on is honoured, including the old key', async () => {
  let now = 1000;
  const { engine, replies } = fake({ meta: { permissionTimeout: true } });
  const auto = createFormAuto({ engine, logger: quiet, timeoutMs: 60_000, now: () => now });
  await auto.tick();
  now += 61_000;
  await auto.tick();
  assert.equal(replies.length, 1);
});

test('a failed reply is not retried every tick', async () => {
  let now = 1000;
  const { engine, replies } = fake({ fail: true });
  const auto = createFormAuto({ engine, logger: quiet, timeoutMs: 60_000, now: () => now });
  auto.setFullAuto('ses_1', true);
  await auto.tick();
  now += 61_000;
  await auto.tick();
  now += 5_000;
  await auto.tick();
  assert.equal(replies.length, 0, 'the fake throws, so nothing was recorded');
});

test('flipping full auto on while a form is already waiting gives it the minute', async () => {
  let now = 1000;
  const { engine, replies } = fake();
  const auto = createFormAuto({ engine, logger: quiet, timeoutMs: 60_000, now: () => now });
  await auto.tick(); // seen, off
  now += 30_000;
  auto.setFullAuto('ses_1', true);
  await auto.tick();
  assert.equal(replies.length, 0, 'not immediately');
  now += 31_000;
  await auto.tick();
  assert.equal(replies.length, 1, 'a minute after it was seen');
});
