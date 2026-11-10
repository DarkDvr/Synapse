// Two counters that must not outlive the thing they describe: a loop signature,
// and a model's loop marks when the operator chooses that model for a role.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createModelCache } from '../src/modelcache.js';
import { toolTarget } from '../src/runs.js';
import { tmpdir } from './tmpdir.mjs';

const logger = { channel: () => ({ info() {}, warn() {}, error() {}, debug() {} }) };

test('a read slice is part of what a tool call acted on', () => {
  // Paging through one large file is progress, not a loop (4 Nov: three chunks of
  // Transfer.cs were three "read run 3 times" strikes in thirty seconds).
  assert.notEqual(
    toolTarget({ filePath: 'app/engine/Transfer.cs', offset: 0, limit: 2000 }),
    toolTarget({ filePath: 'app/engine/Transfer.cs', offset: 2000, limit: 2000 }),
  );
  assert.notEqual(
    toolTarget({ filePath: 'app/engine/Transfer.cs', offset: 0, limit: 2000 }),
    toolTarget({ filePath: 'app/engine/Transfer.cs', offset: 0, limit: 4000 }),
  );
  // The same bytes asked for twice are the same call.
  assert.equal(
    toolTarget({ filePath: 'app/engine/Transfer.cs', offset: 0, limit: 2000 }),
    toolTarget({ filePath: 'app/engine/Transfer.cs', offset: 0, limit: 2000 }),
  );
  // A command has no slice and stays itself.
  assert.equal(toolTarget({ command: 'node proof.js' }), 'node proof.js');
});

test('a role model change clears loop marks, not provider facts', () => {
  const dir = tmpdir('synapse-mc-');
  try {
    const file = path.join(dir, 'model-cache.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        models: {
          'p/m': {
            ref: 'p/m',
            issues: [
              { kind: 'loop', message: 'it looped 3 times in one work order: "read run 3 times"' },
              { kind: 'provider', message: 'Invalid API key' },
            ],
          },
        },
      }),
    );
    const cache = createModelCache({ logger, file });
    assert.equal(cache.clearLoopIssues('p/m'), 1);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(saved.models['p/m'].issues.map((issue) => issue.kind), ['provider']);
    assert.equal(cache.clearLoopIssues('p/m'), 0, 'nothing left to clear');
    assert.equal(cache.clearLoopIssues('p/none'), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
