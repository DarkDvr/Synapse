// Builds are made with the window closed.
//
// Windows will not replace a running exe, and the app must not swap files under a
// live process: the shell is built only when the operator says so, with the window
// closed. Old `.old-` images from an earlier attempt are still removed at the next
// start, and the browser-host folder is replaced only when nothing holds it.
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

test('a build does not swap files under a running app', () => {
  const build = read('shell/build.ps1');
  assert.doesNotMatch(build, /Synapse was running; the old exe is/, 'the build still swaps under a running app');
  assert.doesNotMatch(build, /Move-Item \$target \$old/, 'a locked exe is moved aside again');
  assert.doesNotMatch(build, /\.old-/, 'the build never stages beside the live binary');
});
