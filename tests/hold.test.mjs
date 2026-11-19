// "Hold the timers": a paused chat is an operator reading, and nothing may be decided for them
// while it stands still.
//
// Two things act after a delay on the operator's behalf — Auto-Answer answers a waiting form,
// and an unanswered permission card is allowed once when its timer runs out. Both must wait
// while the chat is paused, and both must resume, not expire, when it starts again. The hold is
// a deadline the page renews, so a closed page cannot leave the automation stuck off.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setHold, clearHold, isHeld } from '../src/hold.js';
import { createFormAuto } from '../src/form-auto.js';

const quiet = { channel: () => ({ info() {}, warn() {}, error() {}, debug() {} }) };
const form = () => ({
  id: 'f1',
  sessionID: 'ses_1',
  title: 'Which one?',
  fields: [{ key: 'q', type: 'string', options: [{ label: 'B', value: 'b' }, { label: 'A (Recommended)', value: 'a' }] }],
});

const fakeEngine = ({ forms = [form()] } = {}) => {
  const replies = [];
  return {
    replies,
    engine: {
      async listForms() {
        return forms;
      },
      async getSession() {
        return { id: 'ses_1', metadata: { synapse: { automation: { autoAnswer: true } } } };
      },
      async replyForm(sessionId, formId, answer) {
        replies.push({ sessionId, formId, answer });
      },
    },
  };
};

test('the hold is a deadline, and it expires by itself', async () => {
  clearHold();
  assert.equal(isHeld(), false);
  setHold(60);
  assert.equal(isHeld(), true);
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(isHeld(), false, 'a hold that is never renewed must end on its own');
  clearHold();
});

test('a hold is clamped to ten minutes, so a page cannot pin it forever', () => {
  const before = Date.now();
  const { until } = setHold(60 * 60_000);
  assert.ok(until - before <= 10 * 60_000 + 50, `a hold of an hour was accepted: ${until - before}`);
  clearHold();
  assert.equal(isHeld(), false);
});

test('the form sweep answers nothing while the timers are held, and answers once they are not', async () => {
  clearHold();
  let now = 1000;
  let held = true;
  const { engine, replies } = fakeEngine();
  const auto = createFormAuto({
    engine,
    logger: quiet,
    timeoutMs: 5_000,
    now: () => now,
    isHeld: () => held,
  });
  const first = await auto.tick();
  assert.equal(first.held, true, 'the sweep did not notice the hold');
  assert.equal(replies.length, 0, 'a form was answered while the chat was paused');

  // The operator finishes reading: the clock resumes where it stopped, so the form is still
  // inside its wait rather than instantly due.
  held = false;
  for (let i = 0; i < 4; i += 1) {
    now += 1_000;
    await auto.tick();
  }
  assert.equal(replies.length, 0, `the wait expired while it was held (now ${now})`);

  for (let i = 0; i < 30; i += 1) {
    now += 1_000;
    await auto.tick();
    if (replies.length) break;
  }
  assert.equal(replies.length, 1, 'the form was never answered after the pause ended');
  assert.deepEqual(replies[0].answer, { q: 'a' }, 'the recommended option was not taken');
});
