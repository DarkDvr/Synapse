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

// 30 Oct: a card "disappeared before I could answer". The one click that can
// answer a card by accident is the one that also wakes the window, so both of
// the card's actions must go through the wake guard.
test('the click that wakes the window cannot answer a permission', () => {
  const js = read('web/app.js');
  assert.match(js, /function wakeClick\(\)/);
  assert.equal((js.match(/if \(wakeClick\(\)\)/g) || []).length, 2, 'Allow/Reject and Stop Run both guard');
  assert.match(js, /addEventListener\('focus', \(\) => \{ state\.focusAt = Date\.now\(\); \}\)/);
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
  assert.match(js, /workBefore/);
  assert.match(js, /toolAfter/);
});

// 31 Oct: the break is on both sides of the prose, not just above a turn's last text.
// A single-mode turn is one rule with cards and speech alternating inside it, so the
// prose ran into the cards above and below it and read as one more line of the run.
test('prose and cards are separated wherever they meet, either way round', () => {
  const css = read('web/synapse.css');
  const region = (sel) => {
    const at = css.indexOf(sel);
    assert.notEqual(at, -1, `${sel} is gone from the stylesheet`);
    return css.slice(at, at + 340);
  };
  assert.match(
    region('.msg.assistant .msg-body > :is(.reasoning, .tool-card) + .msg-answer'),
    /margin-top: 20px/,
    'prose after a card gets the gap above it',
  );
  assert.match(
    region('.msg.assistant .msg-body > .msg-answer + :is(.reasoning, .tool-card)'),
    /margin-top: 20px/,
    'a card after prose gets the gap above it, which is the gap under that prose',
  );
  assert.match(
    region('.msg.assistant .msg-body > :is(.reasoning, .tool-card) + .msg-answer::before'),
    /background: var\(--surface\)/,
    'the rule must be painted out for the height of the gap',
  );
  assert.match(
    region('.msg.assistant .msg-body > .msg-answer + :is(.reasoning, .tool-card)::before'),
    /background: var\(--surface\)/,
    'both directions break the rule',
  );
});

// 30 Oct UI pass: the operator moved the update check into the Settings rail,
// stopped the About page selling itself, and made notices easier to notice.
test('Updates is a Settings page above About, and About is just the facts', () => {
  const js = read('web/app.js');
  assert.match(js, /\{ id: 'updates', label: 'Check for Updates', icon: 'refresh' \}/);
  assert.ok(
    js.indexOf("{ id: 'updates'") < js.indexOf("{ id: 'about', label: 'About'"),
    'the Updates tab sits above About',
  );
  assert.match(js, /function settingsUpdates\(/);
  assert.match(js, /updates: settingsUpdates/);
  assert.match(js, /class="about-gap"/);
  assert.doesNotMatch(js, /about-lede|A self-contained harness for building software/);
  assert.match(read('web/synapse.css'), /\.about-gap\s*\{\s*height: 39px/);
});

test('every textual Close is the grey secondary button', () => {
  const html = read('web/index.html');
  const classes = [...html.matchAll(/<button class="([^"]+)"[^>]*>Close<\/button>/g)].map((m) => m[1]);
  assert.ok(classes.length >= 6, `expected the six Close buttons, found ${classes.length}`);
  for (const cls of classes) assert.match(cls, /\bbtn-secondary\b/, `Close is not secondary: ${cls}`);
  const js = read('web/app.js');
  assert.match(js, /data-close-about>Close<\/button>/);
  assert.match(js, /btn btn-secondary btn-sm[^>]*data-close-about/);
});

test('notices carry the yellow border and yellow text, and the work ring is twice as quick', () => {
  const css = read('web/synapse.css');
  assert.match(css, /\.toast\s*\{[^}]*border: 1px solid var\(--yellow\)/);
  assert.match(css, /\.toast\s*\{[^}]*color: var\(--yellow\)/);
  assert.match(css, /work-spin 2\.1s linear infinite/);
});

test('the provider Name control starts on the Type control’s line', () => {
  assert.match(read('web/synapse.css'), /\.prov-edit \.set-grid\s*\{[^}]*align-items: start/);
});

test('the Updates page is content-sized, and its footer button cannot stretch', () => {
  const css = read('web/synapse.css');
  assert.match(css, /\.upd-card\s*\{[^}]*align-content: start/);
  assert.match(css, /\.upd-card-foot\s*\{[^}]*align-items: center/);
  assert.match(css, /\.upd-md\s*\{[^}]*max-height: min\(42vh, 420px\)/);
  assert.doesNotMatch(css, /#settingsModal \.modal\.is-updates/);
  assert.doesNotMatch(read('web/app.js'), /classList\.toggle\('is-updates'/);
});

test('the Settings subtitle is an empty line, not the config sentence', () => {
  const html = read('web/index.html');
  assert.doesNotMatch(html, /Writes config\/synapse\.config\.json/);
  assert.match(html, /<p class="modal-sub" aria-hidden="true">&nbsp;<\/p>/);
});

