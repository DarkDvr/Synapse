// The project document: one living file, a derived head, an append-only log.
//
// Replaces requirement.md + decisions.md. The bug it fixes is the reason it is
// tested this hard: the brief quoted the first 1,600 characters of
// requirement.md — the project's *original* request — so a long project always
// looked, to the model, like its first day. The head is rebuilt from the log, so
// "the request" is always the latest one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendRequest,
  appendChat,
  appendDecision,
  digest,
  ensureProjectDoc,
  readDoc,
  setHandover,
  writeDoc,
} from '../src/project-doc.js';

const project = () => fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-doc-'));
const docFile = (dir) => path.join(dir, '.synapse', 'project.md');

test('the first request creates the document and the head quotes it', () => {
  const dir = project();
  const out = appendRequest(dir, 'Build a fever tracker');
  assert.equal(out.ok, true);
  const doc = readDoc(dir);
  assert.equal(doc.exists, true);
  assert.match(doc.current, /Request: Build a fever tracker/);
  assert.match(doc.log, /### request · /);
  assert.equal(fs.existsSync(`${docFile(dir)}.tmp`), false, 'no temporary left behind');
});

test('two requests: the head quotes the latest, the log keeps both', () => {
  const dir = project();
  appendRequest(dir, 'Build a fever tracker');
  appendRequest(dir, 'Now add a trend chart');
  const doc = digest(dir);
  assert.match(doc.current, /Request: Now add a trend chart/);
  assert.doesNotMatch(doc.current, /Request: Build a fever tracker/);
  assert.match(doc.log, /Build a fever tracker/);
  assert.match(doc.log, /Now add a trend chart/);
});

test('a Single message is logged but never becomes the project request', () => {
  const dir = project();
  appendRequest(dir, 'Build the settings screen');
  appendChat(dir, 'Copy the exe somewhere');
  const doc = digest(dir);
  assert.match(doc.current, /Request: Build the settings screen/);
  assert.match(doc.log, /Copy the exe somewhere/);
});

test('with no request at all, the newest chat is the head (a chat-only project)', () => {
  const dir = project();
  appendChat(dir, 'Rename the folder');
  assert.match(digest(dir).current, /Request: Rename the folder/);
});

test('an answer is a decision in force, and the newest answer wins', () => {
  const dir = project();
  appendDecision(dir, {
    fields: [{ key: 'ot', title: 'Overtime flag style' }],
    answer: { ot: 'Allow amber (Recommended)' },
  });
  assert.match(digest(dir).current, /Overtime flag style -> Allow amber/);
  // "(Recommended)" is the Architect's nudge, not the operator's decision.
  assert.doesNotMatch(digest(dir).current, /\(Recommended\)/);

  appendDecision(dir, { fields: [{ key: 'ot', title: 'Overtime flag style' }], answer: { ot: 'Green + text only' } });
  const current = digest(dir).current;
  assert.match(current, /Overtime flag style -> Green \+ text only/);
  assert.doesNotMatch(current, /Allow amber/);
  // Both answers are still in the record.
  const log = digest(dir).log;
  assert.match(log, /Allow amber/);
  assert.match(log, /Green \+ text only/);
});

test('two different questions are both in force', () => {
  const dir = project();
  appendDecision(dir, { fields: [{ key: 'a', title: 'Colour' }], answer: { a: 'Violet' } });
  appendDecision(dir, { fields: [{ key: 'b', title: 'Type' }], answer: { b: 'DM Sans' } });
  const current = digest(dir).current;
  assert.match(current, /Colour -> Violet/);
  assert.match(current, /Type -> DM Sans/);
});

test('the operator’s Notes survive every write, even with headings in them', () => {
  const dir = project();
  const notes = '## My rules\n\n- Use the green accent\n- Never touch the chart';
  writeDoc(dir, { current: '', handover: '', notes, log: '' });
  appendRequest(dir, 'Add a button');
  const doc = readDoc(dir);
  assert.equal(doc.notes, notes);
  assert.match(doc.current, /Add a button/);
});

test('the handover is replaced without touching the log or the head', () => {
  const dir = project();
  appendRequest(dir, 'Build it');
  assert.equal(setHandover(dir, '## Objective\n- ship a thing'), true);
  let doc = digest(dir);
  assert.match(doc.handover, /ship a thing/);
  assert.match(doc.current, /Build it/);
  assert.equal(setHandover(dir, '## Objective\n- ship it better'), true);
  doc = digest(dir);
  assert.match(doc.handover, /ship it better/);
  assert.doesNotMatch(doc.handover, /ship a thing/);
});

test('the old two files are imported and archived on first use', () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, '.synapse'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.synapse', 'requirement.md'),
    "# The operator's request\n\nBuild a clock\n\n---\n\nNow add a stopwatch\n",
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, '.synapse', 'decisions.md'),
    "# The operator's answers\n\n## 21 Oct 2026, 19:51 - abc123\n\n- **Overtime flag style** -> Allow amber\n",
    'utf8',
  );
  const migrated = ensureProjectDoc(dir);
  assert.equal(migrated.exists, true);
  const doc = digest(dir);
  assert.match(doc.current, /Request: Now add a stopwatch/);
  assert.doesNotMatch(doc.current, /Request: Build a clock/);
  assert.match(doc.log, /Build a clock/);
  assert.match(doc.current, /Overtime flag style -> Allow amber/);
  // The originals move aside, so nothing reads two versions of the same words.
  assert.equal(fs.existsSync(path.join(dir, '.synapse', 'requirement.md')), false);
  assert.equal(fs.existsSync(path.join(dir, '.synapse', 'decisions.md')), false);
  assert.match(fs.readFileSync(path.join(dir, '.synapse', 'archive', 'requirement.md'), 'utf8'), /Build a clock/);
});

test('a document somebody broke by hand is never overwritten', () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, '.synapse'), { recursive: true });
  fs.writeFileSync(docFile(dir), '# I edited this by hand\n', 'utf8');
  const out = appendRequest(dir, 'Add a button');
  assert.equal(out.ok, false);
  assert.equal(fs.readFileSync(docFile(dir), 'utf8'), '# I edited this by hand\n');
});

test('a legacy project briefs from the old files before any write', () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, '.synapse'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.synapse', 'requirement.md'), "# The operator's request\n\nFirst ask\n", 'utf8');
  const doc = digest(dir);
  assert.equal(doc.exists, false);
  assert.match(doc.current, /Request: First ask/);
  // Reading does not create the file: only a write (or the brief's ensure) does.
  assert.equal(fs.existsSync(docFile(dir)), false);
});
