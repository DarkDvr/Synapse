// Single mode is a chat, not this harness — and the brief has to say so even when
// the project is full of the harness's own paperwork.
//
// The failure this earns: a Multi session was switched to Single to ask for one
// small thing (copy the exe to a folder). The brief quoted the stored requirement
// — the whole Multi-mode campaign, "Continue work", an old issue list — and the
// model then opened .synapse/plan.json and decided from t21 whether the build was
// current, reporting on t18 and t20. Nothing was wrong with the answer; the model
// was still standing in a plan that was not this conversation's.
//
// So three things have to hold: the stored request is not quoted, a plan on disk
// is named only to be refused, and nothing in the Single brief calls it an
// Architect, a role, or a report. Multi must be untouched by all of it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { briefSession } from '../src/plans.js';
import { describeSkills } from '../src/skills.js';
import { createApi } from '../src/api.js';

const ROOT = path.join(os.tmpdir(), `synapse-single-brief-${process.pid}`);
const DIR = path.join(ROOT, 'project');
const quiet = { info() {}, debug() {}, warn() {}, error() {} };

const checks = [];
const expect = (label, ok, detail) =>
  checks.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  <- ${detail}` : ''}`);

const REQUIREMENT =
  'Build a Windows app with a graph.\n\n---\n\nYour work got interrupted, continue\n\n---\n\nContinue work';

const writePlan = () => {
  fs.mkdirSync(path.join(DIR, '.synapse'), { recursive: true });
  fs.writeFileSync(
    path.join(DIR, '.synapse', 'plan.json'),
    JSON.stringify({
      version: 1,
      goal: 'The old campaign goal',
      tasks: [{ id: 't21', title: 'Republish', role: 'coder-1', status: 'doing', detail: 'd' }],
    }),
    'utf8',
  );
};

try {
  fs.mkdirSync(path.join(DIR, '.synapse'), { recursive: true });
  fs.writeFileSync(path.join(DIR, '.synapse', 'requirement.md'), `# The operator's request\n\n${REQUIREMENT}\n`, 'utf8');

  // ── Single, in a project that carries the earlier task's paperwork ──
  writePlan();
  const single = briefSession({ dir: DIR, role: 'architect', single: true });
  expect('Single does not quote the stored requirement', !single.includes('Your work got interrupted'), single.slice(0, 200));
  expect('Single does not re-tell the operator its old request', !single.includes('The operator\'s request'));
  expect('Single names the plan only to refuse it', single.includes('plan.json') && single.includes('ignore it'));
  expect('and says the plan is not this conversation', single.includes('not for this conversation'));
  expect('Single says there is nothing to hand work to', single.includes('do not delegate'));
  expect('Single never calls it an Architect', !/architect/i.test(single));
  expect('Single does not describe a work list or a team', !/task list you own|worker|Delegate the/i.test(single));
  expect('Single keeps the question tool convention', single.includes('(Recommended)'));

  // ── Single in a project nobody has planned in: the plan is not mentioned ──
  const bare = path.join(ROOT, 'bare-project');
  fs.mkdirSync(bare, { recursive: true });
  const singleBare = briefSession({ dir: bare, role: 'architect', single: true });
  expect('no plan file, no plan line', !singleBare.includes('plan.json'), singleBare);
  expect('no plan file, still a single conversation', singleBare.includes('do not delegate'));

  // ── Multi is untouched by any of it ──
  const multi = briefSession({ dir: DIR, role: 'architect', single: false });
  expect('Multi still quotes the requirement', multi.includes('Your work got interrupted'));
  expect('Multi still points at the plan it owns', multi.includes('you own this file'));
  expect('Multi still has the judge, not build rule', multi.includes('You judge; you do not build'));
  expect('Multi does not carry the Single refusal', !multi.includes('do not delegate'));

  // ── the skills line stops speaking about roles and reports in a chat ──
  const cfg = { roles: { architect: { skills: ['visual-review'], mustLoad: ['visual-review'] } } };
  const roleSkills = describeSkills(cfg, 'architect');
  const chatSkills = describeSkills(cfg, 'architect', { chat: true });
  expect('the Architect skills line says judge and report', /judge the next piece of work/.test(roleSkills) && /your report/.test(roleSkills));
  expect('the Single skills line says neither', !/judge/.test(chatSkills) && !/your report/.test(chatSkills), chatSkills);
  expect('the Single skills line still names the skill', chatSkills.includes('visual-review'));

  // ── a Single turn does not write into the earlier task's requirement ──
  const before = fs.readFileSync(path.join(DIR, '.synapse', 'requirement.md'), 'utf8');
  const makeApi = (singleMode) => {
    const engine = {
      status: () => ({ ready: true, kind: 'stub' }),
      getSession: async (id) => ({ id, directory: DIR, single: singleMode }),
      setInstruction: async () => true,
      prompt: async () => ({}),
      getMessages: async () => [],
      listForms: async () => [],
      listPendingPermissions: async () => [],
      listActiveSessions: async () => [],
    };
    return createApi({
      getConfig: () => ({}),
      applyConfig: async () => {},
      engine,
      logger: { channel: () => quiet },
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
  };

  await makeApi(true).sendMessage('ses_chat', { text: 'Copy the exe to E:/Portable Software/Fever Tracker' });
  expect(
    'a Single message is not appended to the requirement',
    fs.readFileSync(path.join(DIR, '.synapse', 'requirement.md'), 'utf8') === before,
  );

  await makeApi(false).sendMessage('ses_multi', { text: 'Now build the settings screen' });
  const after = fs.readFileSync(path.join(DIR, '.synapse', 'requirement.md'), 'utf8');
  expect('a Multi message still is', after.includes('Now build the settings screen') && after.startsWith(before));
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}

console.log(checks.join('\n'));
const failed = checks.filter((c) => c.startsWith('FAIL')).length;
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
