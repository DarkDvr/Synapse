// What a role is told about its skills, and what a skill is allowed to say about
// where things live.
//
// The regression: `visual-review` told every worker to run a script under
// `C:/Users/Andrew/.agents/skills/...`, a folder that does not carry it. Three
// roles in Timer Test 1 searched the disk for `shot.mjs`, tripped the harness
// alarm doing it, and then called the tool with a flag it does not have. The path
// of a shipped tool is the harness's fact, so the brief states it and the skill
// text stays portable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { describeSkills } from '../src/skills.js';
import { SKILLS_DIR } from '../src/paths.js';

const config = {
  roles: {
    designer: { skills: ['aesthetic-foundations', 'visual-review'], mustLoad: ['aesthetic-foundations'] },
    inventor: { skills: ['frontend-design'] },
    silent: { skills: [] },
  },
};

test('a role with the visual-review skill is given the shipped script path', () => {
  const text = describeSkills(config, 'designer');
  const tool = path.join(SKILLS_DIR, 'visual-review', 'bin', 'shot.mjs');
  assert.ok(text.includes(tool), `the brief should name ${tool}`);
  assert.ok(fs.existsSync(tool), 'and the file it names must exist');
  assert.ok(/do not search the disk/i.test(text), 'and it says the hunt is wasted work');
});

test('a role without it is not told about it', () => {
  assert.ok(!describeSkills(config, 'inventor').includes('shot.mjs'));
  assert.ok(!describeSkills(config, 'silent').includes('shot.mjs'));
});

test('a required skill is an instruction, an optional one is not', () => {
  const text = describeSkills(config, 'designer');
  assert.match(text, /aesthetic-foundations/);
  assert.match(text, /Also available when the task needs it: visual-review/);
});

test('no shipped skill names one machine\'s folder', () => {
  const bad = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.md$/i.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        if (/C:[\\/]Users[\\/]|\.agents[\\/]skills/i.test(text)) bad.push(path.relative(SKILLS_DIR, full));
      }
    }
  };
  walk(SKILLS_DIR);
  assert.deepEqual(bad, [], `a skill must not name a machine folder: ${bad.join(', ')}`);
});
