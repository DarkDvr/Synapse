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
// The page is several modules now (app.js plus the ones that left it), so "the page
// says" reads them all: a move must not read as a deletion.
const ui = () =>
  [
    'web/app.js',
    'web/settings-panes.js',
    'web/settings-form.js',
    'web/ui-prefs.js',
    'web/traces.js',
    'web/run-view.js',
    'web/chat-scroll.js',
    'web/chat-notes.js',
    'web/rate-view.js',
    'web/providers.js',
    'web/provider-list.js',
    'web/transcript.js',
    'web/composer.js',
    'web/toast.js',
    'web/model-picker.js',
    'web/run-menu.js',
    'web/mode.js',
  ]
    .map(read)
    .join('\n');

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
  ]) {
    assert.equal(js.includes(needle), false, `app.js still contains: ${needle}`);
  }
  // A General tab is allowed again as of 2 Nov — the operator asked for one to hold
  // the interface's own settings — but it must be a *pane with a job*, not the old
  // placeholder that was retired. A tab that names itself and shows nothing is the
  // thing this file used to guard against.
  assert.match(ui(), /function settingsGeneral\(c\)\s*\{/);
  assert.match(ui(), /setField\(c, 'Chat Text Size', 'ui\.chatTextPx'/);
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
  // 7 Nov: the menu is its own module.
  const js = read('web/project-menu.js');
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
// answer a card by accident is the one that also wakes the window — but only a
// card that appeared under the pointer. A card that has been waiting has been
// read, and a click on it answers at once; the guard is the fresh card, not every
// click after focus.
test('the click that wakes the window cannot answer a fresh permission card', () => {
  const js = read('web/app.js');
  assert.match(js, /function wakeClick\(e, requestId\)/);
  // Allow/Reject, Stop Run, and Reject With Reason all guard.
  assert.equal((js.match(/if \(wakeClick\(e, /g) || []).length, 3, 'all three card actions guard');
  assert.match(js, /state\.permSeen/, 'the card birth time is remembered');
  assert.match(js, /Date\.now\(\) - seen >= 2000/, 'an older card is answered at once');
  assert.doesNotMatch(js, /That click only brought the window forward/, 'the toast is gone');
  assert.match(js, /addEventListener\('focus', \(\) => \{ state\.focusAt = Date\.now\(\); \}\)/);
});

test('an attached picture uses the same chip as a picture the model shows', () => {
  const js = ui();
  assert.match(js, /class="chat-image" data-msg=/);
  assert.match(js, /function attachmentImage\(/);
  assert.match(js, /attachmentImage\(message, Number\(chip\.dataset\.file/);
});

test('a sent message can be put back in the composer', () => {
  const js = ui();
  assert.match(js, /data-reuse-msg/);
  assert.match(js, /function reuseMessage\(messageId\)/);
  assert.match(js, /function messageAttachments\(message\)/);
  assert.match(read('web/synapse.css'), /\.msg-reuse\s*\{/);
});

test('a You message keeps its parts on one vertical centre', () => {
  const css = read('web/synapse.css');
  assert.match(css, /\.msg\.user \.msg-body\s*\{[^}]*display: flex/);
  assert.match(css, /\.msg\.user \.msg-body\s*\{[^}]*align-items: flex-start/);
  // One line of chat text is 1.5 × its size, and the role and the clock are boxes
  // that height so their glyphs centre on it. Both must follow --chat-fs: the size
  // setting would otherwise put the label and the clock off the message's centre
  // line at every size but the default.
  assert.match(css, /\.msg\.user \.msg-role\s*\{[^}]*height: calc\(var\(--chat-fs\) \* 1\.5\)/);
  assert.match(css, /\.msg\.user \.msg-time\s*\{[^}]*height: calc\(var\(--chat-fs\) \* 1\.5\)/);
  assert.match(css, /\.msg\.user \.msg-time\s*\{[^}]*order: 99/);
});

test('the attachment budget is total size, with a count sanity cap', () => {
  const js = ui();
  assert.match(js, /ATTACH_TOTAL_BYTES = 48 \* 1024 \* 1024/);
  assert.match(js, /ATTACH_MAX_COUNT = 24/);
  assert.match(js, /\.attach-total|attach-total/);
});

// 4 Nov: a steer only appeared once the engine had delivered it, which can be
// minutes. The page paints the operator's own sentence at once, and keeps it
// until the transcript carries it.
test('a steer is on screen before the engine echoes it', () => {
  const js = ui();
  assert.match(js, /local-steer-/);
  assert.match(js, /startsWith\('local-steer-'\)/);
  assert.match(js, /text: `\[steer\] \$\{text\}`/);
});

// 4 Nov: the answer box behind "Something Else" is prose. Enter is a newline and
// Ctrl+Enter sends, the same as the chat composer; every other ask field keeps
// Enter-to-move-on.
test('Something Else answers like the chat: Enter newline, Ctrl+Enter sends', () => {
  // 6 Nov: the field is drawn by ./ask-panel.js; its key and click handlers are wired
  // in app.js, so the rule is read across both.
  const js = read('web/ask-panel.js') + read('web/app.js');
  assert.match(js, /<textarea class="ask-input ask-other-text"/);
  assert.match(js, /closest\?\.\('\.ask-other-text'\)/);
  assert.match(js, /e\.ctrlKey \|\| e\.metaKey/);
  const css = read('web/synapse.css');
  assert.match(css, /\.ask-opt \.ask-other-text/);
  assert.match(css, /field-sizing: content/);
});

// 4 Nov: the wake lock. Settings owns both halves; the cog has only the master.
test('Keep PC Awake is in Settings and the cog, with the monitor as the second half', () => {
  const js = ui();
  assert.match(js, /'Keep PC Awake'/);
  assert.match(js, /'Also Keep The Monitor On'/);
  assert.match(js, /async function togglePower/);
  assert.match(js, /\/api\/power/);
  const html = read('web/index.html');
  assert.match(html, /id="run_keepAwake"/);
  assert.match(html, /data-power="keepAwake"/);
});

// 4 Nov: a provider that reports `reasoning: 0` while writing reasoning must not be
// described as "0% was reasoning" — the header uses the same truth as the body.
test('the run header does not claim 0% reasoning when it was not split', () => {
  const src = read('src/runs.js');
  assert.match(src, /tokens \(\$\{thinkNote\(context\)\}\)/);
  assert.doesNotMatch(src, /% was reasoning/);
});

// 4 Nov: a role card shows Blocked only while the harness is actually stuck on the
// task — not for an old blocker the role has worked past, and not during the
// Architect's own turn.
test('a role is only Blocked while the plan is genuinely stuck', () => {
  // 7 Nov: the cards' activity moved to ./live-runs.js.
  const js = read('web/live-runs.js');
  assert.match(js, /const blocked = blockedTasks\.length > 0 && !archBusy && !run && !anyReady;/);
  assert.match(js, /const stuck = blockedTasks\[0\];/);
});

// 4 Nov: the PROHIBITED list is a table — the path, a Write box, a Read box, and
// a delete button that is disabled for the ones Synapse ships.
test('Prohibited is a table with a Write and a Read box per row', () => {
  const js = ui();
  assert.match(js, /id: 'prohibited', label: 'Prohibited'/);
  assert.match(js, /function settingsProhibited/);
  assert.match(js, /data-prot-write=/);
  assert.match(js, /data-prot-read=/);
  assert.match(js, /data-prot-del=/);
  assert.match(js, /class="prot-head">Write</);
  assert.match(js, /class="prot-head">Read</);
  assert.match(js, /Built-in paths can be switched off but not removed/);
  const css = read('web/synapse.css');
  assert.match(css, /\.prot-row \{/);
  assert.match(css, /\.prot-x:disabled/);
  assert.match(css, /\.msg\.harness\.is-prohibited/);
});

// 4 Nov: the guard no longer rewrites the effort; it counts loops and sets the
// model aside at the limit. The setting is a number beside the switch.
test('the loop setting is a count, and the card says what happened', () => {
  const js = ui();
  assert.match(js, /worker\.loopLimit/);
  assert.match(js, /asking it to carry on/);
  assert.match(js, /marked ISSUES, next coder/);
  assert.doesNotMatch(js, /lowering reasoning to/);
});

// 4 Nov: settings had a wall of grey notes in a coder's voice. What is left is
// short and only where it has to be seen; the rest is a tooltip.
test('the settings panes keep only a few short notes', () => {
  const js = read('web/app.js');
  const notes = js.match(/class="set-note"/g) || [];
  assert.ok(notes.length <= 6, `set-note blocks: ${notes.length}`);
  assert.match(read('web/settings-form.js'), /export const setGroup = \(title, body, cols, hint = ''\)/, 'a group can carry its own tooltip');
});

// 4 Nov: the operator arranged providers in Settings and the model menu sorted
// by label instead; the rail's project order was likewise fixed. Both orders are
// now the operator's, saved with the config / the registry.
test('the rail and the model menu follow the order the operator arranged', () => {
  // 7 Nov: the project menu is its own module; the rail's rows are in projects.js.
  const menu = read('web/project-menu.js');
  // The order itself moved to ./provider-list.js (6 Nov) — it is one answer three
  // parts of the page need — so the rule is read where it lives now.
  assert.match(read('web/provider-list.js'), /function providerOrderOf\(/);
  // 7 Nov: the menu itself is its own module now.
  assert.match(read('web/model-picker.js'), /rankOf\(a\.provider\) - rankOf\(b\.provider\)/);
  assert.match(read('web/providers.js'), /data-prov-up=|data-prov-down=/);
  assert.match(read('web/providers.js'), /function moveProvider\(/);
  assert.match(menu, /data-menu-action="up"|data-menu-action="down"/);
  assert.match(menu, /\/api\/projects\/\$\{encodeURIComponent\(id\)\}\/move/);
});

// 4 Nov: a moved project row should read as one motion, and the model picker
// needed about six more characters for the names it holds.
test('a moved project slides, and the model picker is six characters wider', () => {
  // 7 Nov: the move lives in the project menu's module.
  const js = read('web/project-menu.js');
  assert.match(js, /row\.animate\(\[\{ transform: `translateY\(\$\{dy\}px\)` \}/);
  assert.match(js, /prefers-reduced-motion/);
  const css = read('web/synapse.css');
  assert.match(css, /\.model-search \{[^}]*width: 30ch/);
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
  // 4 Nov: the second line "or http://192.168.1.38:8700/" went, and the names of
  // the machines moved from the rail into the tooltip - the line is a count.
  assert.doesNotMatch(js, /remoteIp|status-remote-ip/);
  assert.doesNotMatch(html, /id="remoteIp"/);
  assert.match(js, /Connected clients: \$\{names\.join\(', '\)\}/);
  assert.doesNotMatch(js, /network has not given/, 'an unnamed client shows its address, not a note');
  assert.doesNotMatch(js, /function renderViews\(/);
});

// 1 Nov: a compact is meant to leave one post, not a list of the runs that came
// before it. The folds and the amber alarm lines are page state per project, so they
// outlived the conversation they described and reappeared above the fresh chat.
test('a compact takes the discarded chat’s folds and alarms with it', () => {
  const js = read('web/app.js');
  const at = js.indexOf("ev.type === 'project.compacted'");
  assert.notEqual(at, -1, 'the compacted event is still handled');
  const branch = js.slice(at, at + 1200);
  assert.match(branch, /forgetConversation\(/, 'the handler clears them before opening the new chat');
  // 6 Nov: the fold store went to ./traces.js with the trace it belongs to.
  const traces = read('web/traces.js');
  assert.match(traces, /function forgetConversation\(dir, oldSessionId\)/);
  assert.match(traces, /state\.traces\.delete\(k\)/, 'the folds go');
  assert.match(traces, /state\.alarms = state\.alarms\.filter/, 'the alarm lines go');
});

// 1 Nov: the engine announces every instruction file it loads and posts the whole text,
// so android\AGENTS.md (a hundred lines) landed in the chat the moment it was compacted.
// It stays in the model's context; the chat shows one line.
test('a file the engine loads is one collapsed line, not its whole text', () => {
  const js = ui();
  assert.match(js, /\^loaded\\s\/i\.test/, 'the loaded-instructions message is recognised');
  assert.match(js, /Instructions from \$\{esc\(short\)\}/, 'the line names the file, not the whole path');
  assert.match(js, /data-k="\$\{esc\(key\)\}"/, 'each one keeps its own open state');
  const css = read('web/synapse.css');
  assert.match(css, /\.chat-post-note \{[^}]*text-overflow: ellipsis/, 'and it stays one line');
});

// The answer, not the work: the last text of a tool-free assistant message gets
// the green rule; narration in a step that also calls a tool stays plain.
test('the final answer has its own rule, and work does not', () => {
  const css = read('web/synapse.css');
  assert.match(css, /\.msg\.assistant \.msg-answer\.is-answer\s*\{[^}]*margin-top: 20px/);
  assert.match(css, /\.msg\.assistant \.msg-answer\.is-answer::before\s*\{[^}]*background: var\(--surface\)/);
  const js = ui();
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
  const js = ui();
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
  const js = read('web/settings-panes.js');
  assert.match(js, /data-close-about>Close<\/button>/);
  assert.match(js, /btn btn-secondary btn-sm[^>]*data-close-about/);
});

// Save Changes retired: the footer is Cancel and Revert on the left, Apply and
// one primary on the right. The primary's label is the thing it will do, and the
// X is gone — Cancel is the way out.
test('the settings footer has one honest primary, not a Save Changes', () => {
  const html = read('web/index.html');
  assert.match(html, /id="cancelSettings"[^>]*>Cancel<\/button>/);
  assert.match(html, /id="revertSettings"[^>]*>Revert<\/button>/);
  assert.match(html, /id="applySettings"[^>]*disabled>Apply<\/button>/);
  assert.match(html, /id="settingsPrimary"/);
  assert.doesNotMatch(html, /id="closeSettings"/);
  assert.doesNotMatch(html, /id="saveSettings"/);
  // 7 Nov: the Settings window's controller is its own module.
  const js = read('web/settings-window.js');
  assert.match(js, /'Save & Restart'/);
  assert.match(js, /'Save & Close'/);
  assert.match(js, /primary\.dataset\.action =/);
  // 6 Nov: the Updates page was the one tab without the footer, which read as a
  // different window rather than a Settings page. Only About keeps its own Close
  // inside the card; every other tab wears the same four buttons.
  assert.match(js, /foot\.hidden = state\.settingsTab === 'about';/);
  assert.doesNotMatch(js, /state\.settingsTab !== 'updates'/);
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
  // 6 Nov: the footer came back to this page, which cost it 46px, and the changelog
  // is open by default whenever a release has notes — so its cap is what decides
  // whether the page fits. Measured at 42vh: 520px cards, 70px of overflow. The cap
  // is now a quarter of the window and the pane fits without scrolling.
  assert.match(css, /\.upd-md\s*\{[^}]*max-height: min\(26vh, 250px\)/);
  assert.doesNotMatch(css, /#settingsModal \.modal\.is-updates/);
  assert.doesNotMatch(read('web/app.js'), /classList\.toggle\('is-updates'/);
});

test('the Settings subtitle is an empty line, not the config sentence', () => {
  const html = read('web/index.html');
  assert.doesNotMatch(html, /Writes config\/synapse\.config\.json/);
  assert.match(html, /<p class="modal-sub" aria-hidden="true">&nbsp;<\/p>/);
});


// ── the question is a chat post (2 Nov) ────────────────────────────────
// It was an overlay that covered the reply the question was about. The operator could
// not see what had been said, so answering meant guessing. It is now the last thing in
// the transcript — and the two things that make that safe are that the node is
// *moved* rather than rebuilt (or a poll would eat the answers) and that it is sized
// to the chat (or Submit lands below the fold).
test('the question is a moved post in the transcript, not an overlay', () => {
  const css = read('web/synapse.css');
  const host = /\.ask-host\s*\{([^}]*)\}/.exec(css);
  assert.ok(host, 'the host has a rule');
  assert.doesNotMatch(host[1], /position:\s*absolute/, 'an overlay hides the answer it is about');
  const js = read('web/ask-panel.js');
  assert.match(js, /function mountAskPost\(\)/, 'the panel has one place that places it');
  assert.match(js, /el\.appendChild\(host\)/, 'it is appended to the transcript');
  assert.match(js, /el\.lastElementChild !== host/, 'and kept as the last post');
  // The question posts in its entirety: no cap and no inner scroll. A box you have
  // to scroll *inside* a chat is a question with two scrollbars.
  const panel = /\.ask-panel\s*\{([^}]*)\}/.exec(css);
  assert.doesNotMatch(panel[1], /max-height\s*:/, 'the panel is not capped');
  const fields = /\.ask-fields\s*\{([^}]*)\}/.exec(css);
  assert.doesNotMatch(fields[1], /overflow:\s*auto/, 'and nothing scrolls inside it');
  // Dense answers: a list, not a stack of boxes.
  const opt = /\.ask-opt\s*\{([^}]*)\}/.exec(css);
  assert.match(opt[1], /border:\s*0/, 'an answer is not a bordered box any more');
  assert.match(panel[1], /border:\s*1px solid var\(--orange\)/, 'the edge stays orange: it is what makes the post a question');
  assert.doesNotMatch(panel[1], /background:\s*#241a12/, 'the fill is neutral — the orange is the border, not a wash');
  assert.doesNotMatch(js, /fitAskPanel/, 'no height fitting is left behind');
});

test('the composer reads the send button before it uses it', () => {
  // A line-edit put `sendBtn.disabled = …` above its own `const` and the whole page
  // died at boot with "Cannot access 'sendBtn' before initialization" — the rail
  // empty, no explanation on screen (3 Nov). Cheap guard, expensive bug.
  // 6 Nov: the composer is its own module now.
  const js = read('web/composer.js');
  const start = js.indexOf('function renderComposer');
  const body = js.slice(start, js.indexOf('\nfunction ', start + 10));
  const decl = body.indexOf("const sendBtn = $('sendBtn')");
  const use = body.indexOf('sendBtn.disabled');
  assert.ok(decl > 0 && use > 0, 'both lines exist');
  assert.ok(decl < use, 'the declaration comes first');
});

test('a pending question takes the composer, and leaves Stop as the way out', () => {
  const js = ui();
  const block = /for \(const id of \['attachBtn', 'modeToggle', 'runBtn'\]\) \{([\s\S]*?)\}/.exec(js);
  assert.ok(block, 'the composer controls are switched off together');
  // `blocked` is a question *or* a pending permission: both mean the turn cannot
  // read a message until the operator answers (3 Nov).
  assert.match(block[1], /disabled = blocked/);
  assert.match(js, /const blocked = asking \|\| awaitingPermission;/);
  assert.doesNotMatch(block[1], /stopBtn/, 'Stop stays live: it is the way out of a question nobody can answer');
});

// ── the Architect's own step streams like a worker's (2 Nov) ──────────
test('the open session has a trace, so its reasoning streams instead of dumping', () => {
  const js = read('web/app.js');
  // 6 Nov: the streaming panel and the follow rule moved to ./chat-scroll.js, so the
  // half of this rule that lives there is read there.
  const scroll = read('web/chat-scroll.js');
  assert.match(scroll, /function liveTrace\(\)/, 'one place answers whose writing this is');
  assert.match(scroll, /const trace = liveTrace\(\);/, 'the stream pump uses it');
  // It used to be `traceOf(currentRun())`, which is null for the Architect: every
  // delta it produced was dropped and the wall arrived at the step boundary.
  assert.doesNotMatch(scroll, /function appendStream\(kind, delta\) \{\s*const trace = traceOf\(currentRun\(\)\);/, 'appendStream no longer ignores the session');
  // The store moved to web/state.js when app.js began to come apart; the trace is
  // still a field of it, so the assertion follows the field.
  const store = read('web/state.js');
  assert.match(store, /sessionTrace: \{ key: '', stream: null \}/, 'the session has a trace of its own');
  assert.match(read('web/traces.js'), /function renderSessionStream\(\)/, 'and a panel to draw it in');
  assert.match(js, /state\.sessionTrace\.stream = null;/, 'the stream is cleared when the turn ends');
});
// The panel used to vanish for a whole turn: the transcript's innerHTML replaced its
// children (the panel among them), and the code that re-appends it looked it up with
// getElementById — which cannot find a node that is no longer in the document. The
// composer said "Answer the question to continue" and there was no question on
// screen until a reload rebuilt the page (reported and reproduced 2 Nov).
test('the question panel survives a transcript rebuild because the node is held', () => {
  const js = read('web/ask-panel.js');
  assert.match(js, /let askHostEl = null;/, 'the node is kept in a variable');
  assert.match(js, /function askHost\(\) \{/, 'and looked up through one accessor');
  for (const fn of ['renderAskPanel', 'mountAskPost']) {
    const block = new RegExp(`function ${fn}\\(\\) \\{([\\s\\S]*?)\\n\\}`).exec(js);
    assert.ok(block, `${fn} exists`);
    assert.match(block[1], /const host = askHost\(\)/, `${fn} uses the held node, not getElementById`);
    assert.doesNotMatch(block[1], /\$\('askHost'\)/, `${fn} must not look the node up by id again`);
  }
});
// The live step is part of the Architect's post, not a second block after it.
// Reported 2 Nov: a grey panel with its own "Architect · Thinking" head and its own
// gap, reading as somebody else's message under a green one.
test('the Architect’s live reasoning is drawn inside its own post', () => {
  // 6 Nov: the renderer moved to ./transcript.js, the panel to ./traces.js.
  const js = read('web/transcript.js');
  // 6 Nov: the panel itself moved to ./traces.js with the trace it draws.
  const traces = read('web/traces.js');
  // renderMessage takes the tail and puts it inside .msg-body, which carries the
  // speaker's 2px rule.
  assert.match(js, /function renderMessage\(m, tail = ''\) \{/);
  assert.match(js, /<div class="msg-body">\$\{body\.join\(''\)\}\$\{tail\}<\/div>/, 'the tail lands inside the post');
  assert.match(js, /const liveTail = renderSessionStream\(\);/, 'the live step is computed once');
  assert.match(js, /renderMessage\(m, i === showable\.length - 1 && m\.type === 'assistant' \? liveTail : ''\)/, 'and only the newest assistant message carries it');
  assert.doesNotMatch(js, /el\.innerHTML = html \+ pending \+ renderSessionStream\(\)/, 'it is not appended after the conversation any more');
  // No head line: the post already says who is speaking.
  const fn = /function renderSessionStream\(\) \{([\s\S]*?)\n\}/.exec(traces);
  assert.doesNotMatch(fn[1], /trace-head/, 'no second speaker label');
  assert.match(fn[1], /is-live is-own/);
  const css = read('web/synapse.css');
  const own = /\.trace\.is-own \{([^}]*)\}/.exec(css);
  assert.ok(own, 'the embedded panel has its own rule');
  assert.match(own[1], /border:\s*0/, 'no rule of its own: the post provides it');
  assert.match(own[1], /margin:\s*3px 0 0/, 'and no gap above');
  // Reported 2 Nov: the panel also lost its *box*, so a long reasoning turn was a
  // wall of italic text with no edge to it. It is the same bordered, clipped window
  // the workers get — only the head line and the left rule are dropped.
  assert.match(css, /\.trace-flow \{[^}]*border:\s*1px solid/, 'the scrolling panel keeps its hairline box');
  assert.doesNotMatch(css, /\.trace\.is-own \.trace-flow \{[^}]*border:\s*0/, 'the embedded panel does not strip it again');
});

test('jumping to the question puts it at the top of the chat', () => {
  // 6 Nov: the jump itself moved to ./chat-scroll.js with the rest of the scrolling.
  const js = read('web/chat-scroll.js');
  // The 46px landing was a workaround for the floating buttons covering the header.
  assert.match(js, /const top = Math\.max\(0, tops\[next\] - 10\);/);
  const css = read('web/synapse.css');
  // The note is flush with the panel's right edge. It used to stop 104px short for
  // the floating jump buttons; the operator's answer to that was "ignore them, they
  // are right above it and I can scroll" (3 Nov), so there is no reserve at all.
  assert.match(css, /\.ask-head \{[^}]*padding-right:\s*0/);
  assert.doesNotMatch(css, /padding-right:\s*104px/, 'no nav reserve is left behind');
});