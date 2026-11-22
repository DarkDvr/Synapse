// The WebView2 host's small contract: where its files live, and how one JSONL line
// becomes the record the chat and the click tool see. No browser is started here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hostFiles, downloadRecord, readHostState, hostBinary } from '../src/browser/webview2.js';
import { tmpdir } from './tmpdir.mjs';

test('the host state and download log sit beside the profile, not inside it', () => {
  const profile = path.join('F:', 'dev', 'Synapse', 'data', 'browser', 'webview2');
  const files = hostFiles({ profile });
  assert.equal(files.profile, profile);
  assert.equal(files.stateFile, path.join('F:', 'dev', 'Synapse', 'data', 'browser', 'webview2-state.json'));
  assert.equal(files.downloadsFile, path.join('F:', 'dev', 'Synapse', 'data', 'browser', 'webview2-downloads.jsonl'));
});

test('a host download event becomes the record the page draws', () => {
  const started = downloadRecord({ event: 'starting', id: 'a1', name: 'mod.zip', path: 'C:\\p\\mod.zip', total: 10, startedAt: 5 });
  assert.deepEqual(
    { state: started.state, name: started.name, received: started.received, total: started.total, path: started.path, startedAt: started.startedAt },
    { state: 'inProgress', name: 'mod.zip', received: 0, total: 10, path: 'C:\\p\\mod.zip', startedAt: 5 },
  );
  const progress = downloadRecord({ event: 'progress', id: 'a1', received: 4, total: 10, startedAt: 5 });
  assert.equal(progress.state, 'inProgress');
  assert.equal(progress.received, 4);
  const done = downloadRecord({ event: 'completed', id: 'a1', name: 'mod.zip', path: 'C:\\p\\mod.zip', received: 10, total: 10, startedAt: 5, endedAt: 9 });
  assert.equal(done.state, 'completed');
  assert.equal(done.endedAt, 9);
  assert.equal(done.received, 10);
  const failed = downloadRecord({ event: 'interrupted', id: 'a2', error: 'FileFailed', startedAt: 5, endedAt: 6 });
  assert.equal(failed.state, 'interrupted');
  assert.equal(failed.error, 'FileFailed');
  assert.equal(downloadRecord(null), null);
  assert.equal(downloadRecord({ event: 'starting' }), null, 'an event with no id is not a download');
});

test('the state file is read without a BOM', () => {
  const dir = tmpdir('synabrowse-host-state-');
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '\uFEFF{"state":"ready","port":1234}', 'utf8');
  assert.deepEqual(readHostState(file), { state: 'ready', port: 1234 });
  assert.equal(readHostState(path.join(dir, 'missing.json')), null);
});

test('the host binary is the one the build publishes', () => {
  const exe = hostBinary();
  assert.ok(exe, 'run shell\\build.ps1: bin\\browser-host\\SynaBrowseHost.exe is missing');
  assert.ok(exe.endsWith('SynaBrowseHost.exe'), exe);
});
