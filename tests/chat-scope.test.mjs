// A card, a question and a stop belong to their chat — never to "whatever is open".
//
// The bug this file exists for (20 Nov): with two projects working at once, one
// project's permission card was drawn in the other project's chat, any project's card
// froze any project's composer, a question from another project appeared under this
// chat's report, and a stop in one chat put "Stopping…" on the other. The rule is one
// key — the project's folder — and these are the assertions that keep it one.
//
// Run: bin\node\node.exe --test tests\chat-scope.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installPage } from './fake-page.mjs';

installPage();
const { state } = await import('../web/state.js');
const { permissionsHere, formsHere, currentForm, waitingIn, askDir, sameChat, dirKey } = await import('../web/run-view.js');
const { renderPermissionCards } = await import('../web/permission-card.js');
const { chatStates, transitions, createAttention, holdFinish, FINISH_GRACE_MS } = await import('../web/attention.js');

const A = 'F:\\dev\\Synapse.Projects\\alpha';
const B = 'F:\\dev\\Synapse.Projects\\beta';

function page({ session = 'ses_a', runs = new Map() } = {}) {
  installPage();
  state.projects = [
    { id: 'a', name: 'Alpha', directory: A, sessions: [{ id: 'ses_a' }] },
    { id: 'b', name: 'Beta', directory: B, sessions: [{ id: 'ses_b' }] },
  ];
  state.sessionId = session;
  state.runs = runs;
  state.busySessions = new Set();
  state.busySince = new Map();
  state.busyInfo = null;
  state.busyInfoSession = null;
  state.permissions = [];
  state.forms = [];
  state.permSeen = new Map();
  state.permWakeOk = new Set();
  state.view = 'session';
  return state;
}

test('a card belongs to the chat whose folder it asks in', () => {
  page();
  state.permissions = [
    { requestId: 'p_alpha', sessionId: 'ses_a_worker', directory: A, scope: 'outside' },
    { requestId: 'p_beta', sessionId: 'ses_b', directory: B, scope: 'outside' },
  ];
  assert.deepEqual(permissionsHere().map((p) => p.requestId), ['p_alpha'], 'another chat’s card was drawn here');
  assert.equal(waitingIn(B), 'decision', 'the rail lost the other chat’s card');
  // Alpha's own card marks Alpha; a chat with nothing waiting is not marked.
  assert.equal(waitingIn(A), 'decision');
  assert.equal(waitingIn('F:\\dev\\Synapse.Projects\\gamma'), null, 'a card in another chat marked this one');
});

test('a question belongs to the chat whose folder it asks in', () => {
  page();
  state.forms = [
    { id: 'f_alpha', sessionId: 'ses_a_worker', directory: A, fields: [] },
    { id: 'f_beta', sessionId: 'ses_b', directory: B, fields: [] },
  ];
  assert.deepEqual(formsHere().map((f) => f.id), ['f_alpha']);
  assert.equal(currentForm()?.id, 'f_alpha', 'the panel picked another chat’s question');
  assert.equal(waitingIn(B), 'answer');
});

test('a hidden worker’s ask finds its chat through the run, not the project list', () => {
  const runs = new Map([[dirKey(A), { dir: A, architect: 'ses_a', workerId: 'ses_w' }]]);
  page({ runs });
  state.forms = [{ id: 'f_worker', sessionId: 'ses_w', fields: [] }];
  // A worker's session is not in the rail, and the server may have no directory for
  // an ask made before the run record arrived: the run is the second source.
  assert.equal(askDir(state.forms[0]), dirKey(A));
  assert.equal(currentForm()?.id, 'f_worker', 'a worker’s question was not in its own chat');
});

test('the composer is blocked by this chat’s card, not another project’s', async () => {
  page();
  const { renderComposer, composerWiring } = await import('../web/composer.js');
  // renderComposer redraws the compact chip and the rail after every state change; a
  // renderer that is missing a wire throws by design, so the test names them.
  composerWiring({
    loadMessages: async () => {},
    refreshPending: async () => {},
    renderCompactChip() {},
    renderTree() {},
  });
  state.permissions = [{ requestId: 'p_beta', sessionId: 'ses_b', directory: B, scope: 'outside' }];
  renderComposer();
  const input = globalThis.document.getElementById('promptInput');
  assert.equal(input.disabled, false, 'another project’s card froze this composer');
  state.permissions = [{ requestId: 'p_alpha', sessionId: 'ses_a', directory: A, scope: 'outside' }];
  renderComposer();
  assert.equal(globalThis.document.getElementById('promptInput').disabled, true, 'this chat’s own card must block it');
});

test('only this chat’s cards are drawn', () => {
  page();
  state.permissions = [
    { requestId: 'p_alpha', sessionId: 'ses_a_worker', directory: A, scope: 'outside', action: 'read', resources: ['F:\\temp\\x'] },
    { requestId: 'p_beta', sessionId: 'ses_b', directory: B, scope: 'outside', action: 'read', resources: ['F:\\temp\\y'] },
  ];
  const html = renderPermissionCards();
  assert.match(html, /p_alpha/);
  assert.doesNotMatch(html, /p_beta/, 'a card from another project was drawn in this chat');
});

test('a stop in another chat is not this chat’s stop', async () => {
  page();
  const { handleRunEvent } = await import('../web/live-runs.js');
  state.stopping = false;
  handleRunEvent({ kind: 'run', type: 'run.stopping', dir: B, task: 't1' });
  assert.equal(state.stopping, false, 'another chat’s stop put “Stopping…” on this one');
  assert.equal(sameChat(A), true);
  assert.equal(sameChat(B), false);
});

test('an ask that names no chat is drawn where you are, and never marks a project', () => {
  page();
  state.permissions = [{ requestId: 'p_unplaced', scope: 'browser', action: 'browser', resources: [] }];
  assert.deepEqual(permissionsHere().map((p) => p.requestId), ['p_unplaced'], 'a sign-in with no chat was lost');
  assert.equal(waitingIn(A), null, 'an unplaced ask marked a project it does not belong to');
  state.permissions = [{ requestId: 'p_other', scope: 'outside', resources: [] }];
  assert.deepEqual(permissionsHere(), [], 'only a browser ask may be drawn without a chat');
});

test('the rail marks the project whose worker is waiting', async () => {
  const runs = new Map([[dirKey(B), { dir: B, architect: 'ses_b', workerId: 'ses_wb' }]]);
  page({ runs });
  state.permissions = [{ requestId: 'p_w', sessionId: 'ses_wb', directory: B, scope: 'outside' }];
  const { renderTree } = await import('../web/projects.js');
  renderTree();
  const html = globalThis.document.getElementById('projectTree').innerHTML;
  const row = (id) => html.split(`data-project-row="${id}"`)[1]?.split('tree-project')[0] || '';
  assert.match(row('b'), /tree-wait/, 'a hidden worker’s card did not mark its project');
  assert.doesNotMatch(row('a'), /tree-wait/, 'the mark landed on the wrong project');
});

test('an unchanged rail is not rebuilt, so its animation does not restart', async () => {
  page();
  const { renderTree } = await import('../web/projects.js');
  renderTree();
  const el = globalThis.document.getElementById('projectTree');
  el.innerHTML = 'sentinel';
  renderTree(); // nothing changed in the page's state
  assert.equal(el.innerHTML, 'sentinel', 'the rail was rebuilt for nothing and restarted its animation');
  state.view = 'none'; // a change must paint
  renderTree();
  assert.notEqual(el.innerHTML, 'sentinel', 'a rail that changed was not redrawn');
});

test('the waiting post names the server and who has it', async () => {
  const { waitPostHtml } = await import('../web/wait-post.js');
  assert.equal(waitPostHtml(null), '', 'no lease, no post');
  assert.equal(waitPostHtml({ waiting: null }), '');
  const html = waitPostHtml({
    waiting: { server: 'PolyStrata', holder: 'VPA - coder-1 b1', kind: 'send' },
    held: { server: 'PolyStrata', holder: 'VPA - coder-1 b1' },
  });
  assert.match(html, /waiting for the local server/);
  assert.match(html, /PolyStrata/);
  assert.match(html, /VPA - coder-1 b1/);
  assert.match(html, /starts when that turn ends/, 'the post must say what happens next');
});

test('states are per chat, and a finished chat is reported once', () => {
  const projects = [
    { directory: A, sessions: [{ id: 'ses_a' }] },
    { directory: B, sessions: [{ id: 'ses_b' }] },
  ];
  const before = chatStates({ projects, runs: new Map([[dirKey(B), { dir: B }]]), permissions: [], forms: [] });
  assert.deepEqual(before.get(dirKey(A)), { working: false, blocked: false });
  assert.deepEqual(before.get(dirKey(B)), { working: true, blocked: false });

  // Beta's worker reported; Alpha's Architect turn is live.
  const during = chatStates({
    projects,
    runs: new Map(),
    busySessions: new Set(['ses_a']),
    permissions: [],
    forms: [],
  });
  assert.deepEqual(transitions(before, during), [{ type: 'finished', key: dirKey(B) }]);
  // The very next look is not the same news again.
  assert.deepEqual(transitions(during, during), []);
});

test('a card that appears and is answered before the grace does not knock', () => {
  const timers = [];
  const events = [];
  const attention = createAttention({
    onBlocked: (key) => events.push(`blocked:${key}`),
    onFinished: (key) => events.push(`finished:${key}`),
    setTimer: (fn) => {
      const t = { fn, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.cleared = true;
    },
    finishDelayMs: 4000,
    blockDelayMs: 1200,
  });
  const key = dirKey(B);
  const state = (blocked, working = false) => new Map([[key, { working, blocked }]]);
  attention.note(state(false)); // baseline
  attention.note(state(true)); // a card arrives
  attention.note(state(false)); // the gate answered it
  for (const t of timers) if (!t.cleared) t.fn();
  assert.deepEqual(events, [], 'a card that came and went knocked');
});

test('a chat that finishes away from the screen chimes once, after the gap', () => {
  const timers = [];
  const events = [];
  const attention = createAttention({
    onFinished: (key) => events.push(key),
    setTimer: (fn) => {
      const t = { fn, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.cleared = true;
    },
  });
  const key = dirKey(B);
  const idle = new Map([[key, { working: false, blocked: false }]]);
  const working = new Map([[key, { working: true, blocked: false }]]);
  attention.note(working);
  attention.note(idle); // the gap the Architect uses to read the report
  attention.note(working); // the next task started
  attention.note(idle); // and finished
  for (const t of timers) if (!t.cleared) t.fn();
  assert.deepEqual(events, [key], 'the gap between two tasks chimed, or it chimed twice');
});

// The open chat used to chime the moment its work stopped, with the plan as its only guard.
// With Keep Building off the plan is right that no task is left, and the Architect still owes
// its turn — judging the report it was just handed. On 21 Nov the chime played into that gap
// while the workflow went on.
test('the open chat waits out the gap before it says the work is done', () => {
  const timers = [];
  const setTimer = (fn) => {
    const t = { fn, cleared: false };
    timers.push(t);
    return t;
  };
  const clearTimer = (t) => { if (t) t.cleared = true; };
  let working = false;
  let sounds = 0;
  const run = () => { sounds += 1; };

  // The report landed: hold the finish rather than play it.
  holdFinish(() => working, run, { setTimer, clearTimer });
  assert.equal(timers.length, 1, 'the finished-work chime was not held back');
  assert.equal(sounds, 0, 'it chimed the moment the worker stopped');

  // The Architect took the report within the grace: the hold is dropped, not sounded.
  working = true;
  timers[0].fn();
  assert.equal(sounds, 0, 'the chime played over the Architect reading its report');

  // Nothing followed the stop, so the same hold is the finish.
  working = false;
  holdFinish(() => working, run, { setTimer, clearTimer });
  const last = timers[timers.length - 1];
  assert.equal(last.cleared, false, 'a fresh gap reused a cancelled hold');
  last.fn();
  assert.equal(sounds, 1, 'a chat that really finished made no sound');

  // And work resuming before the grace is up cancels it outright.
  working = false;
  const held = holdFinish(() => working, run, { setTimer, clearTimer });
  held.cancel();
  assert.equal(timers[timers.length - 1].cleared, true, 'the hold was not cancelled');
});

test('a stopped chat does not chime, and the open chat is left to noteWorking', () => {
  const events = [];
  const attention = createAttention({
    onFinished: (key) => events.push(key),
    setTimer: (fn) => {
      fn();
      return 0;
    },
    clearTimer: () => {},
  });
  const b = dirKey(B);
  const a = dirKey(A);
  const map = (bWorking, aWorking) =>
    new Map([
      [a, { working: aWorking, blocked: false }],
      [b, { working: bWorking, blocked: false }],
    ]);
  attention.note(map(true, true));
  attention.quietUntil(B);
  attention.note(map(false, false), { openDir: A });
  assert.deepEqual(events, [], 'a stopped chat, or the open chat, chimed');
});

test('the finish grace outlasts the report wake', () => {
  // Measured 24 Nov: the worker's run finished at 11:38:26, the runner's "wake sent"
  // for the Architect came at 11:38:31. The old four-second grace chimed in between.
  assert.ok(FINISH_GRACE_MS >= 10000, `the grace is ${FINISH_GRACE_MS}ms; it must clear the 5s wake`);
});

test('the waiting post says how many turns are ahead', async () => {
  const { waitPostHtml } = await import('../web/wait-post.js');
  const html = waitPostHtml({
    waiting: { server: 'PolyStrata', holder: 'gamma - your message', kind: 'send' },
    held: { server: 'PolyStrata', holder: 'VPA - coder-1 b1' },
    ahead: ['test - your message', 'beta - your message'],
    aheadCount: 2,
  });
  assert.match(html, /2 turns are ahead of this one/, 'the post promised a start three turns away');
  assert.match(html, /test - your message, then beta - your message/);
  assert.doesNotMatch(html, /starts when that turn ends/, 'only the next in line may say that');
});
