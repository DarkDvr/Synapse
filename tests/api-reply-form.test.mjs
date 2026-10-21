// Answering a question, end to end through the API surface.
//
// The bug this earns: `safe` — the "a read is allowed to fail" wrapper — was
// declared inside `pending` but used by `replyForm`, so every answer the operator
// gave threw `safe is not defined` and never reached the engine. The run sat
// blocked on a form nobody could answer. Two things have to hold, and neither one
// is the happy path: the reply is sent, and a *failed lookup* around it does not
// stop it.
import { createApi } from '../src/api.js';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const FORM = {
  id: 'frm_1',
  sessionID: 'ses_x',
  title: 'Input needed',
  fields: [{ key: '0', title: 'How should the report be structured?' }],
};

function harness({ listFormsThrows = false } = {}) {
  const sent = [];
  const warnings = [];
  const engine = {
    status: () => ({ ready: true, kind: 'stub' }),
    listForms: async () => {
      if (listFormsThrows) throw new Error('engine said no');
      return [FORM];
    },
    listPendingPermissions: async () => [],
    listActiveSessions: async () => [],
    replyForm: async (sessionId, formId, answer) => { sent.push({ sessionId, formId, answer }); },
  };
  const logger = {
    channel: () => ({
      info() {},
      debug() {},
      warn: (m) => warnings.push(m),
      error: (m) => warnings.push(m),
    }),
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
  });
  return { api, sent, warnings };
}

// ── the reply is sent ───────────────────────────────────────────
{
  const { api, sent, warnings } = harness();
  let threw = null;
  try {
    const out = await api.replyForm('ses_x', 'frm_1', { answer: { 0: 'Minimal pass/fail only' } });
    check('answering a form reports ok', out?.ok === true, JSON.stringify(out));
  } catch (err) {
    threw = err;
  }
  check('answering a form does not throw', !threw, threw?.message);
  check('the engine is given the answer', sent.length === 1 && sent[0].answer[0] === 'Minimal pass/fail only', JSON.stringify(sent));
  check('the session and form are the ones asked about', sent[0]?.sessionId === 'ses_x' && sent[0]?.formId === 'frm_1', JSON.stringify(sent[0]));
  check('a clean reply logs nothing', warnings.length === 0, warnings.join(' | '));
}

// ── a failed lookup around the reply is not fatal ────────────────
{
  const { api, sent, warnings } = harness({ listFormsThrows: true });
  let threw = null;
  try {
    await api.replyForm('ses_x', 'frm_1', { answer: { 0: 'yes' } });
  } catch (err) {
    threw = err;
  }
  check('a form list that fails does not stop the reply', !threw, threw?.message);
  check('the answer still reaches the engine', sent.length === 1, JSON.stringify(sent));
  check('and the failure is written down', warnings.some((w) => w.includes('engine said no')), warnings.join(' | '));
}

// ── pending shares the same wrapper ─────────────────────────────
{
  const { api } = harness({ listFormsThrows: true });
  let threw = null;
  let out = null;
  try {
    out = await api.pending('ses_x');
  } catch (err) {
    threw = err;
  }
  check('pending survives a failing form list', !threw, threw?.message);
  check('and reports an empty form list rather than nothing', Array.isArray(out?.forms) && out.forms.length === 0, JSON.stringify(out));
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
