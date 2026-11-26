// The engine's own skills are not Synapse's skills.
//
// `GET /api/skill` returns both the files in Synapse's folder and the skills compiled
// into the engine binary. The browser one describes the OpenCode desktop app, and its
// tools do not exist in Synapse; the role picker must not offer it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OpenCodeEngine } from '../src/engines/opencode.js';
import { visibleSkills } from '../web/skill-list.js';

const silent = () => ({ channel: () => ({ info() {}, debug() {}, warn() {}, error() {} }) });

test('listSkills marks engine-built skills separately', async () => {
  const engine = new OpenCodeEngine({}, { logger: silent() });
  engine.request = async () => ({
    data: [
      { id: 'browser', name: 'Browser', description: 'desktop', path: 'skill://browser/SKILL.md' },
      { id: 'local', name: 'local', description: 'ours', path: 'F:\\dev\\Synapse\\skills\\local\\SKILL.md' },
    ],
  });
  const skills = await engine.listSkills();
  assert.deepEqual(skills.map((s) => [s.name, s.builtin]), [['Browser', true], ['local', false]]);
});

test('the role dialog sees only the skills this machine can run', () => {
  const visible = visibleSkills([
    { name: 'Browser', builtin: true },
    { name: 'app-check', builtin: false },
    { name: 'OpenCode', builtin: true },
    { name: 'visual-review' },
  ]);
  assert.deepEqual(visible.map((s) => s.name), ['app-check', 'visual-review']);
});
