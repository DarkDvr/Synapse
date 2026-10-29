// The forms half of Full auto: a form nobody answers is answered after the
// configured wait (20 seconds by default) with the recommended (or top) option.
// It runs on the server, so a closed browser cannot stop it; it must answer once
// and never retry a failure in a loop.
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

test('full auto answers a form after its wait, with the recommended option', async () => {
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

test('a zero wait answers on the next sweep', async () => {
  let now = 1000;
  const { engine, replies } = fake();
  const auto = createFormAuto({ engine, logger: quiet, getTimeoutMs: () => 0, now: () => now });
  auto.setFullAuto('ses_1', true);
  await auto.tick();
  assert.equal(replies.length, 1, 'no wait when the setting is zero');
  assert.deepEqual(replies[0], { sessionId: 'ses_1', formId: 'f1', answer: { q: 'a' } });
});

test('the default wait is 20 seconds', async () => {
  let now = 1000;
  const { engine, replies } = fake();
  const auto = createFormAuto({ engine, logger: quiet, now: () => now });
  auto.setFullAuto('ses_1', true);
  await auto.tick();
  now += 19_000;
  await auto.tick();
  assert.equal(replies.length, 0, 'not before 20 seconds');
  now += 2_000;
  await auto.tick();
  assert.equal(replies.length, 1, 'answered after 20 seconds');
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

// The worker's question belongs to the chat the operator switched Full auto on;
// the worker session itself carries no such flag. Before 30 Oct this form sat
// under a card that promised an answer and never got one.
const workerForm = () => ({
  id: 'fw',
  sessionID: 'ses_worker',
  title: 'Which one?',
  fields: [{ key: 'q', type: 'string', options: [{ label: 'A (Recommended)', value: 'a' }] }],
});

test('full auto on the chat answers a worker form in the same project', async () => {
  const replies = [];
  const engine = {
    async listForms() { return [workerForm()]; },
    async getSession(id) { return { id, directory: 'F:/dev/Synapse.Projects/demo', metadata: { synapse: {} } }; },
    async replyForm(sessionId, formId, answer) { replies.push({ sessionId, formId, answer }); },
  };
  const auto = createFormAuto({ engine, logger: quiet, getTimeoutMs: () => 0 });
  auto.setFullAuto('ses_arch', true, 'F:/dev/Synapse.Projects/demo');
  await auto.tick();
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0], { sessionId: 'ses_worker', formId: 'fw', answer: { q: 'a' } });
});

test('turning full auto off on the chat overrides a worker saved with it on', async () => {
  const replies = [];
  const engine = {
    async listForms() { return [workerForm()]; },
    async getSession(id) {
      return { id, directory: 'F:/dev/Synapse.Projects/demo', metadata: { synapse: { fullAuto: true } } };
    },
    async replyForm(sessionId, formId, answer) { replies.push(answer); },
  };
  const auto = createFormAuto({ engine, logger: quiet, getTimeoutMs: () => 0 });
  auto.setFullAuto('ses_arch', false, 'F:/dev/Synapse.Projects/demo');
  await auto.tick();
  assert.equal(replies.length, 0, 'the project switch says off');
});
