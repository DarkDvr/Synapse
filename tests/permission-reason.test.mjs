// Rejecting a request with a reason, through the API surface.
//
// The reply route drops a `message` (measured), so the engine can never carry the
// operator's sentence with the decision. Synapse's channel to a worker is a
// synthetic message beside the tool result, which is what this asserts: a reject
// with a reason tells the role, one without a reason still refuses, an allow tells
// nobody anything, and a second view answering an already-answered card does not
// send the note twice.
import { createApi } from '../src/api.js';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const REQUEST = {
  requestId: 'per_1',
  sessionId: 'ses_worker',
  toolCallId: 'call_1',
  role: 'coder-1',
  scope: 'outside',
  action: 'edit',
  resources: ['D:/notes.txt'],
};

function harness({ entry = REQUEST, replyThrows = null } = {}) {
  const replied = [];
  const synthetic = [];
  const answered = [];
  const engine = {
    status: () => ({ ready: true, kind: 'stub' }),
    getSession: async (id) => ({ id, directory: null }),
    listForms: async () => [],
    listPendingPermissions: async () => [],
    listActiveSessions: async () => [],
    replyPermission: async (sessionId, requestId, decision) => {
      if (replyThrows) throw replyThrows;
      replied.push({ sessionId, requestId, decision });
    },
    synthetic: async (sessionId, text, meta) => { synthetic.push({ sessionId, text, meta }); },
  };
  const logger = {
    channel: () => ({ info() {}, debug() {}, warn() {}, error() {} }),
  };
  const permissionLog = {
    get: (id) => (entry && id === entry.requestId ? { ...entry } : null),
    answer: (id, decision, by, note) => {
      answered.push({ id, decision, by, note });
      return { requestId: id, sessionId: entry?.sessionId, effect: decision === 'reject' ? 'deny' : 'allow', note };
    },
  };
  const api = createApi({
    getConfig: () => ({}),
    applyConfig: async () => {},
    engine,
    logger,
    getBootError: () => null,
    projects: {},
    toolStats: null,
    probe: null,
    modelCache: null,
    inspectModel: null,
    probeDir: null,
    runs: null,
    engineUpdate: null,
    restart: null,
    notify: null,
    guard: null,
    permissionLog,
    permissionGate: { remember() {} },
  });
  return { api, replied, synthetic, answered };
}

// Let the fire-and-forget synthetic land before reading it.
const settle = () => new Promise((r) => setTimeout(r, 10));

{
  const { api, replied, synthetic, answered } = harness();
  await api.permission('ses_worker', { requestId: 'per_1', decision: 'reject', reason: '  That file is\n generated.  ' });
  await settle();
  check('the reject reaches the engine', replied.length === 1 && replied[0].decision === 'reject', JSON.stringify(replied));
  check('the role is told why, in the operator’s words', synthetic.length === 1 && /They said: "That file is generated\."/.test(synthetic[0].text), synthetic[0]?.text);
  check('the sentence is labelled as a refusal', synthetic[0]?.meta?.description === 'permission refused', JSON.stringify(synthetic[0]?.meta));
  check('the transcript keeps the reason', answered[0]?.note === 'That file is generated.', JSON.stringify(answered[0]));
}

{
  const { api, synthetic } = harness();
  await api.permission('ses_worker', { requestId: 'per_1', decision: 'reject' });
  await settle();
  check('a rejection with no reason still tells the role it was declined', synthetic.length === 1 && /declined/.test(synthetic[0].text), synthetic[0]?.text);
  check('and invents no words for the operator', !/They said/.test(synthetic[0]?.text || ''), synthetic[0]?.text);
}

{
  // An allow has nothing to explain, and a note would be a message the operator
  // did not send.
  const { api, synthetic, answered } = harness();
  await api.permission('ses_worker', { requestId: 'per_1', decision: 'once', reason: 'ignored' });
  await settle();
  check('an allow sends no note', synthetic.length === 0, JSON.stringify(synthetic));
  check('and records no reason', answered[0]?.note === null, JSON.stringify(answered[0]));
}

{
  // The Architect is the operator's own chat: the note would be an extra turn,
  // and the operator can simply say it there.
  const { api, synthetic } = harness({ entry: { ...REQUEST, role: null } });
  await api.permission('ses_worker', { requestId: 'per_1', decision: 'reject', reason: 'not now' });
  await settle();
  check('the Architect is not sent a synthetic note', synthetic.length === 0, JSON.stringify(synthetic));
}

{
  // Two views, one card: the second answer is accepted, and must not re-send the
  // refusal to the worker.
  const { api, synthetic } = harness({ replyThrows: new Error('404 permission not found') });
  const out = await api.permission('ses_worker', { requestId: 'per_1', decision: 'reject', reason: 'no' });
  await settle();
  check('a late answer is not an error', out?.already === true, JSON.stringify(out));
  check('and does not tell the role twice', synthetic.length === 0, JSON.stringify(synthetic));
}

{
  // A model is a chat partner, not a trusted channel: the reason is bounded
  // before it becomes a prompt.
  const { api, synthetic } = harness();
  await api.permission('ses_worker', { requestId: 'per_1', decision: 'reject', reason: 'z'.repeat(900) });
  await settle();
  const text = synthetic[0]?.text || '';
  check('an over-long reason is cut to 300 characters', (text.match(/z/g) || []).length === 300, `${(text.match(/z/g) || []).length}`);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
