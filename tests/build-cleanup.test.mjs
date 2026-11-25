// Builds that land under a running window leave the old image behind.
//
// Windows will not replace a running exe, so the builder renames it aside and puts
// the new one at the root. The running window keeps the old image until it exits;
// after that the old file is litter. The next launch removes it, and the same for
// the browser-host folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

test('the shell removes old build files at startup', () => {
  const shell = read('shell/ServerHost.cs');
  assert.match(shell, /void CleanOldBuilds\(\)/, 'no cleanup');
  assert.match(shell, /Synapse\.exe\.old-/, 'the old exe is never removed');
  assert.match(shell, /browser-host\.old-/, 'the old browser host is never removed');
  const start = shell.slice(shell.indexOf('public void Start()'), shell.indexOf('if (TryAdopt())'));
  assert.match(start, /CleanOldBuilds\(\)/, 'cleanup is not run before the new window starts');
});

test('a build stages over a running exe instead of requiring a stop', () => {
  const build = read('shell/build.ps1');
  assert.match(build, /Synapse was running; the old exe is/, 'the build still assumes the app is stopped');
  assert.match(build, /Move-Item \$target \$old/, 'the locked exe is not moved aside');
  assert.match(build, /dist-host/, 'the browser host is published straight into its locked folder');
});
