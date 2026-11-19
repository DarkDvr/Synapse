// The project's AGENTS.md: the map every session starts with, and the notepad.
//
// The rule this file exists to hold: the fence is generated from the same constants
// the permission rules are, so the file cannot describe a rule the ruleset does not
// enforce; the generated block is replaced by comparison (not by a version number),
// so a build that changes it reaches every project; and nothing below the end marker
// is ever rewritten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from './tmpdir.mjs';
import { briefSession, roleWriteRules } from '../src/plans.js';
import {
  AGENTS_LIMIT,
  AGENTS_NAME,
  agentsStatus,
  ensureAgents,
  notepadTemplate,
} from '../src/project-agents.js';
import { scratchDir } from '../src/paths.js';

const BEGIN = '<!-- synapse:agents:begin -->';
const END = '<!-- synapse:agents:end -->';

const project = () => tmpdir('synapse-agents-');
const agentsFile = (dir) => path.join(dir, AGENTS_NAME);
const read = (dir) => fs.readFileSync(agentsFile(dir), 'utf8');
const allows = (dir, role) => roleWriteRules(dir, role).filter((r) => r.effect === 'allow').map((r) => r.resource);
const denies = (dir, role) => roleWriteRules(dir, role).filter((r) => r.effect === 'deny').map((r) => r.resource);

test('a new project gets the header and the notepad, and no facts file', () => {
  const dir = project();
  const out = ensureAgents(dir);
  assert.equal(out.created, true);
  assert.equal(out.error, undefined);
  const text = read(dir);
  assert.ok(text.startsWith(BEGIN), 'the generated block is not first');
  assert.ok(text.includes(END), 'the block is not closed');
  for (const heading of ['## Stack and layout', '## Outside the project', '## Harness quirks', '## Lessons learned']) {
    assert.ok(text.includes(heading), `the notepad lost ${heading}`);
  }
  assert.ok(text.includes(`under ${AGENTS_LIMIT} characters`), 'nothing says the cap');
  assert.equal(fs.existsSync(path.join(dir, '.project', 'facts.md')), false, 'a facts file was created');
});

test('the header names the paths and the fence, in words a model can act on', () => {
  const dir = project();
  ensureAgents(dir);
  const header = read(dir).slice(0, read(dir).indexOf(END));
  const flat = header.replace(/\\/g, '/');
  assert.ok(flat.includes(`\`${dir.replace(/\\/g, '/')}\``), 'the project folder is not named');
  assert.ok(flat.includes(scratchDir(dir).replace(/\\/g, '/')), 'the scratch folder is not named');
  assert.ok(flat.includes('Synapse\'s own folder'), 'the harness rule is missing');
  assert.ok(/qc\s*\|[^\n]*qc_findings/.test(header), 'qc is not given its folder');
  assert.ok(/designer\s*\|[^\n]*design/.test(header), 'the designer is not given its folder');
  assert.ok(header.includes('coder-1, coder-2'), 'the coders are not named');
  assert.ok(
    header.includes('Project facts') && header.includes('not in `facts.md` or any'),
    'the header does not say where facts live now',
  );
  assert.ok(header.includes('Single mode has no roles'), 'single mode is not explained');
});

test('a project with its own AGENTS.md keeps every word of it', () => {
  const dir = project();
  const mine = '# The project\'s own notes\n\nWe build a widget.\n';
  fs.writeFileSync(agentsFile(dir), mine, 'utf8');
  const out = ensureAgents(dir);
  assert.equal(out.created, false);
  assert.equal(out.updated, true);
  const text = read(dir);
  assert.ok(text.startsWith(BEGIN), 'the header did not go on top');
  assert.ok(text.includes(mine.trim()), 'the project\'s text was rewritten');
  assert.equal(agentsStatus(dir).chars > 0, true);
});

test('the block is replaced by comparison, and the notepad is untouched', () => {
  const dir = project();
  ensureAgents(dir);
  const notes = '## Lessons learned\n\n17 Nov - the check shell has no Get-FileHash.\n';
  fs.writeFileSync(agentsFile(dir), `${BEGIN}\n# old header from an older build\n${END}\n\n${notes}`, 'utf8');
  const out = ensureAgents(dir);
  assert.equal(out.updated, true);
  const text = read(dir);
  assert.equal(text.includes('old header from an older build'), false, 'the old block survived');
  assert.ok(text.includes('how this project works'), 'the new block did not land');
  assert.ok(text.includes(notes.trim()), 'the notepad was rewritten');
});

test('a second pass writes nothing', () => {
  const dir = project();
  ensureAgents(dir);
  const once = read(dir);
  const again = ensureAgents(dir);
  assert.equal(again.created, false);
  assert.equal(again.updated, false);
  assert.equal(read(dir), once, 'an unchanged file was rewritten');
});

test('an existing facts file is folded in and then deleted', () => {
  const dir = project();
  const facts = '# Project facts\n\n## Harness quirks\n\n- 20 Nov: the vpa build writes to bin/.\n';
  fs.mkdirSync(path.join(dir, '.project'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.project', 'facts.md'), facts, 'utf8');
  const out = ensureAgents(dir);
  assert.equal(out.migrated, true);
  const text = read(dir);
  assert.ok(text.includes('20 Nov: the vpa build writes to bin/'), 'the facts were not carried over');
  assert.ok(text.indexOf(BEGIN) < text.indexOf('the vpa build'), 'the header is not above the facts');
  assert.equal(fs.existsSync(path.join(dir, '.project', 'facts.md')), false, 'the old facts file is still there');
});

test('a project that already had its own map still loses the facts file, once', () => {
  const dir = project();
  const mine = '# Our map\n\nWe build a widget.\n';
  fs.writeFileSync(agentsFile(dir), mine, 'utf8');
  const facts = '## Harness quirks\n\n- 20 Nov: the deploy step needs `--force`.\n';
  fs.mkdirSync(path.join(dir, '.project'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.project', 'facts.md'), facts, 'utf8');
  const out = ensureAgents(dir);
  assert.equal(out.migrated, true);
  const text = read(dir);
  assert.ok(text.includes('We build a widget.'), 'their map was rewritten');
  assert.equal(text.split('needs `--force`').length - 1, 1, 'the facts were appended twice');
  assert.equal(fs.existsSync(path.join(dir, '.project', 'facts.md')), false, 'the facts file survived');
  // And a second pass does not append them again.
  ensureAgents(dir);
  assert.equal(read(dir).split('needs `--force`').length - 1, 1, 'a second pass duplicated the facts');
});

test('the size the brief quotes is the notepad only, and the cap is real', () => {
  const dir = project();
  ensureAgents(dir);
  const small = agentsStatus(dir);
  assert.equal(small.exists, true);
  assert.equal(small.over, false);
  assert.ok(small.chars > 0, 'the notepad reads as empty');
  assert.ok(small.chars < AGENTS_LIMIT);
  const headerOnly = read(dir).slice(read(dir).indexOf(END));
  assert.ok(small.chars < headerOnly.length + 1, 'the header is counted as notepad');
  // The notepad is what the cap applies to; the generated block is not.
  const big = `${read(dir)}\n${'x'.repeat(AGENTS_LIMIT)}\n`;
  fs.writeFileSync(agentsFile(dir), big, 'utf8');
  assert.equal(agentsStatus(dir).over, true);
  assert.equal(agentsStatus(project()).exists, false, 'a missing file is not an error');
});

test('the Architect is told about the file and no worker is pointed at it', () => {
  const dir = project();
  ensureAgents(dir);
  const brief = briefSession({ dir, role: 'architect' });
  assert.match(brief, /Project facts: AGENTS\.md/, 'the architect does not know the file exists');
  assert.match(brief, /You own it and every role reads it/i, 'nobody owns the notepad, or the architect does not know workers read it');
  assert.match(brief, /Cap 6000 characters; it is \d+ now/, 'the brief does not quote the cap and size');
  assert.doesNotMatch(brief, /add a dated line/, 'the brief repeats the file\'s own instructions');
  assert.doesNotMatch(briefSession({ dir, role: 'coder-1' }), /Project facts:/, 'a worker was pointed at it');
});

test('a worker may read the map and may not edit it', () => {
  const dir = project();
  for (const role of ['coder-1', 'coder-2', 'designer', 'qc', 'inventor']) {
    assert.ok(denies(dir, role).includes(AGENTS_NAME), `${role} may edit the map`);
    assert.ok(denies(dir, role).includes(`${dir.replace(/\\/g, '/')}/${AGENTS_NAME}`), `${role} may edit it by absolute path`);
  }
});

test('the scratch lives inside the project, and every role may write there', () => {
  const dir = project();
  const scratch = scratchDir(dir);
  assert.ok(
    scratch.toLowerCase().startsWith(path.join(dir, '.project').toLowerCase()),
    'scratch is not inside the project',
  );
  assert.ok(scratch.toLowerCase().endsWith('scratch'), 'the folder is not named scratch');
  for (const role of ['coder-1', 'designer', 'qc', 'inventor']) {
    const allowed = allows(dir, role).map((r) => r.replace(/\\/g, '/').toLowerCase());
    assert.ok(allowed.includes('.project/scratch/**'), `${role} may not write its scratch`);
    assert.ok(allowed.includes(`${scratch.replace(/\\/g, '/').toLowerCase()}/**`), `${role}'s absolute scratch path is refused`);
  }
  // And there is no shared root beside the projects any more.
  assert.equal(scratchDir(dir).includes('_scratch'), false);
});

test('the notepad template stays small enough to be worth reading', () => {
  assert.ok(notepadTemplate().length < 900, `the template is ${notepadTemplate().length} characters`);
});
