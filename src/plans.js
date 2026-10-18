// The project's plan: a plain JSON file the Architect owns, inside the project.
//
//   <project>\.synapse\plan.json
//
// The plan is *intent*, written by the Architect with the ordinary file tools it
// already has - there is no tool for it and no store in Synapse, because the
// file is the single source of truth. Synapse only ever **reads** it (for the
// rail pane and for briefing a session); it never rewrites it, so the Architect
// stays the one and only writer. If the file is malformed we do not repair it -
// we hand the Architect the precise problem and let it fix its own document.
//
// Everything here is therefore tolerant by design: reading never throws, and a
// bad file produces `problems` and `error` for a human to see rather than an
// exception nobody can act on.
//
// A companion file, `.synapse\runs.jsonl`, holds the harness's own record of
// what actually ran. That is evidence, not intent, and the harness owns it - so
// the two never have to be written by the same party.
import fs from 'node:fs';
import path from 'node:path';

// The roles the topology has cards for.
export const ROLES = ['architect', 'critic', 'coder-1', 'designer', 'coder-2', 'auditor', 'coder-3'];

// `blocked` is the one that matters: the work cannot proceed without the
// operator, which is why it is the one painted red.
export const STATUSES = ['todo', 'doing', 'done', 'blocked', 'failed'];

export const PLAN_DIR = '.synapse';
export const PLAN_NAME = 'plan.json';
export const RUNS_NAME = 'runs.jsonl';

/** The instruction-entry key the brief is attached to, per session. */
export const BRIEF_KEY = 'synapse.plan';

export const planPath = (dir) => path.join(String(dir || ''), PLAN_DIR, PLAN_NAME);
export const runsPath = (dir) => path.join(String(dir || ''), PLAN_DIR, RUNS_NAME);
export const planRelPath = () => `${PLAN_DIR}\\${PLAN_NAME}`;
/** The same path for text the models read: forward slashes, because a lone
 *  backslash inside a JSON string is an invalid escape and models copy what
 *  they are shown. (A plan file once came back unreadable for exactly that.) */
export const planRelPathPlain = () => `${PLAN_DIR}/${PLAN_NAME}`;

/** The empty file a project starts with. Valid as it stands, so the first read
 *  is never an error and the Architect has the shape in front of it. */
export const emptyPlan = () => ({ version: 1, goal: '', tasks: [] });

/**
 * Create `.synapse\plan.json` when it is missing. This is the one write Synapse
 * does, it happens before anyone owns the file, and it never touches an
 * existing plan.
 */
export function ensurePlan(dir) {
  const target = planPath(dir);
  try {
    if (fs.existsSync(target)) return { path: target, created: false };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(emptyPlan(), null, 2)}\n`, 'utf8');
    return { path: target, created: true };
  } catch (err) {
    return { path: target, created: false, error: err.message };
  }
}

const asText = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));
const asId = (v) => asText(v).replace(/[^A-Za-z0-9._-]/g, '');

// A title long enough to be a paragraph is a plan that cannot be read at a
// glance. We do not trim it — the Architect is told, and trims it itself.
const TITLE_MAX = 80;

/**
 * Log a plan's state, once per change and never twice.
 *
 * Synapse reads the plan on every poll and on every turn, so a naive log would
 * repeat the same sentence every few seconds. The signature is the state, and
 * the logger only hears about a state it has not already reported.
 */
const logged = new Map(); // project dir -> last signature
export function logPlanState(state, log) {
  if (!log || !state) return;
  const dir = state.dir || '';
  // Nothing to say about a session that is not in a directory.
  if (!dir) return;
  const issues = state.error || state.problems.join(' | ');
  const statuses = (state.plan?.tasks || []).map((t) => `${t.id || '?'}:${t.status}`).join(' ');
  const signature = `${issues}::${statuses}`;
  const previous = logged.get(dir);
  if (previous === signature) return;
  logged.set(dir, signature);

  if (state.error) log.warn(`plan ${state.relative} unreadable (${dir}): ${state.error}`);
  else if (state.problems.length) {
    log.warn(`plan ${state.relative} has problems (${dir}): ${state.problems.join('; ')}`);
  }
  if (previous === undefined) {
    if (!issues) log.info(`plan (${dir}): ${statuses || 'empty'}`);
    return;
  }
  if (!issues) log.info(`plan changed (${dir}): ${statuses || 'empty'}`);
}

/**
 * Read a project's plan. Never throws: a missing file, bad JSON or a wrong
 * shape all come back as data the UI can explain.
 */
export function readPlan(dir) {
  const target = planPath(dir);
  const base = {
    dir: String(dir || ''),
    path: target,
    relative: planRelPath(),
    exists: false,
    plan: null,
    problems: [],
    error: null,
    mtime: null,
    stat: null,
  };
  let raw;
  let stat;
  try {
    stat = fs.statSync(target);
    raw = fs.readFileSync(target, 'utf8');
  } catch (err) {
    // Missing is the normal case for a folder nobody has planned in yet.
    if (err.code === 'ENOENT') return base;
    return { ...base, error: `could not read the plan file: ${err.message}` };
  }

  const problems = [];
  let parsed;
  try {
    parsed = JSON.parse(raw || '{}');
  } catch (err) {
    return {
      ...base,
      exists: true,
      mtime: stat.mtimeMs,
      stat: { size: stat.size, mtime: stat.mtimeMs },
      error: `plan.json is not valid JSON: ${err.message}`,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ...base,
      exists: true,
      mtime: stat.mtimeMs,
      stat: { size: stat.size, mtime: stat.mtimeMs },
      error: 'plan.json must contain a single JSON object',
    };
  }

  const goal = asText(parsed.goal);
  const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : null;
  if (rawTasks === null) problems.push('"tasks" is missing or is not an array');

  const seen = new Set();
  const tasks = (rawTasks || []).map((t, i) => {
    const where = `task ${i + 1}`;
    const source = t && typeof t === 'object' ? t : {};
    const id = asId(source.id);
    if (!id) problems.push(`${where} has no id - give every task a short unique id like "t1"`);
    else if (seen.has(id)) problems.push(`${where} repeats the id "${id}"`);
    else seen.add(id);

    const title = asText(source.title);
    if (!title) problems.push(`${where} has no title`);
    else if (title.length > TITLE_MAX) {
      problems.push(`${where}'s title is ${title.length} characters - keep titles under ${TITLE_MAX}`);
    }

    const role = asText(source.role) || 'architect';
    if (source.role && !ROLES.includes(role)) {
      problems.push(`${where} names an unknown role "${role}" (cards: ${ROLES.join(', ')})`);
    }

    const rawStatus = asText(source.status) || 'todo';
    const status = STATUSES.includes(rawStatus) ? rawStatus : 'todo';
    if (!STATUSES.includes(rawStatus)) {
      problems.push(`${where} has an unknown status "${rawStatus}" - showing it as todo`);
    }

    return {
      id: id || null,
      title: title || '(untitled)',
      role,
      status,
      rawStatus,
      detail: asText(source.detail) || null,
      dependsOn: Array.isArray(source.dependsOn) ? source.dependsOn.map(asText).filter(Boolean) : [],
      result: asText(source.result) || null,
      note: asText(source.note) || null,
    };
  });

  return {
    ...base,
    exists: true,
    mtime: stat.mtimeMs,
    stat: { size: stat.size, mtime: stat.mtimeMs },
    problems,
    plan: { version: Number(parsed.version) || 1, goal, tasks },
  };
}

/** A cheap change fingerprint, so the harness can tell that something wrote to
 *  the plan when it should not have. */
export function planFingerprint(dir) {
  try {
    const s = fs.statSync(planPath(dir));
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return null;
  }
}

/**
 * The harness's own record of what ran: one JSON object per line, append-only.
 *
 * Deliberately NOT part of the plan. The plan is intent and the Architect owns
 * it; this is evidence and the harness owns it, so neither has to be written by
 * the other's owner. It is also how a delegation survives a restart: a request
 * already answered is in here by its tool-call id, so it is never run twice.
 */
export function appendRun(dir, entry) {
  const target = runsPath(dir);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${JSON.stringify({ at: Date.now(), ...entry })}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Every run line recorded for a project. Malformed lines are skipped. */
export function readRuns(dir) {
  try {
    return fs
      .readFileSync(runsPath(dir), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

const counts = (tasks) => {
  const out = {};
  for (const t of tasks) out[t.status] = (out[t.status] || 0) + 1;
  return out;
};

/**
 * The brief handed to a session through the engine's instruction entries.
 *
 * Kept short on purpose: it is re-read on every step, and a wall of text gets
 * skimmed. Facts first (what the plan currently says), then the one rule that
 * cannot be guessed (the Architect owns the file; nobody else writes it).
 */
export function briefSession({ dir, role = 'architect', auto = false } = {}) {
  const state = readPlan(dir);
  const lines = [];
  const isArchitect = role === 'architect';

  lines.push(`Synapse project: ${path.basename(String(dir || '')) || 'unknown'}`);
  lines.push(
    isArchitect
      ? `Project plan: ${planRelPathPlain()} - you own this file and you are the only role that may write it. ` +
          `Read it when a session starts, and keep it current as work lands. To get a task done, hand it to ` +
          `its role with the delegate tool and wait for the report; do not do the work yourself.`
      : `Project plan: ${planRelPathPlain()} - read-only for you. Never write to it, and never create files in ${PLAN_DIR}/. ` +
          `Your task is in the message you were given; do only that task.`,
  );

  if (!state.exists) {
    lines.push(`The plan file does not exist yet.`);
  } else if (state.error) {
    lines.push(`The plan file cannot be read - ${state.error}. Fix the file before continuing.`);
  } else if (!state.plan.tasks.length) {
    lines.push(`The plan is empty. Write it early: a "goal" line, then ordered tasks.`);
  } else {
    const c = counts(state.plan.tasks);
    const parts = [`${state.plan.tasks.length} task(s)`];
    for (const s of ['done', 'doing', 'blocked', 'failed', 'todo']) if (c[s]) parts.push(`${c[s]} ${s}`);
    lines.push(`Current plan: ${parts.join(', ')}.`);
    if (state.plan.goal) lines.push(`Goal: ${state.plan.goal}`);
    const blocked = state.plan.tasks.filter((t) => t.status === 'blocked' || t.status === 'failed');
    for (const t of blocked.slice(0, 4)) {
      lines.push(`  ${t.id || '?'} ${t.status}: ${t.title}${t.note ? ` - ${t.note}` : ''}`);
    }
    if (state.problems.length) lines.push(`Plan problems to fix: ${state.problems.slice(0, 4).join('; ')}`);
  }

  if (isArchitect) {
    lines.push(
      `Format: {"version":1,"goal":"...","tasks":[{"id":"t1","title":"...","role":"coder-1","status":"todo",` +
        `"detail":"...","dependsOn":[],"result":null,"note":null}]} - ` +
        `statuses: ${STATUSES.join(', ')}. Keep ids short and unique, titles under ${TITLE_MAX} characters, ` +
        `and mark a task "blocked" only when it needs the operator.`,
    );
    lines.push(
      auto
        ? `Keep building is ON: after each worker report, judge it and delegate the next task whose ` +
            `dependencies are done. Continue until every task is done or one is blocked - do not stop to ` +
            `ask between tasks.`
        : `Keep building is OFF: run one task at a time. After a report, judge it and stop, waiting for ` +
            `the operator to say go on.`,
    );
    lines.push(
      `Write paths inside the file with forward slashes (bin/, src/) so the JSON stays valid, ` +
        `and keep the file valid JSON - Synapse reads it on every turn.`,
    );
    lines.push(`Deliverables go in bin/ inside the project folder; everything else there is scratch.`);
  }

  return lines.join('\n');
}

