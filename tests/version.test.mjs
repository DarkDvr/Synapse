// One version, three files, checked by the suite.
//
// The version lives in `package.json` and is mirrored in two places a person writes by
// hand: `shell/Synapse.csproj` (the exe's file properties) and the README's version
// line. On 31 Oct the title bar still said v1.4.2 after two releases — that one was the
// running exe being a build behind, not a forgotten bump, but the mistake it looked like
// is real and easy: bump one file, ship an exe that disagrees with everything else. The
// operator asked for it to be automated rather than remembered, so this is the guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('package.json, the exe and the README carry one version', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(String(pkg.version || ''), /^\d+\.\d+\.\d+$/, 'package.json holds major.minor.patch');

  const csproj = /<Version>([^<]*)<\/Version>/.exec(read('shell/Synapse.csproj'));
  assert.ok(csproj, 'shell/Synapse.csproj has a <Version>');
  assert.equal(csproj[1].trim(), pkg.version, 'the exe’s file properties must match package.json');

  const line = new RegExp(`\\*\\*Version ${pkg.version.replace(/\./g, '\\.')}\\*\\*`);
  assert.match(read('README.md'), line, 'README.md states the same version');
});
