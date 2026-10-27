// The policy, without an engine. Three zones, three answers, and the shapes
// that used to be ambiguous: a relative write, a `..` escape, a shell redirect,
// a path hidden in an environment variable.
//
// Run: node tests\permissions.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decide, grantKey, rulesFor, zoneOf, inside, isSecret, analyzeCommand, refusalNote } from '../src/permissions.js';

const HOME = 'C:/Users/tester';
const PROJECT = 'F:/dev/Synapse.Projects/demo';
const HARNESS = 'F:/dev/Synapse';
const CWD = 'F:\\dev\\Synapse.Projects\\demo';

const call = (action, resource, extra = {}) =>
  decide({ action, resources: [resource], cwd: CWD, projectRoot: PROJECT, harnessRoot: HARNESS, home: HOME, ...extra });

const shell = (command, extra = {}) => call('shell', command, extra);

// ── zones ───────────────────────────────────────────────────────
test('the three zones, and the boundary between them', () => {
  assert.equal(zoneOf(`${PROJECT}/src/app.js`, { projectRoot: PROJECT, harnessRoot: HARNESS }), 'project');
  assert.equal(zoneOf(`${HARNESS}/src/api.js`, { projectRoot: PROJECT, harnessRoot: HARNESS }), 'harness');
  assert.equal(zoneOf('C:/Windows/system32', { projectRoot: PROJECT, harnessRoot: HARNESS }), 'outside');
  // A sibling whose name starts with the project's name is not the project.
  assert.equal(inside(`${PROJECT}two/x`, PROJECT), false);
});

test('a credential store is recognised, and a similar name is not', () => {
  assert.equal(isSecret('C:/Users/tester/.ssh/id_rsa', { home: HOME }), true);
  assert.equal(isSecret('C:/Users/tester/.sshx/id_rsa', { home: HOME }), false);
});

// ── file writes ─────────────────────────────────────────────────
test('a write inside the workspace is allowed, relative or absolute', () => {
  assert.equal(call('edit', 'src/app.js').effect, 'allow');
  assert.equal(call('edit', `${PROJECT}/src/app.js`).effect, 'allow');
  assert.equal(call('edit', '.synapse/plan.json').effect, 'allow');
});

test('a write that climbs out of the workspace asks', () => {
  assert.equal(call('edit', '../other/file.txt').effect, 'ask');
  assert.equal(call('edit', '../../Windows/x.txt').effect, 'ask');
});

test('a write into the harness is denied, not asked', () => {
  assert.equal(call('edit', `${HARNESS}/src/api.js`).effect, 'deny');
  assert.equal(call('write', 'F:\\dev\\Synapse\\AGENTS.md').effect, 'deny');
});

test('a write anywhere else asks the operator', () => {
  assert.equal(call('edit', 'C:/Projects/other/main.js').effect, 'ask');
  assert.equal(call('edit', 'D:/scratch.txt').effect, 'ask');
});

test('a write into a credential store is denied', () => {
  assert.equal(call('edit', 'C:/Users/tester/.ssh/authorized_keys').effect, 'deny');
});

// ── shell ───────────────────────────────────────────────────────
test('a command that touches nothing is allowed', () => {
  assert.equal(shell('echo probe-shell-ok').effect, 'allow');
  assert.equal(shell('npm test').effect, 'allow');
});

test('a command that stays in the workspace is allowed', () => {
  assert.equal(shell('Get-Content .\\package.json').effect, 'allow');
  assert.equal(shell('node src\\index.js').effect, 'allow');
});

// "Always Allow" on a shell card is about the command and the files it names,
// not the exact argument string: the model re-runs the same script with a pipe
// or another flag, and every variant used to ask again.
test('an always-allow covers the same script with a different tail, not another file', () => {
  const base = { cwd: CWD, projectRoot: PROJECT, harnessRoot: HARNESS, home: HOME };
  const script = 'C:/Users/tester/AppData/Local/Temp/opencode/probe.ps1';
  const one = grantKey({ ...base, action: 'shell', resources: [`powershell -NoProfile -File "${script}"`] });
  const two = grantKey({
    ...base,
    action: 'shell',
    resources: [`powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" 2>&1 | Select-Object -First 30`],
  });
  assert.deepEqual(one, two);
  const other = grantKey({
    ...base,
    action: 'shell',
    resources: [`powershell -NoProfile -File "C:/Users/tester/AppData/Local/Temp/opencode/other.ps1"`],
  });
  assert.notDeepEqual(one, other, 'another file is another consent');
  const read = grantKey({ ...base, action: 'shell', resources: [`Get-Content "${script}"`] });
  assert.notDeepEqual(one, read, 'reading a file is not running it');
});

test('the same file under two names is one grant', () => {
  const base = { projectRoot: PROJECT, harnessRoot: HARNESS, home: HOME };
  const rel = grantKey({ ...base, action: 'edit', resources: ['bin/app.js'], cwd: CWD });
  const abs = grantKey({ ...base, action: 'edit', resources: [`${PROJECT}/bin/app.js`], cwd: CWD });
  assert.deepEqual(rel, abs);
});

// The sentence is what the log and the card say. A read of the project itself
// used to be logged as "outside the project" because the allow branch had one
// string for both sides of the boundary, which is exactly the kind of sentence
// that makes a later reader trust the wrong thing.
test('the reason says which side of the boundary a read is on', () => {
  const inside = shell('Get-Item bin/FeverTracker.exe');
  assert.equal(inside.effect, 'allow');
  assert.equal(inside.outside, false);
  assert.match(inside.reason, /in the project folder/);

  const beyond = shell('Get-Content F:\\dev\\Synapse\\logs\\app.log -Tail 5');
  assert.equal(beyond.effect, 'allow');
  assert.equal(beyond.outside, true);
  assert.match(beyond.reason, /outside the project/);
});

test('reading the harness is allowed; writing it is denied', () => {
  assert.equal(shell('Get-Content F:\\dev\\Synapse\\logs\\app.log -Tail 5').effect, 'allow');
  assert.equal(shell('Set-Content F:\\dev\\Synapse\\AGENTS.md hi').effect, 'deny');
  assert.equal(shell('Get-Content F:\\dev\\Synapse\\logs\\app.log > F:\\dev\\Synapse\\logs\\copy.log').effect, 'deny');
  // The same allow-list as a file read: keys and state are not documents.
  assert.equal(shell('Get-Content F:\\dev\\Synapse\\data\\provider-keys.json').effect, 'deny');
  // Running a shipped script is the toolbox; deleting one is not.
  assert.equal(shell('Remove-Item F:\\dev\\Synapse\\skills\\visual-review\\SKILL.md').effect, 'deny');
});

test('the shipped toolbox may run', () => {
  assert.equal(
    shell('node F:\\dev\\Synapse\\skills\\visual-review\\bin\\shot.mjs page.html').effect,
    'allow',
  );
});

test('changing directory out of the workspace turns a write into a question', () => {
  assert.equal(shell('cd D:\\projects; del x').effect, 'ask');
  // A read of another folder stays allowed even through a cd.
  assert.equal(shell('cd D:\\logs; Get-Content today.txt').effect, 'allow');
});

test('a redirect outside asks; a read of the same place does not', () => {
  assert.equal(shell('echo x > D:\\scratch\\out.txt').effect, 'ask');
  assert.equal(shell('Get-Content C:\\Users\\tester\\notes.txt').effect, 'allow');
});

test('a credential store is denied even through a command', () => {
  assert.equal(shell('Get-Content C:\\Users\\tester\\.ssh\\id_rsa').effect, 'deny');
});

test('a path the harness cannot resolve asks instead of guessing', () => {
  const name = 'SYNAPSE_TEST_NOT_SET';
  assert.equal(shell(`Set-Content $env:${name}\\out.txt x`).effect, 'ask');
});

test('listing the harness root is allowed; its state is not', () => {
  assert.equal(shell('Get-ChildItem F:\\dev\\Synapse').effect, 'allow');
  assert.equal(shell('Get-ChildItem F:\\dev\\Synapse\\data -Recurse').effect, 'deny');
});

test('a directory change written after a flag is still read', () => {
  assert.equal(shell('Set-Location -Path D:\\projects; del x').effect, 'ask');
});

test('a command that edits another repository asks', () => {
  assert.equal(shell('git -C F:\\other\\repo commit -am wip').effect, 'ask');
});

// ── reads ───────────────────────────────────────────────────────
test('reading outside is allowed, except a credential store', () => {
  assert.equal(call('read', 'C:/Windows/system32/drivers/etc/hosts').effect, 'allow');
  assert.equal(call('read', 'C:/Users/tester/.aws/credentials').effect, 'deny');
});

test('reading the harness is limited to the parts that help', () => {
  assert.equal(call('read', `${HARNESS}/logs/app.log`).effect, 'allow');
  assert.equal(call('read', `${HARNESS}/docs/notes/engine-notes.md`).effect, 'allow');
  assert.equal(call('read', `${HARNESS}/data/provider-keys.json`).effect, 'deny');
  assert.equal(call('read', `${HARNESS}/config/synapse.config.json`).effect, 'deny');
});

test('a relative climb into the harness is judged as the harness', () => {
  assert.equal(call('read', '..\\..\\Synapse\\data\\provider-keys.json').effect, 'deny');
  assert.equal(call('edit', '..\\..\\Synapse\\AGENTS.md').effect, 'deny');
});

test('a secrets file asks, and its example does not', () => {
  assert.equal(call('read', '.env').effect, 'ask');
  assert.equal(call('read', '.env.example').effect, 'allow');
});

// ── everything else, and the ruleset ────────────────────────────
test('execute asks; an ordinary capability is not restricted', () => {
  assert.equal(call('execute', 'return 6 * 7;').effect, 'ask');
  assert.equal(call('webfetch', 'https://example.com').effect, 'allow');
  assert.equal(call('question', '*').effect, 'allow');
});

test('the ruleset asks for writes, shells, code and reads, and denies credential stores', () => {
  const rules = rulesFor({ harnessRoot: HARNESS, home: HOME });
  const has = (action, effect, needle = '') =>
    rules.some((r) => r.action === action && r.effect === effect && String(r.resource).includes(needle));
  assert.ok(has('edit', 'ask'));
  assert.ok(has('shell', 'ask'));
  assert.ok(has('execute', 'ask'));
  assert.ok(has('read', 'ask'));
  assert.ok(has('read', 'deny', '.ssh'));
});

test('a newline separates two commands, so a read cannot excuse a write', () => {
  const outside = shell('Test-Path D:\\\nSet-Content -Path D:\\x.txt -Value hi');
  assert.equal(outside.effect, 'ask');

  const harness = shell(`Get-Content ${HARNESS}/logs/app.log\nSet-Content -Path ${HARNESS}/AGENTS.md -Value hi`);
  assert.equal(harness.effect, 'deny');

  const info = analyzeCommand('Test-Path D:\\\nSet-Content -Path D:\\x.txt -Value hi', CWD, { home: HOME });
  assert.equal(info.readsOnly, false);
});

test('a shell command split into resources keeps its line boundaries', () => {
  const answer = decide({
    action: 'shell',
    resources: ['Test-Path F:\\perm-test', 'Set-Content -Path F:\\perm-test\\newline.txt -Value x'],
    cwd: CWD,
    projectRoot: PROJECT,
    harnessRoot: HARNESS,
    home: HOME,
  });
  assert.equal(answer.effect, 'ask', 'the write on line two must not be excused by the read on line one');
});

test('a shell command is split without breaking a quoted separator', () => {
  const info = analyzeCommand('Get-Content "F:\\dev\\Synapse\\logs\\a;b.log"', CWD, { home: HOME });
  assert.deepEqual(info.paths, ['F:/dev/Synapse/logs/a;b.log']);
});

test('every decision carries a reason the operator can read', () => {
  for (const answer of [call('edit', 'src/a.js'), call('edit', 'D:/x'), call('edit', `${HARNESS}/x`)]) {
    assert.equal(typeof answer.reason, 'string');
    assert.ok(answer.reason.length > 3);
  }
});

test('a refusal tells the model why and where to escalate', () => {
  const harness = refusalNote({ role: 'coder-1', scope: 'harness' });
  assert.match(harness, /permanently/);
  assert.match(harness, /Do not try another/);

  const worker = refusalNote({ role: 'coder-1', scope: 'outside' });
  assert.match(worker, /declined/);
  assert.match(worker, /report/);

  const architect = refusalNote({ role: null, scope: 'outside' });
  assert.match(architect, /chat/);
});

test('the operator\'s own reason travels with the refusal', () => {
  // A rule about workarounds is useful; "that file is generated" is what stops
  // the worker guessing again.
  const note = refusalNote({ role: 'coder-1', scope: 'outside', reason: '  That file is\n generated.  ' });
  assert.match(note, /They said: "That file is generated\."/);
  assert.match(note, /Do not try another/);
  // No reason, no empty sentence.
  assert.doesNotMatch(refusalNote({ role: 'coder-1', scope: 'outside' }), /They said/);
  // Bounded, and flattened to one line: it is a sentence inside a message. The
  // reason is capped at 300 characters, so the note stays a paragraph.
  const long = refusalNote({ role: 'coder-1', scope: 'outside', reason: `x${'y'.repeat(500)}` });
  assert.ok(long.length < 620, `${long.length} characters`);
  assert.match(long, new RegExp(`y{299}`));
  assert.doesNotMatch(long, new RegExp(`y{300}`));
  assert.doesNotMatch(long, /\n/);
});

test('a decision says whether the call reached outside the project', () => {
  assert.equal(call('edit', 'src/a.js').outside, false);
  assert.equal(call('edit', 'D:/x.txt').outside, true);
  assert.equal(call('edit', `${HARNESS}/x`).outside, true);
  assert.equal(call('read', 'C:/Windows/hosts').outside, true);
  assert.equal(call('read', 'src/a.js').outside, false);
  assert.equal(shell('echo hi').outside, false);
  assert.equal(shell('Get-Content C:/logs/x.txt').outside, true);
});

test('a decision says where it lands, for the card to explain', () => {
  assert.equal(call('edit', 'src/a.js').scope, 'project');
  assert.equal(call('edit', 'D:/x.txt').scope, 'outside');
  assert.equal(call('edit', `${HARNESS}/x`).scope, 'harness');
  assert.equal(call('edit', 'C:/Users/tester/.ssh/known_hosts').scope, 'secret');
  assert.equal(call('read', '.env').scope, 'project');
  assert.equal(call('read', 'C:/Windows/hosts').scope, 'outside');
});
