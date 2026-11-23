// A project's role set: `.project\roles.json`.
//
// The file is the project's own, travels with it, and survives a compaction. The
// config keeps the template (skills, instructions, timings); only the model and its
// thinking effort are project-scoped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from './tmpdir.mjs';
import { readProjectRoles, writeProjectRoles, effectiveRoles, roleModel, mergeRoles, rolesPath } from '../src/project-roles.js';

const config = {
  roles: {
    architect: { ref: 'provider/arch', variant: 'high', skills: ['visual-review'] },
    'coder-1': { ref: 'provider/one', variant: '', stallSec: 600 },
    'coder-2': { ref: 'provider/two' },
  },
};

test('a project with no file has no role set of its own', () => {
  const dir = tmpdir('project-roles-none-');
  assert.deepEqual(readProjectRoles(dir), {});
  const effective = effectiveRoles(config, dir);
  assert.equal(effective.architect.ref, 'provider/arch');
  assert.equal(effective.architect.variant, 'high');
  assert.equal(effective.architect.skills[0], 'visual-review');
  assert.equal(effective['coder-1'].ref, 'provider/one');
  assert.equal(effective['coder-1'].stallSec, 600);
  assert.equal(effective['coder-2'].ref, 'provider/two');
  assert.equal(effective.inventor.ref, '', 'an unset role is empty, not invented');
});

test('the file round-trips, and the project wins over the template', () => {
  const dir = tmpdir('project-roles-round-');
  writeProjectRoles(dir, {
    architect: { ref: 'provider/arch2', variant: 'low' },
    'coder-1': { ref: 'provider/one2' },
    unknown: { ref: 'provider/nope' },
  });
  assert.equal(fs.existsSync(rolesPath(dir)), true);
  const saved = readProjectRoles(dir);
  assert.deepEqual(saved, {
    architect: { ref: 'provider/arch2', variant: 'low' },
    'coder-1': { ref: 'provider/one2', variant: '' },
  });
  const effective = effectiveRoles(config, dir);
  assert.equal(effective.architect.ref, 'provider/arch2');
  assert.equal(effective.architect.variant, 'low');
  assert.equal(effective.architect.skills[0], 'visual-review', 'the template’s skills survive');
  assert.equal(effective['coder-1'].ref, 'provider/one2');
  assert.equal(effective['coder-2'].ref, 'provider/two', 'an untouched role still follows the template');
  assert.equal(roleModel(effective, 'architect').ref, 'provider/arch2');
});

test('a malformed file is empty, not a crash', () => {
  const dir = tmpdir('project-roles-bad-');
  fs.mkdirSync(path.dirname(rolesPath(dir)), { recursive: true });
  fs.writeFileSync(rolesPath(dir), '{ this is not json', 'utf8');
  assert.deepEqual(readProjectRoles(dir), {});
  assert.deepEqual(roleModel({ architect: { ref: '' } }, 'architect'), null);
});

test('a seed overlays the template without dropping the roles it names', () => {
  const dir = tmpdir('project-roles-merge-');
  const template = effectiveRoles(config, dir);
  const merged = mergeRoles(template, {
    architect: { ref: 'provider/new-arch', variant: 'low' },
    'coder-1': { ref: 'provider/new-one' },
  });
  assert.equal(merged.architect.ref, 'provider/new-arch');
  assert.equal(merged.architect.variant, 'low');
  assert.equal(merged.architect.skills[0], 'visual-review');
  assert.equal(merged['coder-1'].ref, 'provider/new-one');
  assert.equal(merged['coder-1'].stallSec, 600);
  assert.equal(merged['coder-2'].ref, 'provider/two', 'a role outside the seed keeps the template');
});

test('the Architect’s session model is the migration fallback', () => {
  const dir = tmpdir('project-roles-migration-');
  const effective = effectiveRoles(config, dir, {
    architect: { ref: 'provider/session', variant: 'medium' },
  });
  assert.equal(effective.architect.ref, 'provider/session');
  assert.equal(effective.architect.variant, 'medium');
});

test('a written file contains every role the project owns, and no temp is left', () => {
  const dir = tmpdir('project-roles-write-');
  const roles = {
    architect: { ref: 'provider/arch' },
    inventor: { ref: 'provider/inv' },
    designer: { ref: 'provider/des' },
    qc: { ref: 'provider/qc' },
    'coder-1': { ref: 'provider/c1' },
    'coder-2': { ref: 'provider/c2' },
  };
  writeProjectRoles(dir, roles);
  const raw = JSON.parse(fs.readFileSync(rolesPath(dir), 'utf8'));
  assert.equal(raw.version, 1);
  assert.deepEqual(Object.keys(raw.roles).sort(), Object.keys(roles).sort());
  const leftovers = fs.readdirSync(path.dirname(rolesPath(dir))).filter((n) => n.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});
