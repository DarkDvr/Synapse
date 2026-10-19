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
export const REQUIREMENT_NAME = 'requirement.md';
export const FEATURES_NAME = 'features.json';

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

/** The operator's words, verbatim, append-only.
 *
 * Synapse writes this, never a model: a requirement that a model restates is a
 * requirement that can drift, and every role downstream is judged against the
 * operator's own sentences rather than the Architect's summary of them. */
export function appendRequirement(dir, text) {
  const body = String(text || '').trim();
  if (!body || !dir) return false;
  const target = path.join(String(dir), PLAN_DIR, REQUIREMENT_NAME);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const exists = fs.existsSync(target);
    const header = exists ? '' : `# The operator's request\n\n`;
    const separator = exists ? '\n---\n\n' : '';
    fs.appendFileSync(target, `${header}${separator}${body}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function readRequirement(dir) {
  try {
    // The header is for a human opening the file; a brief does not need it.
    return fs
      .readFileSync(path.join(String(dir || ''), PLAN_DIR, REQUIREMENT_NAME), 'utf8')
      .replace(/^# The operator's request\s*\n+/, '')
      .trim();
  } catch {
    return '';
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
  // The phases the Architect chose for this project: a menu, not a checklist,
  // and this is the record of what it picked. Tolerant, like everything else.
  const phases = Array.isArray(parsed.phases) ? parsed.phases.map(asText).filter(Boolean).slice(0, 8) : [];
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
      detail: asText(source.detail) || null,
      dependsOn: Array.isArray(source.dependsOn) ? source.dependsOn.map(asText).filter(Boolean) : [],
      reads,
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
    requirement: readRequirement(dir),
    plan: { version: Number(parsed.version) || 1, goal, summary: asText(parsed.summary), phases, tasks },
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
    'You are the Hacker. Assume the build is broken and find where. Run it the way it is meant to be used, then',
    'the way a careless person would: the faults live at the edges. Do not fix anything and do not edit the build.',
    'Write the findings to .synapse/reports/hack-1.md (create the folder): each with an id (H1, H2...), a severity',
    '(critical, major, minor, nice-to-have), the exact command and input that reproduces it, what happened and what',
    'should have happened. Also list what you tested and could not break, so coverage is visible.',
  ].join(' '),
  'coder-1': [
    'You are a Coder. Build exactly what the task names and nothing else: the plan, the confirmed features and the',
    'design are read-only to you. Work only inside the project folder.',
  ].join(' '),
};

// How hard the Hacker pushes. `app` is the default and the honest one for most
// projects: a person typing something wrong is what actually breaks a small
// tool, and an hour of hostile-environment construction answers a question
// nobody asked. `security` is the same role with the gloves off, one setting
// away in the role card's ✎ dialog.
const HACKER_FOCUS = {
  app: [
    'Focus: real use, not security. The user is a person typing into this app or running this command. Test what',
    'they actually do - empty and whitespace-only input, text where a number belongs, a negative or enormous',
    'number, a very long line, accented letters and emoji, a missing file, the wrong file, a path with spaces, an',
    'option that does not exist, starting it from the wrong folder, pressing Enter twice, closing the window',
    'half-way. Judge what they would see: a crash, a wrong answer, silence where something should happen, a',
    'message nobody can understand, work lost. Do not audit the security of the build: no hostile-environment',
    'construction, no locale or interpreter matrices, no fuzzing loops. If something looks genuinely dangerous,',
    'note it as an observation and move on.',
  ].join(' '),
  security: [
    'Focus: adversarial. Treat the build as hostile territory - try to make it lie, escape its folder, run',
    'something it should not, or lose data under duress. Hostile input, unusual encodings, broken output streams,',
    'missing permissions, and anything that would matter if this were exposed to someone trying to break it. Say',
    'plainly what you did not cover.',
  ].join(' '),
};

// A handful of the cases a real user hits beats an exhaustive matrix, in either
// focus: the report is read by a person who wants to know what to fix.
const HACKER_PROPORTION =
  'Keep it proportionate: the cases with the best chance of happening are worth more than a complete matrix, and ' +
  'the report is judged on what it found, not on how long it ran.';

/** Where a role may write inside .synapse, and nowhere else there. */
const OWNED_DIR = {
  inventor: `${PLAN_DIR}/ideas`,
  designer: `${PLAN_DIR}/design`,
  hacker: `${PLAN_DIR}/reports`,
};

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
export function briefSession({ dir, role = 'architect', auto = false, skills = '', focus = '', instructions = '' } = {}) {
  const state = readPlan(dir);
  const lines = [];
  const isArchitect = role === 'architect';

  lines.push(`Synapse project: ${path.basename(String(dir || '')) || 'unknown'}`);

  // The operator's own words, verbatim. Capped: the brief is re-read on every
  // step, and a long conversation is not the brief's job — the file keeps all
  // of it, and this is the ask itself.
  if (state.requirement) {
    const text =
      state.requirement.length > 1600
        ? `${state.requirement.slice(0, 1600).trimEnd()} [...]`
        : state.requirement;
    lines.push(`The operator's request (verbatim, also in ${PLAN_DIR}/${REQUIREMENT_NAME}):\n${text}`);
  }
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
  if (role === 'hacker') {
    lines.push(HACKER_FOCUS[focus === 'security' ? 'security' : 'app']);
    lines.push(HACKER_PROPORTION);
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
      `Format: {"version":1,"goal":"...","summary":"","phases":["invent","design","build","hack"],"tasks":[{"id":"t1","title":"...","role":"coder-1","status":"todo",` +
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
    // The pipeline is a menu: a clock pays for all of it, a one-file script does
    // not. These are the rules that change behaviour, not a description of a
    // process - every one of them exists because a project drifted without it.
    lines.push(
      `The work is a menu, not a checklist - pick the phases this project needs and put them in "phases". ` +
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
        `theme values) and one mock per screen. Look at the mocks yourself before showing them (the visual-review ` +
        `skill renders them), then ask the operator to pick one - design is the one thing only they can judge. ` +
        `Pin the stack first: if "runs like an app" could mean a local page, a Tkinter window or something else, ask.`,
    );
    lines.push(
      `build: one task that builds the shell from the design with no wiring, then one that wires it. The titles ` +
        `say which is which. A shell task must not wire; a wiring task must not redesign.`,
    );
    lines.push(
      `hack: delegate to hacker with the request, the confirmed features and the design spec. It writes ` +
        `${PLAN_DIR}/reports/hack-N.md with ids (H1, H2...) and a repro for each. Then one fix task naming the ids ` +
        `to fix, then a re-hack that re-runs the same repros. Three rounds is the limit; after the third, stop and ` +
        `tell the operator what is still open.`,
    );
    lines.push(
      `A task's "reads" lists the files the worker must read first (a design spec, the feature list, a hack ` +
        `report). Use it instead of restating their contents in "detail": the files are the contract, and a ` +
        `paraphrase is how a project drifts.`,
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

