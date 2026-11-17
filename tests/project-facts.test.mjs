// The facts file: durable reference the Architect keeps, not a second plan.
//
// It exists because a compact rewrites `project.md` — a model summarising the chat
// paraphrases facts away, where the operator needs them to survive. It is capped and
// named only in the Architect's brief, so the cost is a few hundred characters of
// brief rather than a copy of the file on every turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from './tmpdir.mjs';
import { briefSession } from '../src/plans.js';
import { FACTS_LIMIT, FACTS_RELATIVE, ensureFacts, factsStatus, factsTemplate } from '../src/project-facts.js';

const project = () => tmpdir('synapse-facts-');
const factsFile = (dir) => path.join(dir, '.project', 'facts.md');

test('a new project gets the headings and the rule, and no facts', () => {
  const dir = project();
  const out = ensureFacts(dir);
  assert.equal(out.created, true);
  assert.equal(out.error, undefined);
  const text = fs.readFileSync(factsFile(dir), 'utf8');
  for (const heading of ['## Stack and layout', '## Outside the project', '## Harness quirks', '## Lessons learned']) {
    assert.match(text, new RegExp(heading.replace(/[[\]]/g, '\\$&')), `the template lost ${heading}`);
  }
  assert.match(text, /The Architect keeps this file/, 'nothing says who owns it');
  assert.match(text, new RegExp(String(FACTS_LIMIT)), 'nothing says the cap');
  // Headers only: no fact was invented for the project.
  const sections = text.slice(text.indexOf('## Stack and layout')).split('\n');
  const content = sections.filter((line) => line.trim() && !line.startsWith('## '));
  assert.deepEqual(content, [], `the template carries content: ${content.join(' | ')}`);
});

test('an existing facts file is never touched', () => {
  const dir = project();
  ensureFacts(dir);
  const mine = '# Project facts\n\n## Lessons learned\n\n17 Nov — the check shell has no Get-FileHash.\n';
  fs.writeFileSync(factsFile(dir), mine, 'utf8');
  const again = ensureFacts(dir);
  assert.equal(again.created, false);
  assert.equal(fs.readFileSync(factsFile(dir), 'utf8'), mine, 'a second ensure overwrote the file');
  assert.equal(factsStatus(dir).chars, mine.length);
});

test('the status reports size and the cap', () => {
  const dir = project();
  ensureFacts(dir);
  const small = factsStatus(dir);
  assert.equal(small.exists, true);
  assert.equal(small.over, false);
  fs.writeFileSync(factsFile(dir), 'x'.repeat(FACTS_LIMIT + 1), 'utf8');
  const big = factsStatus(dir);
  assert.equal(big.over, true);
  assert.equal(big.chars, FACTS_LIMIT + 1);
  assert.equal(factsStatus(project()).exists, false, 'a missing file is not an error');
});

test('the Architect is told where it is, who owns it and the cap', () => {
  const dir = project();
  ensureFacts(dir);
  const brief = briefSession({ dir, role: 'architect' });
  assert.match(brief, new RegExp(FACTS_RELATIVE.replace(/[.]/g, '\\.')), 'the architect does not know the file exists');
  assert.match(brief, /you own it and you are its only writer/, 'nobody owns the file');
  assert.match(brief, new RegExp(`it is ${factsStatus(dir).chars} now`), 'the brief does not quote the current size');
  // The file is reference for the role that judges, not for a worker's task.
  assert.doesNotMatch(briefSession({ dir, role: 'coder-1' }), /Project facts:/, 'a worker was pointed at the facts file');
});

test('past the cap the Architect is told to condense before adding', () => {
  const dir = project();
  ensureFacts(dir);
  fs.writeFileSync(factsFile(dir), `# Project facts\n\n${'x'.repeat(FACTS_LIMIT)}\n`, 'utf8');
  const brief = briefSession({ dir, role: 'architect' });
  assert.match(brief, /over the 6000 cap - condense it before you add/, 'an oversized file reads as fine');
});

test('the template stays small enough to be worth reading', () => {
  // The point is that the file is reference, not a second project document. A
  // template that grows into one is a template nobody reads.
  assert.ok(factsTemplate().length < 900, `the template is ${factsTemplate().length} characters`);
});
