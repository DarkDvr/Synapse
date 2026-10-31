// A view must not report its own action back to itself as somebody else's.
//
// Every stream frame goes to every view, so a page cannot know "did I cause this?"
// unless the event says who did. It said nothing, and the UI filled the gap with
// "another computer" — a lie on a single-PC install. Measured 31 Oct, twice:
//
//  - opening Settings here and letting any view join (a second tab, a reload, a probe
//    page) closed the panel with "The settings are now being edited on ANDREWS";
//  - saving settings from the role pickers told the same page "Saved on another
//    computer", and toggling Remote Access announced the click a second time as
//    "Changed on ANDREWS".
//
// The rule: the event carries the id of the view that caused it, and a view ignores
// the ones that are its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the page gets the origin with every event it could have caused itself', () => {
  const js = read('web/app.js');
  assert.match(js, /ev\.lock\.id !== state\.clientId/, 'the presence frame names the holder');
  assert.match(js, /ev\.holder\.id !== state\.clientId/, 'the Settings lock frame too');
  assert.match(js, /ev\.byId !== state\.clientId/, 'a LAN switch moved elsewhere');
  assert.match(js, /ev\.byId === state\.clientId/, 'a settings save of its own');
  assert.doesNotMatch(js, /ev\.lock\.yours/, 'a broadcast frame cannot carry a per-client flag');
});

test('the server stamps the origin on those events', () => {
  const server = read('src/server.js');
  assert.match(server, /byId: actor\.id/, 'the remote switch says who moved it');
  assert.match(server, /saveConfig\(await readBody\(req\), actorOf\(req\)\)/, 'a save knows who saved');
  const api = read('src/api.js');
  assert.match(api, /saveConfig: async \(body, actor = null\)/);
  assert.match(api, /byId: actor\?\.id \|\| null/);
});
