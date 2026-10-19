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

// The roles the topology has cards for, in card order. The `auditor` and the
// `critic` were retired: the Architect verifies its own delegations against the
// disk, so a second confirmation was redundant, and the two slots are better
// spent on an idea generator and an adversary.
export const ROLES = ['architect', 'inventor', 'coder-1', 'designer', 'coder-2', 'hacker', 'coder-3'];

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

    const role = asText(source.role) || 'architect';
    if (source.role && !ROLES.includes(role)) {
      problems.push(`${where} names an unknown role "${role}" (cards: ${ROLES.join(', ')})`);
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
    const result = asText(source.result) || null;
    if (result && (status === 'todo' || status === 'doing')) {
      problems.push(
        `${where} has a result but its status is "${status}" - mark it done, or clear the result`,
      );
    }

    return {
      id: id || null,
      title: title || '(untitled)',
      role,
      status,
      rawStatus,
      detail: asText(source.detail) || null,
      dependsOn: Array.isArray(source.dependsOn) ? source.dependsOn.map(asText).filter(Boolean) : [],
      result,
      note: asText(source.note) || null,
    };
  });

  // A finished plan owes the operator a customer-facing summary: the Architect's
  // card shows it once the work is done, instead of only a DONE chip. The Architect
  // writes it itself, so this is a note to it rather than something we invent.
  if (tasks.length && tasks.every((t) => t.status === 'done') && !asText(parsed.summary)) {
    problems.push(
      'the plan is finished but has no "summary" - add one sentence a customer would understand: ' +
        'what this project delivers, with no file paths and no tool names',
    );
  }

  return {
    ...base,
    exists: true,
    mtime: stat.mtimeMs,
    stat: { size: stat.size, mtime: stat.mtimeMs },
    problems,
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
    'The spec is what the builder is held to, so make it exact enough to check line by line.',
  ].join(' '),
  hacker: [
    'You are the Hacker. Assume the build is broken and find where. Run it with empty, huge, malformed and unusual',
    'input; check boundaries, exit codes and failure paths; try to make it lie. Do not fix anything and do not edit',
    'the build. Write the findings to .synapse/reports/hack-1.md (create the folder): each with an id (H1, H2...), a',
    'severity (critical, major, minor, nice-to-have), the exact command and input that reproduces it, what happened and',
    'what should have happened. Also list what you tested and could not break, so coverage is visible.',
  ].join(' '),
  'coder-1': [
    'You are a Coder. Build exactly what the task names and nothing else: the plan, the confirmed features and the',
    'design are read-only to you. Work only inside the project folder.',
  ].join(' '),
};

// Where a role may write inside .synapse, and nowhere else there. A coder has
// no such folder: its output is the project itself.
const OWNED_DIR = {
  inventor: `${PLAN_DIR}/ideas`,
  designer: `${PLAN_DIR}/design`,
  hacker: `${PLAN_DIR}/reports`,
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
      : `Project plan: ${planRelPathPlain()} - read-only for you; the Architect is its only writer. ` +
          (OWNED_DIR[role]
            ? `Inside ${PLAN_DIR}/ you may write only under ${OWNED_DIR[role]}/ and nowhere else there. `
            : `Do not write anything inside ${PLAN_DIR}/. `) +
          `Your task is in the message you were given; do only that task.`,
  );

  // A worker knows what its job is *in general*; the message tells it which
  // specific task. Coders share one mandate, including coder-2 and coder-3.
  const mandate = isArchitect ? null : ROLE_MANDATES[role] || ROLE_MANDATES['coder-1'];
  if (mandate) lines.push(mandate);

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

  // Both roles can ask the operator something, and the panel is only as good as
  // the question. The label convention is the question tool's own: recommend by
  // position and by the "(Recommended)" suffix, which the panel turns into a chip.
  lines.push(
    `If you need a decision from the operator, ask with the question tool: give the question a short human ` +
      `title (not a slug or a flag name), put your recommended option first and end its label with " (Recommended)".`,
  );

  if (isArchitect) {
    lines.push(
      `Format: {"version":1,"goal":"...","summary":"","tasks":[{"id":"t1","title":"...","role":"coder-1","status":"todo",` +
        `"detail":"...","dependsOn":[],"result":null,"note":null}]} - ` +
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

