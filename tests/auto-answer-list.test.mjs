// Auto-Answer's bug, and the shape of the fix.
//
// Found 3 Nov: the sweep asked `GET /api/form` with the workspace as its directory,
// and the engine scopes that list by the request's directory — so the answer was
// always an empty array and no form was ever seen. The same sweep pointed at the
// form's own directory answered at once. The server now hands the sweep a provider
// that asks every known session (src/api.js), and this test pins both halves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFormAuto } from '../src/form-auto.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const form = {
  id: 'frm_1',
  sessionID: 'ses_1',
  title: 'Pick one color',
  fields: [
    {
      key: 'q0',
      type: 'string',
      options: [
        { value: 'Red', label: 'Red' },
        { value: 'Orange', label: 'Orange' },
      ],
    },
  ],
};

function fake({ perSession = { ses_1: [form] } } = {}) {
  const replies = [];
  return {
    replies,
    engine: {
      // Exactly the engine's behaviour: the list is scoped, so the bare call is empty.
      listForms: async (sessionId) => (sessionId ? perSession[sessionId] || [] : []),
      getSession: async (id) => ({
        id,
        directory: 'F:/dev/Synapse.Projects/demo',
        metadata: { synapse: { automation: { autoAnswer: true } } },
      }),
      replyForm: async (sessionId, formId, answer) => {
        replies.push({ sessionId, formId, answer });
        return { ok: true };
      },
    },
  };
}

test('without a provider the scoped list is empty — the bug that was reported', async () => {
  const { engine } = fake();
  const auto = createFormAuto({ engine, getTimeoutMs: () => 0 });
  assert.deepEqual(await auto.tick(), { answered: 0, waiting: 0 });
});

test('with the server’s provider it finds and answers the form', async () => {
  const { engine, replies } = fake();
  const auto = createFormAuto({
    engine,
    listForms: async () => engine.listForms('ses_1'),
    getTimeoutMs: () => 0,
  });
  const first = await auto.tick();
  assert.equal(first.answered, 1);
  assert.deepEqual(replies, [{ sessionId: 'ses_1', formId: 'frm_1', answer: { q0: 'Red' } }]);
  // The form is gone from the engine's list; a second sweep has nothing to do.
  assert.deepEqual(await auto.tick(), { answered: 0, waiting: 0 });
});

test('the server asks every session, and passes that provider in', () => {
  const api = read('src/api.js');
  assert.match(api, /listForms: formsEverywhere/, 'the sweep is given the provider');
  const fn = /async function formsEverywhere\(\) \{([\s\S]*?)\n  \}/.exec(api);
  assert.ok(fn, 'formsEverywhere exists');
  assert.match(fn[1], /engine\.listSessions\(\)/, 'known sessions');
  assert.match(fn[1], /engine\.listActiveSessions\(\)/, 'and any turn that is running');
  assert.match(fn[1], /engine\.listForms\(id\)/, 'asked per session, never once from the root');
  assert.doesNotMatch(fn[1], /engine\.listForms\(\)/, 'the bare call is the bug');
});
