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

import { describeSkills, chatSkillRules } from '../src/skills.js';
import { SKILLS_DIR } from '../src/paths.js';

const config = {
  roles: {
    designer: { skills: ['aesthetic-foundations', 'visual-review'], mustLoad: ['aesthetic-foundations'] },
    inventor: { skills: ['frontend-design'] },
    silent: { skills: [] },
    architect: { skills: ['visual-review'] },
  },
};

// 28 Nov: a Single chat ran with the Architect's list, which is chosen for judging a
// team, so the engine advertised `frontend-design` and refused it — the model spent a
// turn guessing what was secretly allowed. A chat may meet any kind of work, so it
// gets no restriction at all and the brief names the machine's catalogue.
test('a chat may load every skill, and a Multi Architect keeps its own list', () => {
  assert.deepEqual(chatSkillRules(config, true), [], 'no rules is the engine’s "load anything"');
  assert.deepEqual(chatSkillRules(config, false), [
    { action: 'skill', resource: '*', effect: 'deny' },
    { action: 'skill', resource: 'visual-review', effect: 'allow' },
  ]);
});

test('a chat brief names the machine’s skills and refuses none', () => {
  const text = describeSkills(config, 'architect', {
    chat: true,
    available: ['aesthetic-foundations', 'code-craft', 'frontend-design', 'visual-review'],
  });
  for (const name of ['aesthetic-foundations', 'code-craft', 'frontend-design', 'visual-review']) {
    assert.ok(text.includes(name), `the chat should be told ${name} is open`);
  }
  assert.doesNotMatch(text, /Any other skill is refused/);
  assert.doesNotMatch(text, /judge/i, 'a chat does not judge');
  assert.match(text, /every one of them is open to you/);
});

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

test('a required skill that is not allowed is not demanded', () => {
  const withdrawn = {
    roles: {
      designer: { skills: ['visual-review'], mustLoad: ['aesthetic-foundations', 'visual-review'] },
    },
  };
  const text = describeSkills(withdrawn, 'designer');
  assert.match(text, /visual-review/);
  assert.doesNotMatch(text, /aesthetic-foundations/, 'the session cannot load it, so the brief must not ask');
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
