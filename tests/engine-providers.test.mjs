// The providers an engine serves itself are the engine's business.
//
// The page carried OpenCode's two rows — ids, labels and sentences — which is engine
// knowledge in a file that has to work with any engine. They come from the adapter
// now, through `GET /api/providers`, and these tests are what keeps them there: the
// adapter must name them, an engine without its own must say nothing, and the page
// must not quietly grow a copy back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Engine } from '../src/engines/base.js';
import { OpenCodeEngine } from '../src/engines/opencode.js';

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
const quiet = { channel: () => ({ info() {}, debug() {}, warn() {}, error() {} }) };

test('an engine that serves no providers of its own says so, and the page shows the config', () => {
  const base = new Engine({}, {});
  assert.deepEqual(base.engineProviders(), []);
});

test('the OpenCode adapter names its own two providers', () => {
  const engine = new OpenCodeEngine({}, { logger: quiet, workspaceDir: '.', dataDir: '.' });
  const rows = engine.engineProviders();
  assert.deepEqual(rows.map((r) => r.id), ['opencode', 'opencode-go']);
  for (const row of rows) {
    assert.ok(row.label, `${row.id} needs a label the rail can draw`);
    assert.ok(row.note, `${row.id} needs the sentence the Providers pane shows`);
  }
});

test('the page no longer carries the engine’s provider names', () => {
  const page = ['web/provider-list.js', 'web/providers.js', 'web/model-picker.js', 'web/app.js']
    .map(read)
    .join('\n');
  assert.doesNotMatch(page, /OC Zen|OC Go/, 'the names live in the adapter now');
  assert.doesNotMatch(page, /'opencode-go'/, 'so do the ids it knows about');
});
