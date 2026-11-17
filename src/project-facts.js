// The project's facts file: what a run learned that will still be true next week.
//
// It is deliberately not the project document. `project.md` is the operator's record
// — requests, decisions, the last compact's handover — and compaction rewrites it.
// This file is the opposite: reference the Architect keeps by hand, one dated line at
// a time, so a fact survives a compact instead of being summarised into it.
//
// It is capped because everything read into a conversation is paid for on every later
// turn, and a file that grows without a limit stops being read at all. The cap is a
// number the Architect is told; this module only reports it.
//
// Only the Architect may write it: the worker fence in plans.js denies `edit` on
// `.project/**` for every other role, so a worker's lesson reaches this file through
// its report, which the Architect reads.
import fs from 'node:fs';
import path from 'node:path';

/** Mirrors PLAN_DIR in plans.js — kept here so this module imports nothing. */
const SYNAPSE_DIR = '.project';
const FACTS_NAME = 'facts.md';
export const FACTS_RELATIVE = `${SYNAPSE_DIR}/${FACTS_NAME}`;
/** A screen of facts, not a second document. Past this the Architect condenses. */
export const FACTS_LIMIT = 6000;

const factsPath = (dir) => path.join(String(dir || ''), SYNAPSE_DIR, FACTS_NAME);

/** The file a new project starts with: the headings, and the rule for using them. */
export function factsTemplate() {
  return [
    '# Project facts',
    '',
    'The Architect keeps this file. One line per fact, dated, under the heading it',
    'belongs to: what a run taught that will still be true next week — a command that',
    'fails here, a path that resolves oddly, an account or tool the project depends on,',
    'a limit the operator set. It is reference, not narrative; the reports hold the',
    'story and the plan holds the work.',
    '',
    'Delete a fact that has stopped being true instead of writing a newer version',
    `beside it, and keep the file under ${FACTS_LIMIT} characters: when it passes`,
    'that, condense it before adding.',
    '',
    '## Stack and layout',
    '',
    '## Outside the project',
    '',
    '## Harness quirks',
    '',
    '## Lessons learned',
    '',
  ].join('\n');
}

/**
 * Create `.project\facts.md` when it is missing, and never touch one that exists.
 *
 * Called from `ensureProjectFolders`, so every project has the file before its first
 * session — the same rule as the plan file: an empty, valid file is a better starting
 * point than a missing one, and it makes the file discoverable.
 */
export function ensureFacts(dir) {
  const file = factsPath(dir);
  try {
    if (fs.existsSync(file)) return { path: file, created: false };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, factsTemplate(), 'utf8');
    return { path: file, created: true };
  } catch (err) {
    return { path: file, created: false, error: err.message };
  }
}

/** How big the file is now — the number the Architect's brief quotes. */
export function factsStatus(dir) {
  // No project, no file: never let an empty directory turn into a path relative to
  // the harness's own working folder.
  if (!String(dir || '').trim()) return { exists: false, chars: 0, lines: 0, over: false };
  const file = factsPath(dir);
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { exists: true, chars: text.length, lines: text.split('\n').length, over: text.length > FACTS_LIMIT };
  } catch {
    // No file yet reads the same as an empty one: the brief says the file is there
    // to fill, and quotes a size of 0. There is nothing to report to the operator.
    return { exists: false, chars: 0, lines: 0, over: false };
  }
}
