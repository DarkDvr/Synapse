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
import { digest as projectDigest, DOC_RELATIVE } from './project-doc.js';
import { scratchDir } from './paths.js';

// The roles the topology has cards for, in card order. The `auditor` and the
// `critic` were retired: the Architect verifies its own delegations against the
// disk, so a second confirmation was redundant. The adversary slot is now **QC**
// (quality control): the role that reads the build the way a non-technical person
// will, and says where it confuses, clips or lies.
export const ROLES = ['architect', 'inventor', 'coder-1', 'designer', 'coder-2', 'qc', 'coder-3'];

/** Role ids that existed before a rename, mapped to the id that replaced them.
 *  A plan file is the Architect's, not ours, so old plans are translated as they
 *  are read rather than rewritten. */
const LEGACY_ROLE = { hacker: 'qc' };

// `blocked` is the one that matters: the work cannot proceed without the
// operator, which is why it is the one painted red.
export const STATUSES = ['todo', 'doing', 'done', 'blocked', 'failed'];

// A result with a "todo" status is the Architect's two writes landing one after
// the other: it records the result, then flips the status later in the same turn.
// Inside that gap the plan is half-written, not wrong, so the complaint waits
// until the file has stood still. Ten minutes, not ninety seconds: judging a
// report is itself a long turn — reading a 48 KB spec and six renders took one
// Architect turn past three minutes, and the note fired while it was still working.
const RESULT_STATUS_GRACE_MS = 10 * 60 * 1000;

// The origins a work item can have. `plan` is the list the Architect started
// with, `found` is something it noticed while the work was happening, and
// `operator` is work the operator asked for. The field is a fact about where the
// row came from, not a judgement of how important it is: a model asked to rate
// its own additions rates them all high, and a list that flags everything flags
// nothing.
export const ORIGINS = ['plan', 'found', 'operator'];

export const PLAN_DIR = '.synapse';
export const PLAN_NAME = 'plan.json';
export const RUNS_NAME = 'runs.jsonl';
export const FEATURES_NAME = 'features.json';

/** The instruction-entry key the brief is attached to, per session. */
export const BRIEF_KEY = 'synapse.plan';

// A read that lands inside a write is retried twice, 25 ms apart (see readPlan).
const PLAN_READ_TRIES = 3;
const PLAN_READ_WAIT_MS = 25;

/** Wait without yielding the thread: readPlan is synchronous by design. */
const sleepBriefly = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch { /* no SharedArrayBuffer: take the retry with no pause */ }
};

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

/**
 * Put one task's status back, and change nothing else.
 *
 * Used by the one moment the harness owns: the operator stopped a run, so a task
 * the Architect marked `doing` is not doing anything. Left alone it would say
 * "1 running" on the plan for the rest of the day. Everything else in the file is
 * the Architect's, so this reads, edits one field and writes the same shape back;
 * a file that does not parse is left exactly as it is.
 */
export function setTaskStatus(dir, taskId, status) {
  try {
    const file = planPath(dir);
    const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
    const task = (Array.isArray(plan?.tasks) ? plan.tasks : []).find((t) => t.id === taskId);
    if (!task || task.status === status) return false;
    task.status = status;
    fs.writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * The feature contract: what was asked for, what was rejected, and which task
 * delivers each confirmed item.
 *
 * The Architect writes it after the operator answers the feature question. Read
 * tolerantly, like the plan, and never repaired here: a confirmed feature that
 * no task claims is a problem the Architect is told about, because the whole
 * point of the file is that the promise and the plan cannot quietly disagree.
 */
export function readFeatures(dir, tasks = []) {
  const base = {
    exists: false,
    relative: `${PLAN_DIR}/${FEATURES_NAME}`,
    items: [],
    confirmed: [],
    rejected: [],
    problems: [],
    error: null,
  };
  const target = path.join(String(dir || ''), PLAN_DIR, FEATURES_NAME);
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return base;
    return { ...base, error: `could not read it: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw || '{}');
  } catch (err) {
    return { ...base, exists: true, error: `not valid JSON: ${err.message}` };
  }
  const rawItems = Array.isArray(parsed?.items) ? parsed.items : null;
  if (!rawItems) return { ...base, exists: true, problems: ['"items" is missing or is not an array'] };

  const problems = [];
  const seen = new Set();
  const taskIds = new Set(tasks.map((t) => t.id).filter(Boolean));
  const items = rawItems.map((source, i) => {
    const where = `item ${i + 1}`;
    const item = source && typeof source === 'object' ? source : {};
    const id = asText(item.id);
    if (!id) problems.push(`${where} has no id - give every feature one like "F1"`);
    else if (seen.has(id)) problems.push(`item ${i + 1} repeats the id "${id}"`);
    else seen.add(id);

    const title = asText(item.title);
    if (!title) problems.push(`${where} has no title`);

    const status = asText(item.status).toLowerCase() || 'confirmed';
    if (!['confirmed', 'rejected'].includes(status)) {
      problems.push(`${where} has an unknown status "${status}" - use confirmed or rejected`);
    }
    const task = asText(item.task) || null;
    if (status === 'confirmed') {
      if (!task) problems.push(`${where} ("${title || id}") is confirmed but names no task`);
      else if (!taskIds.has(task)) {
        problems.push(`${where} ("${title || id}") is confirmed for task "${task}", which is not in the plan`);
      }
    }
    return { id: id || null, title: title || '(untitled)', why: asText(item.why) || null, status, task, priority: asText(item.priority) || null };
  });

  return {
    ...base,
    exists: true,
    items,
    confirmed: items.filter((i) => i.status === 'confirmed'),
    rejected: items.filter((i) => i.status === 'rejected'),
    problems,
  };
}

// A title long enough to be a paragraph is a plan that cannot be read at a
// glance. We do not trim it — the Architect is told, and trims it itself.
const TITLE_MAX = 80;

// A title is the plan's human index: what the work is, not which file it lands
// in. A model that writes its own filenames into titles turns the pane into a
// list of paths, so a title that names a file is a problem the Architect fixes —
// the same loop that already repairs a malformed file. Both patterns are
// deliberately narrow: a bare slash is a perfectly good title ("Audit the
// UI/UX"), and only a name with a real extension, or a leading project-relative
// directory, counts as a path.
const FILEISH_TITLE = /[A-Za-z0-9_-]+\.[A-Za-z]{1,5}\b/;
const PATHISH_TITLE = /^(bin|src|web|docs|config)[\\/]/i;

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
  // A plan is replaced wholesale by the tool that writes it, so a read can land
  // inside that write and see half a document. Measured 24 Oct: two such reads in
  // one project, and the window is short enough that neither is a real fault. The
  // cost of believing it is worse than the wait - a delegation arriving in that gap
  // reads a plan with no tasks and is refused as "no such task", which the
  // Architect then has to argue with. So a failed parse gets two more tries, 25 ms
  // apart, and only then is the file called broken.
  for (let attempt = 0; attempt < PLAN_READ_TRIES; attempt += 1) {
    try {
      parsed = JSON.parse(raw || '{}');
      break;
    } catch (err) {
      if (attempt === PLAN_READ_TRIES - 1) {
        return {
          ...base,
          exists: true,
          mtime: stat.mtimeMs,
          stat: { size: stat.size, mtime: stat.mtimeMs },
          error: `plan.json is not valid JSON: ${err.message}`,
        };
      }
      sleepBriefly(PLAN_READ_WAIT_MS);
      try {
        raw = fs.readFileSync(target, 'utf8');
        stat = fs.statSync(target);
      } catch { /* the file went away; the next attempt says so */ }
    }
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
    } else {
      // Say what the work *is*. Naming the file is what the detail field is for.
      const file = title.match(FILEISH_TITLE);
      const hinted = file || title.match(PATHISH_TITLE);
      if (hinted) {
        problems.push(
          `${where}'s title names ${file ? 'a file' : 'a path'} ("${hinted[0]}") - say what the work is, ` +
            `and put the path in detail`,
        );
      }
    }

    // The role id, translated from names that no longer exist. The Hacker became
    // QC, and a plan written before the rename must keep working: translating on
    // read is cheaper and safer than asking the Architect to rewrite old plans.
    const rawRole = asText(source.role);
    const role = LEGACY_ROLE[rawRole] || rawRole || 'architect';
    if (source.role && !ROLES.includes(role)) {
      problems.push(`${where} names an unknown role "${role}" (cards: ${ROLES.join(', ')})`);
    }
    // The coders are a ladder, not a pool. Every build task is written for
    // coder-1 and the harness escalates on its own when that coder cannot do the
    // work (see candidatesFor in runs.js). A plan that names coder-2 or coder-3 is
    // spending a fallback rung on work the first coder could have done - in Shift
    // Test 4 the Architect spread six build tasks across all three coders.
    if (role === 'coder-2' || role === 'coder-3') {
      problems.push(
        `${where} is written for ${role}; build tasks are written for coder-1, and the harness moves a task to ` +
          `coder-2 then coder-3 by itself when the coder before it cannot do the job`,
      );
    }

    const rawStatus = asText(source.status) || 'todo';
    const status = STATUSES.includes(rawStatus) ? rawStatus : 'todo';
    if (!STATUSES.includes(rawStatus)) {
      problems.push(`${where} has an unknown status "${rawStatus}" - showing it as todo`);
    }
    // A half-written status: a result filled in while the task still says it has
    // not started. That happened live — test-project-3's t1 was given a full
    // `result` and left `todo`, so the pane showed a finished task as untouched
    // and the Architect's own message claimed it was done. The Architect owns the
    // file, so it is told, not repaired.
    //
    // Waiting for the file to settle is what separates the fault from the normal
    // two-step write: on the clock project this fired after every single run
    // (six for six) inside the 3-17s it took the Architect to flip the status,
    // and every one of those six was work that was already being finished.
    const result = asText(source.result) || null;
    const settled = Date.now() - stat.mtimeMs > RESULT_STATUS_GRACE_MS;
    if (result && settled && (status === 'todo' || status === 'doing')) {
      problems.push(
        `${where} has a result but its status is "${status}" - mark it done, or clear the result`,
      );
    }

    // Where the row came from. Tolerant on purpose: an unknown value is read as
    // `plan` rather than complained about, because the field exists to tell the
    // operator what appeared after they looked, not to be policed.
    const rawOrigin = asText(source.origin).toLowerCase();
    const origin = ORIGINS.includes(rawOrigin) ? rawOrigin : 'plan';

    // What the task points at. Only checked for the step in hand: a later task's
    // `reads` may name a file an earlier task has not written yet, and flagging
    // that would have the Architect rewriting a perfectly good plan.
    const reads = Array.isArray(source.reads) ? source.reads.map(asText).filter(Boolean) : [];
    if (status === 'doing') {
      for (const rel of reads) {
        const parts = rel.split(/[\\/]/);
        if (path.isAbsolute(rel) || parts.includes('..')) {
          problems.push(`${where} reads "${rel}", which must be a path inside the project`);
          continue;
        }
        try {
          if (!fs.statSync(path.join(dir, ...parts)).isFile()) problems.push(`${where} reads "${rel}", which is not a file`);
        } catch {
          problems.push(`${where} reads "${rel}", which does not exist`);
        }
      }
    }

    return {
      id: id || null,
      title: title || '(untitled)',
      role,
      status,
      rawStatus,
      origin,
      detail: asText(source.detail) || null,
      dependsOn: Array.isArray(source.dependsOn) ? source.dependsOn.map(asText).filter(Boolean) : [],
      reads,
      result,
      note: asText(source.note) || null,
    };
  });

  // Nothing is policed about the shape of the list. It is a work list and it grows
  // while the work happens — that is not a fault to name, it is the thing this
  // harness is for. What protects the operator is `features.json` (the scope) and
  // the brief's one-line announcement of each addition, not a rule that the list be
  // complete before anything starts. A task's `origin` is what records the
  // difference, and unknown values are read as `plan`: tolerance, as everywhere.

  // A finished plan owes the operator a customer-facing summary: the Architect's
  // card shows it once the work is done, instead of only a DONE chip. The Architect
  // writes it itself, so this is a note to it rather than something we invent.
  if (tasks.length && tasks.every((t) => t.status === 'done') && !asText(parsed.summary)) {
    problems.push(
      'the plan is finished but has no "summary" - add one sentence a customer would understand: ' +
        'what this project delivers, with no file paths and no tool names',
    );
  }

  // The feature contract lives beside the plan and is read the same way. Its
  // complaints join the plan's, so the Architect repairs both from one message.
  const features = readFeatures(dir, tasks);
  for (const p of features.problems) problems.push(`features.json: ${p}`);
  if (features.error) problems.push(`features.json: ${features.error}`);

  return {
    ...base,
    exists: true,
    mtime: stat.mtimeMs,
    stat: { size: stat.size, mtime: stat.mtimeMs },
    problems,
    features,
    plan: { version: Number(parsed.version) || 1, goal, summary: asText(parsed.summary), tasks },
  };}

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

// ── rounds, and the caps that belong to them ────────────────────
//
// A round ends when the Architect says the plan is done: every task `done` and
// the customer-facing summary written. That close is a `round` line in
// runs.jsonl, and the QC loop's three rounds and every task's three attempts are
// counted only after it. Without the boundary a long-lived project spent its
// whole QC quota on its first rounds, and a task id reused by every new plan
// reached the attempt cap although every attempt had succeeded.

export const QC_ROUNDS = 3;

/** The last "round closed" line in a project's run log, if any. */
function lastRoundClosed(history) {
  const list = history || [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].kind === 'round' && list[i].event === 'closed') return list[i];
  }
  return null;
}

/** The run log since that boundary: what this round has spent. */
export function sinceRoundClosed(history) {
  const list = history || [];
  let from = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].kind === 'round' && list[i].event === 'closed') from = i + 1;
  }
  return list.slice(from);
}

/** Completed QC rounds since the last finished plan. `hacker` is the role's old
 *  id, and rounds spent under it still count. */
export function qcRoundsUsed(dir) {
  return sinceRoundClosed(readRuns(dir)).filter(
    (r) => r.kind === 'result' && (r.role === 'qc' || r.role === 'hacker') && r.outcome === 'completed',
  ).length;
}

/**
 * Close the round the Architect has finished. One `round` line per finished
 * plan: if the plan has not changed since the last one, there is nothing to
 * close. A plan with tasks done but no summary is not closed — the summary is
 * how the Architect says "done".
 *
 * `readPlan().stat.mtime` is when the plan file last changed. The earlier
 * `mtimeMs` did not exist, so every close after the first returned false, and
 * the caps of a mature project never reset again.
 */
export function closeRound(dir) {
  if (!dir) return false;
  const read = readPlan(dir);
  const tasks = read?.plan?.tasks || [];
  if (!tasks.length || !tasks.every((t) => t.status === 'done')) return false;
  if (!String(read?.plan?.summary || '').trim()) return false;
  const mtime = Number(read?.stat?.mtime) || 0;
  const last = lastRoundClosed(readRuns(dir));
  // The marker carries the plan's exact mtime. Comparing the marker's wall-clock
  // `at` to the file's mtime raced by a millisecond (a plan written just before
  // the close could look newer), which made the "closed once" test flake and
  // could write a second marker for the same plan. Older markers carry no
  // `planMtime`; they fall back to the time comparison.
  if (last && (last.planMtime ? Number(last.planMtime) === mtime : Number(last.at) >= mtime)) return false;
  return appendRun(dir, { kind: 'round', event: 'closed', tasks: tasks.length, planMtime: mtime });
}

/**
 * What one session's own work cost, from the project's run log.
 *
 * The log is the project's, so a sum over all of it answers "what has anyone ever
 * spent on this task" — and that is not what a session's plan pane or a role card
 * may say. On 27 Oct a fresh session's plan had three rows, two of which had run
 * in an earlier session under the same ids; they opened already dashed (handed
 * back, waiting for review) and already carrying an hour of somebody else's time.
 * The same sum gave the QC card a clock while it stayed dimmed as unused, which
 * the operator read as two claims about one role.
 *
 * A result belongs to the session that asked for it. Newer records say so
 * themselves (`architect`); older ones are matched to their delegation by callId,
 * which every delegate record has carried since the log began — so this is a
 * lookup, not a migration.
 */
export function runLedger(records, sessionId) {
  // Only this round. Task ids are reused by every new plan (t1, t2, …), so a
  // t1 in the current plan must not carry the minutes of the previous plan's
  // t1 — the row showed 41s for a 12s run on 28 Oct. The round marker is the
  // boundary the caps already use.
  const list = sinceRoundClosed(Array.isArray(records) ? records : []);
  const asker = new Map();
  for (const r of list) {
    if (r && r.kind === 'delegate' && r.callId && r.architect) asker.set(r.callId, r.architect);
  }
  const spent = Object.create(null);
  const reported = new Set();
  for (const r of list) {
    if (!r || r.kind !== 'result' || !r.task) continue;
    const owner = r.architect || asker.get(r.callId) || null;
    // No session, no claim: an unattributed result belongs to nobody's view.
    if (!sessionId || owner !== sessionId) continue;
    const ms = Number(r.ms);
    if (Number.isFinite(ms) && ms > 0) spent[r.task] = (spent[r.task] || 0) + ms;
    if (r.outcome === 'completed') reported.add(r.task);
  }
  // Copied into a plain object at the end: the accumulator has no prototype (a
  // task id is content from a plan file, and `__proto__` is a legal-looking id),
  // while the payload the UI receives should behave like ordinary JSON.
  return { spent: { ...spent }, reported: [...reported] };
}

/**
 * Delegations a previous process left open.
 *
 * A `delegate` record is closed by a `result` with the same callId. A process
 * that dies mid-run leaves the delegate alone, and nothing is running after a
 * boot — so an open record is a worker that no longer exists. Records that carry
 * their own `outcome` (refused in Single mode, unknown task) are already settled.
 */
export function openDelegations(records) {
  const list = Array.isArray(records) ? records : [];
  const settled = new Set(
    list.filter((r) => r && r.kind === 'result' && r.callId).map((r) => r.callId),
  );
  return list.filter((r) => r && r.kind === 'delegate' && r.callId && !r.outcome && !settled.has(r.callId));
}

const counts = (tasks) => {
  const out = {};
  for (const t of tasks) out[t.status] = (out[t.status] || 0) + 1;
  return out;
};

/**
 * What each working role is for, in its own words.
 *
 * A worker's brief is its mandate plus where its output goes; it does not need
 * the plan's judgement rules, and three paragraphs about JSON shape would only
 * bury the one sentence that matters. Paths are written with forward slashes
 * because a lone backslash inside text a model copies into JSON is an invalid
 * escape (a plan file once came back unreadable for exactly that).
 */
const ROLE_MANDATES = {
  inventor: [
    'You are the Inventor. You generate and rank ideas; you do not design screens and you do not write application code.',
    'The request is often one sentence, and a sentence is not a specification. Imagine one real person on their first',
    'day with the thing: what they reach for first, what they forget to do, what they ask for the week after.',
    'Turn that into features a builder can put on the screen - each one a named, specific behaviour, small enough',
    'to describe in a sentence and sayable out loud the way a user would say it. Never hand back categories:',
    '"settings", "polish", "good UX" and "error handling" are not features. Stay in this project\'s own vocabulary,',
    'and take any illustration from what the operator actually asked for - never from another project\'s subject',
    'matter, because a borrowed example becomes the shape of the thing you propose.',
    'At least two of the features should be things the operator did not think to ask for, and every one must be',
    'defensible in a single sentence: what it saves the person, or what it stops them getting wrong. If a feature',
    'only makes sense because you imagined a user this project does not have, leave it out.',
    'Write the list to .synapse/ideas/ideas-1.md (create the folder): most valuable first, each item with a one-line',
    'reason it matters and an effort estimate (small, medium or large). After the list, say what you would leave out',
    'and why. Be opinionated - ten ideas of equal weight is not a ranking. Work from the operator\'s request and the',
    'project goal, and keep it to what this project can actually deliver.',
  ].join(' '),
  designer: [
    'You are the Designer. You decide how it looks - layout, palette, type, spacing, states - and you do not write',
    'application code. Write the spec to .synapse/design/design.md: a table of screens and their controls, the colour',
    'tokens as real values, and the values for each theme that was asked for. Then one self-contained mock per screen',
    'at .synapse/design/mock-1.html, mock-2.html and so on - plain HTML with inline CSS, static, opening at any width.',
    'Two mocks is the ceiling: the operator picks a direction, not a catalogue, and every extra one is another',
    'file to keep in step and another round of renders to look at. States of one screen belong in one mock behind',
    'a query flag (?state=night), not in a file each. The spec is what the builder is held to: tables and values,',
    'at the size a builder will actually use - a book about the design is not the design. Keep design.md under',
    'about 200 lines: every worker reads it before it starts, and you re-read it on every turn of this task.',
    'Stop when the spec is written and both mocks render at the sizes and states you were asked for. One pass of',
    'adjustment after the first render is worth having; after that you are tuning, not designing, and a value',
    'settled to two decimal places is not a design decision. If you measure the same thing twice, put the number',
    'in the spec and move on.',
  ].join(' '),
  qc: [
    'You are QC - quality control. You judge the build a real, non-technical person will meet, not the code:',
    'use it the way they will, then the way someone in a hurry will, and report what confuses them, misleads',
    'them, clips in front of them or stops them.',
    'Look for four things, in this order. (1) Wording: text, labels, buttons, errors and reports written in a',
    'coder\'s voice or in technical jargon, where the reader is an ordinary person. A message they cannot',
    'understand is a defect, not a nit - quote what it said and give the plain version. (2) Design flaws:',
    'clipped or overlapping text and controls, broken layout, unreadable contrast, at each size the project',
    'must support. (3) Missing input validation: anything a person can type or paste that crashes, is',
    'silently accepted, or produces a wrong answer. (4) Missing or dishonest states: no feedback where',
    'something happened, a status that is not true, work lost on refresh or on a second click.',
    'Do not fix anything and do not edit the build.',
    'Write the findings to .synapse/qc_findings/qc-1.md (create the folder): each with an id (Q1, Q2...), a',
    'severity (critical, major, minor, nice-to-have), the exact command and input that reproduces it, what',
    'happened and what should have happened. Then one line per area you checked, not a matrix. Batch: when',
    'you need several files or several probes, ask for them in one turn, and run a suite once per batch of',
    'changes rather than after every edit - every extra turn is a full round-trip, and everything you did',
    'stays in your context and is paid for again on every later turn.',
  ].join(' '),
  'coder-1': [
    'You are a Coder. Build exactly what the task names and nothing else: the plan, the confirmed features and the',
    'design are read-only to you. Work only inside the project folder. If you render the page to look at it, put the',
    `images in ${PLAN_DIR}/shots/ - it is the one folder inside ${PLAN_DIR} that every role may write. The design and`, 
    'findings folders belong to the roles that own them, and a render in one of those is reported as a stray write.',
    'Batch your tools: when you need several',
    'files or several searches, ask for them in one turn, and run the test suite once per batch of changes rather',
    'than after every edit - every extra turn is a full round-trip and everything you read stays in your context.',
  ].join(' '),
};

// How hard QC pushes. `app` is the default and the honest one for most projects:
// the ordinary person using the thing is what breaks a small tool or makes it
// confusing, and an hour of hostile-environment construction answers a question
// nobody asked. `security` is the same role with the gloves off, one setting away
// in the role card's ✎ dialog.
const QC_FOCUS = {
  app: [
    'Focus: the ordinary person, not an attacker. They type into this tool, read what it says, and give up if',
    'it does not make sense. Test empty and whitespace-only input, text where a number belongs, a very long',
    'line, accented letters and emoji, a missing file, the wrong file, a path with spaces, an option that does',
    'not exist, starting it from the wrong folder, pressing Enter twice, closing the window half-way. Then read',
    'every sentence the tool shows them and ask whether their mother would know what it means: jargon,',
    'abbreviations, the developer\'s words for things, and errors that name a variable instead of a fix are all',
    'findings. Judge what they would see on their own screen and machine: a crash, a wrong answer, silence',
    'where something should happen, a message nobody can understand, work lost. An edge that needs another',
    'hemisphere or a hand-edited constant is an observation, not a finding. Do not audit the security of the',
    'build: no hostile-environment construction, no locale or interpreter matrices, no fuzzing loops. If',
    'something looks genuinely dangerous, note it as an observation and move on.',
  ].join(' '),
  security: [
    'Focus: adversarial. Treat the build as hostile territory - try to make it lie, escape its folder, run',
    'something it should not, or lose data under duress. Hostile input, unusual encodings, broken output',
    'streams, missing permissions, and anything that would matter if this were exposed to someone trying to',
    'break it. Say plainly what you did not cover.',
  ].join(' '),
};

// A handful of the cases a real person hits beats an exhaustive matrix, in either
// focus: the report is read by a person who wants to know what to fix.
const QC_PROPORTION =
  'Keep it proportionate: the cases with the best chance of happening are worth more than a complete matrix, and ' +
  'the report is judged on what it found, not on how long it ran. A minor or nice-to-have finding is a note for ' +
  'the operator, not a reason for another fix round, and a re-run is a check of the ids already listed, not a ' +
  'second hunt.';

/** Where a role may write inside .synapse, and nowhere else there. */
const OWNED_DIR = {
  inventor: `${PLAN_DIR}/ideas`,
  designer: `${PLAN_DIR}/design`,
  qc: `${PLAN_DIR}/qc_findings`,
};

/** A folder every role may write: screenshots the visual-review skill produces. It
 *  used to point at `.synapse/design/shots/`, which is the Designer's folder — so a
 *  coder that rendered the page tripped the write rules and the harness alarm. */
export const SHARED_DIR = `${PLAN_DIR}/shots`;

/** The folder inside .synapse that a role owns, or '' for none. */
export function ownedFolder(role) {
  const dir = OWNED_DIR[role];
  return dir ? dir.split('/').pop() : '';
}

/**
 * Where a worker may write inside .synapse, enforced by the engine.
 *
 * Three measured facts (2.0.30) decide this shape:
 *
 *   - the rule is matched against the path *as the model wrote it*, so a
 *     relative rule `.synapse/**` refuses a relative path while an absolute
 *     rule does not; both forms are emitted because a model may write either;
 *   - `edit` is the action that covers both the `write` and the `edit` tools —
 *     `write` is not an action name at all (a rule on it denies nothing);
 *   - the last matching rule wins, so the role's own folder is allowed after the
 *     deny, exactly as the harness guard does it.
 *
 * This stops the file tools. It cannot stop `shell` or `execute`, which take a
 * command rather than a path — that is what synapseFingerprint/around-turn
 * detection is for.
 */
export function roleWriteRules(dir, role) {
  const root = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!root) return [];
  const owned = ownedFolder(role);
  const rules = [];
  for (const base of [PLAN_DIR, `${root}/${PLAN_DIR}`]) {
    rules.push({ action: 'edit', resource: `${base}/**`, effect: 'deny' });
    if (owned) rules.push({ action: 'edit', resource: `${base}/${owned}/**`, effect: 'allow' });
    // Screenshots are everyone's: the visual-review skill writes them, and a role
    // that renders a page must not need another role's folder to keep one.
    rules.push({ action: 'edit', resource: `${base}/shots/**`, effect: 'allow' });
  }
  return rules;
}

/**
 * What a coder may not read inside .synapse.
 *
 * Ideas are the one file that still holds the options the operator turned down,
 * and a coder that reads them is a coder that can quietly build one. `read` is a
 * real action and a relative path matches (both measured), so this is
 * enforcement rather than a request.
 */
export function roleReadRules(dir, role) {
  if (!/^coder-/.test(String(role || ''))) return [];
  const root = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const rules = [{ action: 'read', resource: `${PLAN_DIR}/ideas/**`, effect: 'deny' }];
  if (root) rules.push({ action: 'read', resource: `${root}/${PLAN_DIR}/ideas/**`, effect: 'deny' });
  return rules;
}

/**
 * Every file under .synapse, with a cheap identity. Compared around a worker
 * turn so a write that went around the path rules — a shell redirect, the `execute`
 * tool, an absolute path — is still seen and reported, the way the harness
 * watchdog compares the repository.
 */
export function synapseFingerprint(dir) {
  const base = path.join(String(dir || ''), PLAN_DIR);
  const out = {};
  const walk = (folder, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(folder, entry.name), rel);
      else {
        try {
          const stat = fs.statSync(path.join(folder, entry.name));
          out[rel] = `${stat.size}:${Math.round(stat.mtimeMs)}`;
        } catch { /* vanished mid-walk */ }
      }
    }
  };
  walk(base, '');
  return out;
}

/** Paths that differ between two fingerprints, ignoring one allowed folder. */
export function fingerprintDiff(before = {}, after = {}, allowFolder = '') {
  const changed = [];
  for (const rel of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[rel] === after[rel]) continue;
    if (allowFolder && (rel === allowFolder || rel.startsWith(`${allowFolder}/`))) continue;
    changed.push(rel);
  }
  return changed.sort();
}

/**
 * The brief handed to a session through the engine's instruction entries.
 *
 * Kept short on purpose: it is re-read on every step, and a wall of text gets
 * skimmed. Facts first (what the plan currently says), then the one rule that
 * cannot be guessed (the Architect owns the file; nobody else writes it).
 */
export function briefSession({ dir, role = 'architect', auto = false, single = false, skills = '', focus = '', instructions = '' } = {}) {
  const state = readPlan(dir);
  // The project's own document: what was asked, what was decided, the operator's
  // standing notes and the last compact's handover. This is what makes a long
  // project survivable — a fresh conversation reads it instead of the transcript
  // it no longer has.
  const doc = projectDigest(dir);
  const lines = [];
  const isArchitect = role === 'architect';

  const capped = (text, n) => {
    const s = String(text || '').trim();
    return s.length > n ? `${s.slice(0, n).trimEnd()} […]` : s;
  };

  lines.push(`Synapse project: ${path.basename(String(dir || '')) || 'unknown'}`);

  // The scratch folder this project's models may write. It is outside the project
  // and outside the harness, so a probe script or a screenshot goes there instead
  // of into either — and instead of the machine's temp folder, which is another
  // app's space. Boot and `createProject` make it; the path is the brief's.
  const scratch = scratchDir(dir);
  lines.push(
    `Scratch folder: ${scratch}. Probe scripts, screenshots and temporary data go there — never the machine's temp folder. It is yours to write, and it is outside the project.`,
  );
  // "Keep" on an attachment writes a deliberate copy under the project. It is
  // not in the transcript, so the next session can only find it by being told
  // where to look; one line here is the whole rule.
  lines.push(
    `Attachments the operator chose to keep are in .synapse/attachments/ — list that folder when a task may need one.`,
  );
  // The app's own data is part of the project, not the machine. This is one rule
  // for every project this harness will ever build; the operator does not keep
  // anything in AppData, and scratch is temporary by definition.
  lines.push(
    `App data lives with the app: a "data" folder beside the executable (for example bin/data, or data next to the published exe). Never %APPDATA%, %LOCALAPPDATA%, ProgramData, the registry or any user-profile folder. Scratch is temporary and never shipped; app data is part of the project. If an app already keeps data in AppData, move it to its own data folder and import the old copy once.`,
  );

  // The QC allowance belongs to the round, and the Architect is the one who plans
  // its checks. Without this line it carried the previous round's "three rounds
  // spent" from the handover into a round whose quota had reset, refused to
  // delegate QC, and wrote "the delegation was refused" into the plan — a refusal
  // that never happened (27 Oct, t7).
  if (isArchitect) {
    const qcSpent = qcRoundsUsed(dir);
    lines.push(
      qcSpent >= QC_ROUNDS
        ? `QC: all ${QC_ROUNDS} independent QC rounds for this plan are spent. Do not plan another QC task — settle any check yourself and say in the plan that you did.`
        : `QC: ${qcSpent} of ${QC_ROUNDS} independent QC rounds spent for this plan. A QC task will run if you delegate it; a finished plan starts a new allowance.`,
    );
  }

  // Single mode is not this harness at all: it is a chat that can use tools. No
  // roles, no work list, no delegation - the operator answers everything in one
  // conversation with it. Describing a team it cannot call was worse than saying
  // nothing: the brief told it to delegate and the ruleset refused the tool.
  //
  // The failure this branch had not accounted for: the operator switches a live
  // Multi session to Single to ask for one small thing, and the model is still
  // standing in the plan it wrote. Measured 26 Oct - asked to copy one exe, it read
  // .synapse/plan.json, decided from t21 whether the build was current, and reported
  // on t18 and t20. The transcript cannot be shortened from here, so the brief has
  // to overrule it: the stored request is not quoted (that is the old campaign, not
  // this conversation) and a plan on disk is named only to be refused.
  if (single && isArchitect) {
    lines.push(
      `You are working in ${dir ? String(dir) : 'this project folder'} and your tools operate there. ` +
        `Answer what you are asked, and use the tools when the answer needs the disk or a command.`,
    );
    lines.push(
      `This is one conversation: do the work yourself, here, with your own tools. There is no team and ` +
        `nothing to hand work to - do not delegate, and ignore a delegation tool if one is offered.`,
    );
    if (state.exists) {
      lines.push(
        `This project carries a plan and its working files from earlier work (${PLAN_DIR}/${PLAN_NAME} and the ` +
          `rest of ${PLAN_DIR}/). It was written for a different task, not for this conversation: ignore it. Do ` +
          `not take its tasks as yours, do not follow or update it, and do not judge this work against it. What ` +
          `the operator asks here is the whole job.`,
      );
    }
    if (instructions) lines.push(`The operator adds: ${instructions}`);
    // The operator's own standing rules are about this project, not about the old
    // campaign: they apply to a one-off request too. The stored requests do not.
    if (doc.notes) lines.push(`The operator's standing notes for this project:\n${capped(doc.notes, 800)}`);
    if (skills) lines.push(skills);
    lines.push(
      `If you need a decision from the operator, ask with the question tool: give the question a short human ` +
        `title, put your recommended option first and end its label with " (Recommended)".`,
    );
    return lines.join('\n');
  }


  // The project's document, in the three parts the brief needs: where it stands
  // (the latest request and the decisions still in force), the operator's own
  // standing notes, and the handover from the last compact. Each is capped: the
  // brief is re-read on every step, and the Log is what holds the whole history —
  // the model reads that file when it needs the detail.
  if (doc.current) {
    const origin = doc.exists ? ` (from ${DOC_RELATIVE}; the Log holds every request and answer)` : '';
    lines.push(`Where this project stands${origin}:\n${capped(doc.current, 1800)}`);
  }
  if (doc.notes) lines.push(`The operator's standing notes for this project:\n${capped(doc.notes, 900)}`);
  if (doc.handover) lines.push(`The handover from the last compact:\n${capped(doc.handover, 2000)}`);
  lines.push(
    isArchitect
      ? `Project plan: ${planRelPathPlain()} - you own this file and you are the only role that may write it. ` +
          `Read it when a session starts, and keep it current as work lands. To get a task done, hand it to ` +
          `its role with the delegate tool and wait for the report; do not do the work yourself.`
      : `Project plan: ${planRelPathPlain()} - read-only for you; the Architect is its only writer. ` +
          (OWNED_DIR[role]
            ? `Inside ${PLAN_DIR}/ you may write only under ${OWNED_DIR[role]}/ and nowhere else there. `
            : `Do not write anything inside ${PLAN_DIR}/. `) +
          `Your task is in the message you were given; do only that task.`,
  );

  // Judge, do not build. This is the Architect's one real discipline, and it is
  // said three ways because a model that is stuck on a delegation will otherwise
  // start editing files and call it progress — Fever Tracker was built for seven
  // hours by its Architect after a delegation was silently refused. Each sentence
  // answers a different "why not me?": what the job is, what to do when a
  // delegation cannot run, and what the work costs.
  //
  // Nothing here may describe *this* harness's shape. A worker's session, the model
  // behind a role, whether a run is cheap or independent — all of that is whatever
  // the operator configured, and Synapse runs any project on any model. State the
  // rule; leave the arrangement to the config.
  if (isArchitect) {
    lines.push(
      'You judge; you do not build. Reading files, running the checks and looking at what a worker produced is ' +
        'your job - that is how a report gets verified. What a task produces is not yours to change: any edit to ' +
        'it, however small, is a task. Put it in the plan and delegate it.',
    );
    lines.push(
      'When a delegation cannot run - refused, blocked, or the loop it belongs to is capped - never do that ' +
        'work yourself and never wait on it. Record the task as blocked, or as done if you verified it ' +
        'yourself, put the reason in its note, say it in your reply, and carry on with the rest of the plan.',
    );
    // Two operator actions used to read as failures to the model: a steer arriving
    // mid-turn looked like a new request, and a Stop looked like an error to retry.
    // Both are the operator speaking, and the Architect must not undo either.
    lines.push(
      'The operator may send you a message while you are working. It is marked "[steer]" and is guidance for ' +
        'the turn you are in, not a new request: apply it and continue, or stop and say why. If it changes the ' +
        'task materially, ask the operator a question to confirm before reshaping the plan.',
    );
    lines.push(
      'Your own turns are the dearest in the harness: every one re-sends this whole conversation. Delegation is ' +
        'how the work gets done without that bill - it is what the roles and the plan are for. Anything that ' +
        'takes more than a couple of small edits is a delegation, not a turn of yours.',
    );
    // The cost that a warning did not stop: one project's Architect conversation
    // reached 308,000 tokens, so every later turn re-read all of it, worker reports
    // included. A worker's report is already on disk; quoting it back is paying for
    // the same words on every turn from then on.
    lines.push(
      'Your conversation is the bill, and it only grows: by the end of a long project every turn re-reads ' +
        'everything you have said and everything a worker reported. So do not quote a report back - name its ' +
        'file, and say in one line what you checked yourself.',
    );
    // The cost is real: on one project the Architect ran the renderer 55 times and
    // read 29 of the pictures - the same contact sheets over and over, in folders
    // that each render created fresh. Images were two thirds of its transcript and
    // about a third of its window, every turn, for the rest of the project.
    //
    // But the rule cannot be "take the worker's word for it": a report is a claim,
    // and checking claims is the one thing this role does. So the rule is about
    // *why* a picture is taken, not whether it is allowed - render to answer a
    // question, never to look at something you have already seen.
    lines.push(
      'Rendering is how a claim about how something looks gets checked, and that is your job: the renderer, the ' +
        'page and the file are the evidence, and a worker\'s report is a claim like any other. What wastes the ' +
        'work is taking the same picture again: a render you cannot ask a new question of is a shell call and a ' +
        'picture that stays in your conversation for the rest of the project.',
    );
    lines.push(
      'Read a picture once, and ask it everything you need before you move on. Every render writes a new copy ' +
        'into a new folder, so two files with the same shape are the same picture: read the contact sheet for ' +
        'the width that matters, once, measure what you need from it, and keep the number rather than the image.',
    );
    // Who does what. The phase lines further down say what each phase is for; this
    // says who is for what, because a plan that maps every task to a coder still
    // satisfies the deliverables while skipping the craft. Measured 23 Oct: a
    // request made almost entirely of visual constraints came back with every task
    // on coder-1, and the one thing the operator wanted to see was never planned.
    lines.push(
      'Who does what: inventor finds the features while the request is still only a wish; designer decides how ' +
        'it looks - layout, palette, type, spacing, states - and draws the mock; a coder builds exactly what the ' +
        `design and the task say; qc judges the finished thing and reports what is wrong with it - what it hunts ` +
        'for is set by the brief the operator gave it, and it never fixes anything. Send each task to the craft ' +
        'it needs, not to whichever role is free: a coder builds a decision, never makes one. If a task would ' +
        `have to pick the colours, choose the type, set the spacing, settle the states or decide what belongs ` +
        `on the screen, that is not a coder's task - it goes to the role that owns that craft, and the coder's ` +
        `task reads ${PLAN_DIR}/design/design.md and builds it.`,
    );
  }

  // Everything the operator has settled is in the project document's Log, and
  // the decisions still in force are quoted above. A worker that lost the
  // transcript in a compaction asks the same question again unless it knows the
  // file is there — so it is named, and the rule is stated.
  if (doc.exists && doc.log) {
    lines.push(
      `The operator's answers so far are in ${DOC_RELATIVE}, under the Log. Read it before you ask ` +
        `anything, and never ask a question it already answers - those decisions are settled.`,
    );
  }

  // A worker knows what its job is *in general*; the message tells it which
  // specific task. Coders share one mandate, including coder-2 and coder-3.
  const mandate = isArchitect ? null : ROLE_MANDATES[role] || ROLE_MANDATES['coder-1'];
  if (mandate) lines.push(mandate);
  // Every role, at the end of the job: the run ends when the deliverable exists
  // and the checks pass, not when the model runs out of ideas. The clock project's
  // designer spent its last twenty minutes moving a value by 0.04% and re-rendering
  // to look at it, because nothing in its brief said when the work was done.
  if (!isArchitect) {
    lines.push(
      'Stop when the deliverable exists and the checks the task names pass: write your report and finish. A ' +
        'longer run is not a better one - the Architect judges the files, and polish past what was asked for is ' +
        'work nobody asked for.',
    );
    // The operator can talk to a worker mid-run now. Without this line a steer
    // reads as a second task, and the worker either restarts or answers it instead
    // of finishing the one it was given.
    lines.push(
      'The operator may send guidance while you work. It is marked "[steer]": treat it as their instruction for ' +
        'this task, apply it, say in your report what changed because of it, and do not restart the task unless ' +
        'it says so. If it changes the task materially and the intent is unclear, ask the operator a question ' +
        'before acting.',
    );
    // What a turn costs, said plainly, because the model is the only thing that
    // decides how many of them there are. Every turn re-sends this whole
    // transcript - its own thinking included - so the bill is turns multiplied by
    // everything already said. Measured on a real run: 84 turns read 13.7M tokens.
    lines.push(
      'Mind the bill: every turn re-sends this whole conversation, your reasoning included, so the cost is ' +
        'turns multiplied by everything already said. Think in a sentence or two and then act; long deliberation ' +
        'costs more than it saves.',
    );
    lines.push(
      'Read each file once. When you need something from it later, search for the line instead of reading it ' +
        'again, and re-read only after you have changed it.',
    );
    lines.push(
      'Once a file exists, change it with edits rather than rewriting it - a write sends the whole file again, ' +
        'and it stays in the conversation.',
    );
  }
  if (role === 'qc') {
    lines.push(QC_FOCUS[focus === 'security' ? 'security' : 'app']);
    lines.push(QC_PROPORTION);
  }
  // The operator's own words for this role. Anything typed here is what the
  // role is told on every turn, which is the cheapest way to correct a habit
  // without editing what the role is for.
  if (instructions) lines.push(`The operator adds, for this role: ${instructions}`);
  // Which skills this role may load. Synapse enforces the same list through the
  // session's permission ruleset; saying it here is what stops a model wasting a
  // turn on a refusal it could have seen coming.
  if (skills) lines.push(skills);

  // What the operator actually approved. A worker that sees this cannot quietly
  // build a rejected idea back in; the rejected ones are never listed here.
  if (state.features?.confirmed?.length) {
    const list = state.features.confirmed
      .slice(0, 12)
      .map((f) => `${f.id || '?'} ${f.title}`)
      .join('; ');
    lines.push(`Confirmed features: ${list}.`);
  }

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
    // Only the Architect can repair the plan. Telling a worker about a broken
    // task two rows down is noise it can do nothing about.
    if (isArchitect && state.problems.length) {
      lines.push(`Plan problems to fix: ${state.problems.slice(0, 4).join('; ')}`);
    }
  }

  // Both roles can ask the operator something, and the panel is only as good as
  // the question. The label convention is the question tool's own: recommend by
  // position and by the "(Recommended)" suffix, which the panel turns into a chip.
  lines.push(
    `If you need a decision from the operator, ask with the question tool: give the question a short human ` +
      `title (not a slug or a flag name), put your recommended option first and end its label with " (Recommended)".`,
  );

  if (isArchitect) {
    lines.push(
      `Format: {"version":1,"goal":"...","summary":"","tasks":[{"id":"t1","title":"...","role":"coder-1","status":"todo","origin":"plan|found|operator",` +
        `"detail":"...","reads":[],"dependsOn":[],"result":null,"note":null}]} - ` +
        `statuses: ${STATUSES.join(', ')}. Keep ids short and unique, titles under ${TITLE_MAX} characters, ` +
        `and mark a task "blocked" only when it needs the operator.`,
    );
    // The pane is an index of the work, not a list of files. The specific file
    // names, commands and formats belong in `detail`, which the row shows on
    // hover — so a title stays readable to someone who has not read the project.
    lines.push(
      `A title says what the work *is*, in plain human words - "Build the word-frequency report", ` +
        `"Wire the buttons", "Audit the output", "Quality Control". No file paths and no code identifiers ` +
        `in a title: put them in detail.`,
    );
    // A blocked note is the one line of prose the operator sees in the plan pane.
    // It became an essay on 27 Oct ("they still contradict: line 105/106 says ..."),
    // which filled the pane with red text and hid the list.
    lines.push(
      `A blocked task carries a short "note": the reason in one or two sentences — what is stuck and what ` +
        `you need the operator to decide. No reasoning, no line numbers, no code, no essay. The pane shows ` +
        `two lines of it and the rest only on hover, so a wall of text there hides the list. A row's note ` +
        `and status must agree: "done" needs no note, "blocked" says what you need.`,
    );
    // The card has to tell the operator, in one line, what they actually got.
    lines.push(
      `When every task is done, also write "summary" in the plan: ONE sentence a customer would ` +
        `understand, saying what this project delivers. No file paths, no tool names, no code. ` +
        `The Architect's card shows it instead of just a tick.`,
    );
    // The operator's setup deliberately gives the coders different models, from
    // cheap and experimental to reliable and expensive. The Architect only needs
    // to know they are peers: the ladder is the harness's business (it is the one
    // that can see a model refuse a turn).
    lines.push(
      `coder-1, coder-2 and coder-3 are peers - three coders, which may each be on a different model. Write ` +
        `coding work for one of them; if that coder cannot do it, Synapse moves the task down the line ` +
        `itself and the report tells you which role actually ran it.`,
    );
    // The list is live within the round, but it is the operator's checklist, not
    // a diary. Two rounds of rows on 27 Oct — seven rows deep, NEW badges, one
    // blocked essay, a QC "verify" row from an earlier round — was unusable even
    // though every row was true.
    lines.push(
      `This file is this request's checklist, not a diary. A new request from the operator starts a new ` +
        `plan: write a new "goal" and replace the task list with the rows this request needs. Do not carry ` +
        `rows from the last round — a row that was "done" there says nothing about this one, and the runs ` +
        `file keeps the history. Keep it to 2-6 rows: each is a deliverable the operator can see, not a ` +
        `discovery. While the work happens, add a row only when the round cannot finish without it — a ` +
        `defect that blocks the goal — at most one or two, set "origin": "found", and say in one line what ` +
        `it is and why it is here. Do not add tasks for things you noticed but are not doing this round; ` +
        `write those in your reply. A row you planned is "plan"; one the operator asked for is "operator".`,
    );
    // The plan is the record of the work, so a worker does the work. On 28 Oct a
    // one-file request ("create hello.txt") was written by the Architect itself,
    // in Multi, and the plan pane stayed "No plan yet" — the operator's list did
    // not mention the work that had just happened.
    lines.push(
      `In Multi, every piece of work goes through the plan - even a single file: write the row, delegate it, ` +
        `and judge the report. Do not write the product yourself; Single is the mode where you answer and act alone.`,
    );
    lines.push(
      `invent: when the operator wants something built but the features are open, delegate to inventor, which ` +
        `writes ${PLAN_DIR}/ideas/ideas-1.md ranked with effort. Then YOU ask the operator which to include: ` +
        `ONE multiselect, one option per proposed feature - never bundles and never a "how much of it do you ` +
        `want" choice, because they are picking features, not a mood. Put the ones you recommend first with ` +
        `" (Recommended)" on the label, give each option's description that idea's one-line why and its effort, ` +
        `and set custom:true so they can add their own. Then write ` +
        `${PLAN_DIR}/${FEATURES_NAME}: {"version":1,"items":[{"id":"F1","title":"...","why":"...",` +
        `"priority":"critical|useful|optional","status":"confirmed|rejected","task":"t2"}]}. Every confirmed ` +
        `feature names the task that delivers it; rejected ones stay in the file and are never passed on.`,
    );
    lines.push(
      `design: delegate to designer, which writes ${PLAN_DIR}/design/design.md (screens, controls, colour tokens, ` +
        `theme values) and one mock per screen, two at most for the project - a screen with four states is one ` +
        `mock behind a switch, not four files. The designer renders its own mocks and reports the numbers - a ` +
        `claim like any other, so check the ones you rely on. Read the sheet it produced, and render again only ` +
        `to answer a question that sheet cannot, then ask the operator to pick one - design is the one thing only ` +
        `they can judge. ` +
        `Pin the stack first: if "runs like an app" could mean a local page, a Tkinter window or something else, ask.`,
    );
    // Measured 23 Oct: a brief made almost entirely of visual constraints (a
    // palette, a type pairing, an 8px scale, alignment, two widths to prove) was
    // planned as "build, qc" with every task on a coder. The model took the
    // shortest path that satisfied the deliverables, so the one thing the operator
    // asked to see was the thing skipped.
    lines.push(
      `When the operator's request is about how something LOOKS - a screen, a page, a design, a mock, a palette, ` +
        `"make it look X" - the look is the work, not a side effect of it: give designer ` +
        `its own task, and make every build task read ${PLAN_DIR}/design/design.md. A coder deciding the palette, ` +
        `the type or the spacing on the way past is the failure this rule exists to stop, however competent the ` +
        `result looks. The reverse is also a rule: when the operator has already named the features, invent has ` +
        `nothing to decide, and inventing anyway is a round nobody needed.`,
    );
    // The trap that cost a whole rejection round: a native date/time control is
    // drawn by the BROWSER, in the browser's locale, whatever the markup says. An
    // attribute is not a mechanism, and a picture of the target is not a test.
    lines.push(
      `A control's locale is drawn by the browser, not by the markup: a native date/time input with lang="en-GB" ` +
        `still renders MM/DD/YYYY and AM/PM on a US-locale machine. If the design depends on a format, either pin the ` +
        `mechanism that actually produces it (a host setting, or your own drawn control) or draw the field yourself and ` +
        `say that it is a picture of the target. Prove the RENDERED text of the control matches ` +
        `"selector|regex" via shot.mjs --expect, not that the attribute is present.`,
    );
    lines.push(
      `build: one task that builds the shell from the design with no wiring, then one that wires it. The titles ` +
        `say which is which. A shell task must not wire; a wiring task must not redesign. Every build task is ` +
        `written for coder-1: the coders are a ladder, not a pool, and the harness moves a task to coder-2 and ` +
        `then coder-3 by itself when the coder before it cannot do the work. Never plan a task for coder-2 or ` +
        `coder-3 - that spends the fallback on work the first coder could have done, and the operator pays for ` +
        `it. If a task will take more than about forty turns or touch more than one subsystem, split it into two ` +
        `tasks joined by a handoff - a worker that runs a hundred turns is slower on its last turn than on its ` +
        `first, because it reads everything it has already done.`,
    );
    lines.push(
      `qc: delegate to qc with the request, the confirmed features and the design spec. It reports on wording, ` +
        `clipping and layout, missing input validation, and states that lie - see its mandate. It writes ` +
        `${PLAN_DIR}/qc_findings/qc-N.md with ids (Q1, Q2...) and a repro for each. Then one fix task naming the ` +
        `ids to fix. Then a verification task, on qc: re-run exactly those repros and the supplied suites, and ` +
        `nothing else - a second QC pass is a check, not a new hunt, so anything new it notices goes in a short ` +
        `"observed, not fixed" list for the operator instead of becoming another round. A third round only if the ` +
        `verification found a real regression. Three is the limit; after that, stop and tell the operator what is ` +
        `still open. A worker's report goes in that role's own folder or in the task's "result": never point a ` +
        `coder at ${PLAN_DIR}/qc_findings/, which belongs to QC - the file tools refuse it and the harness ` +
        `reports the stray write as tampering.`,
    );
    // Measured 25 Oct on a byte-level tool: the fix round was a coder's task, and
    // the architect then put the verification of that coder's work on a coder too -
    // its own judgement about what is safe, and the one judgement that cannot be
    // left to the role being judged. Checking a fix is QC's job whoever wrote it.
    lines.push(
      `The task that checks a fix belongs to qc, not to the role that made the fix. A worker judging its own ` +
        `work is not a check, and neither is your own run of it standing in for one: delegate the verification ` +
        `to qc, with the ids and the repros.`,
    );
    lines.push(
      `A task's "reads" lists the files the worker must read first (a design spec, the feature list, a QC ` +
        `report). Use it instead of restating their contents in "detail": the files are the contract, and a ` +
        `paraphrase is how a project drifts. Two files at most, and never a file the previous task wrote - a ` +
        `worker that opens four documents spends its first turns paying for them.`,
    );
    lines.push(
      `Write the detail for a worker who has read nothing: name the files to touch and the command that proves ` +
        `it. "Build the sky" costs an hour of searching; "add the solar position to bin/solar.js and prove it ` +
        `with node bin/tests/solar.test.js" costs minutes. A task that says what to change and how it will be ` +
        `checked is also a task that can be finished in one sitting.`,
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

