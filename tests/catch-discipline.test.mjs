// A catch that says nothing is indistinguishable from a catch that forgot.
//
// There are 71 of them left in src/. They are not all wrong — a lease released on a
// session that is already gone is genuinely quiet — but a reader cannot tell a
// deliberate swallow from a forgotten one, and the Stop bug hid in exactly this: an
// interrupt that failed during the engine's retry wait threw nothing anyone could
// see.
//
// The rule: a bare `catch {` carries a comment naming why it is safe. The ones that
// were already there are a baseline, so this test does not demand a sweep. It fails
// on a new one. When someone explains one, the baseline comes down with it.
//
// A bound catch (`catch (err)`) is not counted: the binding is the evidence that the
// error was considered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Measured 6 Nov 2026. Only ever goes down.
const BASELINE = {
  'src/api.js': 3,
  'src/cleanup.js': 4,
  'src/config.js': 1,
  'src/desk.js': 1,
  'src/engine-update.js': 2,
  'src/engines/opencode.js': 5,
  'src/fetch.js': 5,
  'src/form-auto.js': 1,
  'src/harness.js': 1,
  'src/housekeeping.js': 8,
  'src/index.js': 1,
  'src/mcp/delegate-server.js': 1,
  'src/mcp/lease-server.js': 1,
  'src/mcp/search-server.js': 1,
  'src/npm-check.js': 2,
  'src/plans.js': 7,
  'src/probe.js': 2,
  'src/project-doc.js': 2,
  'src/projects.js': 1,
  'src/protection.js': 2,
  'src/provider-errors.js': 2,
  'src/providers.js': 4,
  'src/remote.js': 1,
  'src/runs.js': 6,
  'src/secrets.js': 1,
  'src/server.js': 2,
  'src/site-sessions.js': 1,
  'src/stop.js': 1,
  'src/synapse-update.js': 1,
};

/** A bare catch with no comment on its own line or the first line inside it. */
function silentCatches(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let n = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/\bcatch\s*\{/.test(line)) continue;
    if (/\/[/*]/.test(line)) continue;
    const next = lines[i + 1] || '';
    if (/^\s*(\/\/|\/\*|\*)/.test(next)) continue;
    n += 1;
  }
  return n;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'bin', 'dist', 'data', 'logs', '.git', 'obj', 'vendor'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.m?js$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('no file gained a catch that says nothing', () => {
  const offenders = [];
  for (const file of walk(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const count = silentCatches(file);
    const allowed = BASELINE[rel] || 0;
    if (count > allowed) offenders.push(`${rel}: ${count} silent catch(es), baseline ${allowed}`);
  }
  assert.deepEqual(offenders, [], 'explain the catch, or lower the baseline when you fix one');
});

test('the baseline is not stale: every entry still has at least that many', () => {
  // A file that dropped below its number was cleaned up and the baseline should
  // follow, or the next silent catch there would go unnoticed.
  const stale = [];
  for (const [rel, allowed] of Object.entries(BASELINE)) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) {
      stale.push(`${rel}: gone`);
      continue;
    }
    const count = silentCatches(file);
    if (count < allowed) stale.push(`${rel}: ${count} now, baseline says ${allowed} — lower it`);
  }
  assert.deepEqual(stale, []);
});
