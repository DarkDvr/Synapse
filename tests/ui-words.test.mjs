// The UI has no session concept (27 Oct).
//
// The engine still has sessions — that is its word for the thing Synapse shows
// as a project's chat — but the product does not. This is a guard against the
// old vocabulary creeping back into a label, a dialog or a control: the operator
// asked for it to be cleansed, and a rule that is only in a document is a rule
// that comes back. Internal identifiers (`state.sessionId`, `view: 'session'`)
// are deliberately not matched: they are the engine's id and a comment is not UI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('index.html says nothing about sessions or General', () => {
  const html = read('web/index.html');
  assert.doesNotMatch(html, /session/i, 'the page shell must not name sessions');
  assert.doesNotMatch(html, /\bGeneral\b/, 'General is gone');
});

test('the old session controls and wording are gone from app.js', () => {
  const js = read('web/app.js');
  for (const needle of [
    'New Session',
    'Sessions Still Inside',
    'TBD_TITLE',
    'Could not create a session',
    'Where new sessions run',
    'delete the session',
    'settingsGeneral',
    "'general', label: 'General'",
  ]) {
    assert.equal(js.includes(needle), false, `app.js still contains: ${needle}`);
  }
});

test('the dead session-row styles are gone from the stylesheet', () => {
  const css = read('web/synapse.css');
  for (const needle of ['.tree-row.session', '.tree-caret', '.tree-project-body', '.tree-sessions', '.tree-add-row', '.tree-rename']) {
    assert.equal(css.includes(needle), false, `synapse.css still contains: ${needle}`);
  }
});

// Phase 5 removed the function but left the project menu calling it, so Delete…
// threw instead of asking. The menu is only as good as the handler behind it.
test('the project menu’s Delete is wired to a client path that exists', () => {
  const js = read('web/app.js');
  assert.match(js, /data-menu-action="delete"/);
  assert.match(js, /async function removeProject\(id\)/);
  assert.match(js, /function recycleReason\(/);
  assert.match(js, /api\('DELETE', `\/api\/projects\//);
});

test('a permission chip is keyed by the tool call, never the request', () => {
  const js = read('web/app.js');
  assert.match(js, /permissionDecisions\?\.set\(decided\.toolCallId/);
  assert.doesNotMatch(js, /permissionDecisions\?\.set\(decided\.requestId/);
});

test('a sent message can be put back in the composer', () => {
  const js = read('web/app.js');
  assert.match(js, /data-reuse-msg/);
  assert.match(js, /function reuseMessage\(messageId\)/);
  assert.match(js, /function messageAttachments\(message\)/);
  assert.match(read('web/synapse.css'), /\.msg-reuse\s*\{/);
});

test('a You message keeps its parts on one vertical centre', () => {
  const css = read('web/synapse.css');
  assert.match(css, /\.msg\.user \.msg-body\s*\{[^}]*display: flex/);
  assert.match(css, /\.msg\.user \.msg-body\s*\{[^}]*align-items: flex-start/);
  assert.match(css, /\.msg\.user \.msg-role\s*\{[^}]*height: 18\.75px/);
  assert.match(css, /\.msg\.user \.msg-time\s*\{[^}]*height: 18\.75px/);
  assert.match(css, /\.msg\.user \.msg-time\s*\{[^}]*order: 99/);
});

test('the attachment budget is total size, with a count sanity cap', () => {
  const js = read('web/app.js');
  assert.match(js, /ATTACH_TOTAL_BYTES = 48 \* 1024 \* 1024/);
  assert.match(js, /ATTACH_MAX_COUNT = 24/);
  assert.match(js, /\.attach-total|attach-total/);
});

// "Views: 2" counted the window you were looking at as well as the laptop, and
// sat in the rail whether or not Remote Access was on. The LAN clients are what
// the address is for; they are named under it, and they hide with it.
test('the rail names LAN clients under the address, not a Views row', () => {
  const html = read('web/index.html');
  assert.doesNotMatch(html, /Views:/);
  assert.doesNotMatch(html, /id="viewsRow"/);
  assert.match(html, /id="remoteClients"/);
  const js = read('web/app.js');
  assert.match(js, /function renderClients\(/);
  assert.match(js, /clients: \$\{names\.length\}/);
  assert.doesNotMatch(js, /function renderViews\(/);
});

// The answer, not the work: the last text of a tool-free assistant message gets
// the green rule; narration in a step that also calls a tool stays plain.
test('the final answer has its own rule, and work does not', () => {
  const css = read('web/synapse.css');
  assert.match(css, /\.msg\.assistant \.msg-answer\.is-answer\s*\{[^}]*margin-top: 20px/);
  assert.match(css, /\.msg\.assistant \.msg-answer\.is-answer::before\s*\{[^}]*background: var\(--surface\)/);
  const js = read('web/app.js');
  assert.match(js, /is-answer/);
  assert.match(js, /hasTool/);
});
