// The two things Synapse checks about the machine it starts on.
//
//  - npm: used for one thing (updating the runtime) and not needed to run, so the
//    decision is a pure three-way split, not a hard gate — see src/npm-check.js.
//  - the runtime copy that travels with the app: "Check for Updates" has to put
//    the new binary *there*, or the app keeps starting the old one and the update
//    silently does nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { npmPlan } from '../src/npm-check.js';
import { copyRuntimeOver } from '../src/engine-update.js';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

// ── npm: three situations, three answers ────────────────────────
check('npm present is quiet', npmPlan({ npmFound: true, runtimeFound: true }) === 'quiet');
check('no npm but a runtime present only warns', npmPlan({ npmFound: false, runtimeFound: true }) === 'warn');
check('no npm and no runtime blocks the start', npmPlan({ npmFound: false, runtimeFound: false }) === 'block');

// ── the update copies over the vendored binary, keeping the old ─
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-vendor-'));
const vendored = path.join(dir, 'opencode.exe');
const fresh = path.join(dir, 'fresh-opencode.exe');
fs.writeFileSync(vendored, 'old binary', 'utf8');
fs.writeFileSync(fresh, 'new binary', 'utf8');

const copied = copyRuntimeOver(fresh, vendored);
check('the new binary replaces the old one', fs.readFileSync(vendored, 'utf8') === 'new binary');
check('the old one is kept as .bak', fs.readFileSync(`${vendored}.bak`, 'utf8') === 'old binary');
check('the copy reports that it happened', copied === true);

const same = copyRuntimeOver(vendored, vendored);
check('copying a file onto itself is a no-op', same === false);

let threw = '';
try {
  copyRuntimeOver(path.join(dir, 'missing.exe'), vendored);
} catch (err) {
  threw = err.message;
}
check('a missing source is an error, not a silent success', /nothing to copy/.test(threw), threw);

fs.rmSync(dir, { recursive: true, force: true });

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
