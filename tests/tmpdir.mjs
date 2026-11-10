// A temp folder for one test, removed when the process ends.
//
// `node --test` runs every test file in its own process. A file that throws never
// reaches its own `finally`, and a fixture folder it made stays behind — measured
// on 10 Nov: 15,638 folders and 61 MB after about a hundred runs. Every fixture
// now goes through `tmpdir()` instead: the folder is registered here, and the last
// thing the process does is empty it. A test may still delete its own folder early;
// the sweep simply finds it gone.
//
// Two honest limits. The hook is synchronous because Node will not run async work
// on `exit`, so the cleanup is `rmSync`. And a process that is killed outright
// (SIGKILL, a hard taskkill) never reaches the hook: that leaves one folder, which
// is why the count is a check rather than a promise.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const made = new Set();
let hooked = false;

function sweep() {
  for (const dir of made) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      // An exit hook has nowhere to report to. A folder that will not go is the
      // next run's problem, not this test's failure.
    }
  }
  made.clear();
}

/**
 * Make a unique temp folder and remember it for the exit sweep.
 * The prefix is the name a person reads in %TEMP% while debugging, so keep it
 * specific: `synapse-doc-` says which test left it, `synapse-` does not.
 */
export function tmpdir(prefix = 'synapse-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.add(dir);
  if (!hooked) {
    hooked = true;
    process.on('exit', sweep);
  }
  return dir;
}
