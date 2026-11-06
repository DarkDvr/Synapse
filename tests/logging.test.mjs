// The four levels, and what belongs at each.
//
// The mechanism was always there — error, warn, info, debug, switchable in
// Settings → Logging — but the classification was not: one day of app.log was
// 9,131 lines of "permission allow", and one day of session.log was 24,381 lines of
// reasoning deltas. A log where the normal case is 95% of the file is a log nobody
// reads, and the failure that matters is the line you have to find.
//
// The rule these tests pin:
//   error  something failed and the operator must know
//   warn   something went wrong and the work carried on
//   info   what Synapse did: a run, a plan, a stop, a decision that was not "yes"
//   debug  the chatter: the raw event stream, every allowed tool call
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger, LEVELS } from '../src/logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the levels are ordered, and a level writes itself and everything above it', () => {
  assert.deepEqual(LEVELS, { error: 0, warn: 1, info: 2, debug: 3 });
  assert.ok(LEVELS.error < LEVELS.warn && LEVELS.warn < LEVELS.info && LEVELS.info < LEVELS.debug);
});

test('an unknown level falls back to info rather than silencing the log', () => {
  logger.configure({ level: 'debug' });
  assert.equal(logger.level, 'debug');
  logger.configure({ level: 'nonsense' });
  assert.equal(logger.level, 'info', 'a typo must not turn logging off');
  logger.configure({ level: 'info' });
});

test('the raw event stream is debug, not info', () => {
  const engine = read('src/engines/opencode.js');
  assert.match(engine, /this\.sessionLog\.debug\(`event \$\{type\}/, 'engine events are chatter');
  assert.doesNotMatch(engine, /this\.sessionLog\.info\(`event \$\{type\}/, 'and not the operator narrative');
});

test('an allowed tool call is debug; a refusal is info', () => {
  const gate = read('src/permission-gate.js');
  assert.match(gate, /if \(verdict\.effect === 'allow' \|\| forgiven\) log\.debug\(allowLine\);/, 'yes is chatter');
  assert.match(gate, /else log\.info\(allowLine\);/, 'no is news');
  // The card being raised is the operator's business either way.
  assert.match(gate, /log\.info\(`permission asked/, 'an ask stays at info');
});

test('the milestones the operator reads are still info', () => {
  // A sample, not every line: these are the ones a support question is answered
  // from, so they must not drift down to debug.
  assert.match(read('src/runs.js'), /out\.info\(`run \$\{request\.task\} \(\$\{role\}\) started/, 'a run starting');
  assert.match(read('src/stop.js'), /log\?\.info\(`stop: /, 'a stop');
  assert.match(read('src/plans.js'), /log\.info\(`plan \(\$\{dir\}\): /, 'the plan state at boot');
});
