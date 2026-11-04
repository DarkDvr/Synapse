// The words Synapse uses for a worker's report and for an automatic reply.
//
// 4 Nov: the chat header said "Synapse · worker t6 (qc) completed" — "worker" as a
// noun, no model, and nothing about the task but its id. It now reads
// "t6 completed by QC (<model name>)". And an Auto-Answer reply must not reach a
// model as if the operator had typed it: they are away, which is why it fired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('a worker report’s header names the task, the coder, the model and the cost', () => {
  const src = read('src/runs.js');
  assert.match(src, /const ROLE_NAMES = \{/);
  assert.match(src, /'coder-1': 'Coder 1'/);
  assert.match(src, /qc: 'QC'/);
  assert.match(src, /completed by \$\{who\}/);
  assert.match(src, /failed in \$\{who\}/);
  assert.match(src, /\$\{request\.task\} \$\{said\} \(\$\{model\}\)/);
  assert.match(src, /modelCache\?\.get\?\.\(modelRef\)\?\.name/, 'the model is named, not its ref');
  // Time and tokens moved into the header (4 Nov), so the report below them does
  // not say the same numbers twice.
  assert.match(src, /ran for \$\{ranFor\(Date\.now\(\) - startedAt\)\}/);
  assert.match(src, /tokens\(\(context\.prompt \|\| 0\) \+ \(context\.generated \|\| 0\)\)/);
  assert.match(src, /% was reasoning/);
  assert.doesNotMatch(src, /finished in \$\{Math\.round\(ms \/ 1000\)\}s/, 'the report head keeps no clock');
  assert.doesNotMatch(src, /read \(the provider's meter\)/, 'the report keeps no token totals');
  assert.doesNotMatch(src, /worker \$\{request\.task\} \(\$\{role\}\) \$\{outcome\}/, 'the old header is gone');
});

test('an automatic answer tells the model the harness replied, not the operator', () => {
  const api = read('src/api.js');
  assert.match(api, /Auto-Answer answered that question: the operator is away/);
  assert.match(api, /description: 'Auto-Answer'/);
});
