// The policy, without an engine. Three zones, three answers, and the shapes
// that used to be ambiguous: a relative write, a `..` escape, a shell redirect,
// a path hidden in an environment variable.
//
// Run: node tests\permissions.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { decide, grantKey, rulesFor, zoneOf, inside, isSecret, analyzeCommand, refusalNote, screenTaking } from '../src/permissions.js';
import { tmpdir } from './tmpdir.mjs';

const HOME = 'C:/Users/tester';
const PROJECT = 'F:/dev/Synapse.Projects/demo';
const HARNESS = 'F:/dev/Synapse';
const SCRATCH = 'F:/dev/Synapse.Projects/_scratch';
const CWD = 'F:\\dev\\Synapse.Projects\\demo';

const call = (action, resource, extra = {}) =>
  decide({
    action,
    resources: [resource],
    cwd: CWD,
    projectRoot: PROJECT,
    harnessRoot: HARNESS,
    home: HOME,
    // The shipped default: Synapse itself is a built-in prohibited entry, so a
    // write inside the harness is refused with scope 'prohibited'.
    protection: [{ path: HARNESS, label: 'Synapse', write: false, read: true }],
    ...extra,
  });

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

// Browser profiles hold cookies, and Edge's is still refused as a credential
// store. Brave moved to the prohibited list (src/protection.js): it is the
// operator's to delete from that list, and its entry refuses reads as well.
test('browser profiles are refused, and Brave through the prohibited list', () => {
  // Edge is the browser we do use; its profile is still not a model's to read.
  assert.equal(call('read', `${HOME}/AppData/Local/Microsoft/Edge/User Data/Default/Cookies`).effect, 'deny');
  const brave = `${HOME}/AppData/Local/BraveSoftware/Brave-Browser/User Data/Default/Cookies`;
  const guarded = [{ path: `${HOME}/AppData/Local/BraveSoftware`, write: false, read: false, label: 'Brave' }];
  assert.equal(call('read', brave, { protection: guarded }).effect, 'deny');
  assert.equal(call('read', brave, { protection: guarded }).scope, 'prohibited');
  assert.equal(call('edit', brave, { protection: guarded }).effect, 'deny');
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

// The scratch folder is the one place outside the project a model may write: it
// exists so a probe script never has to go into the machine's temp folder or the
// project's own git tree.
test('the scratch folder is writable without asking, and is not the harness', () => {
  const base = {
    cwd: CWD,
    projectRoot: PROJECT,
    harnessRoot: HARNESS,
    scratchRoot: SCRATCH,
    home: HOME,
    protection: [{ path: HARNESS, label: 'Synapse', write: false, read: true }],
  };
  const file = `${SCRATCH}/demo-1234/probe.ps1`;
  assert.equal(zoneOf(file, { projectRoot: PROJECT, harnessRoot: HARNESS, scratchRoot: SCRATCH }), 'scratch');
  const write = decide({ ...base, action: 'edit', resources: [file] });
  assert.equal(write.effect, 'allow');
  assert.equal(write.outside, false);
  assert.equal(write.scope, 'scratch');
  assert.match(write.reason, /scratch folder/);
  const shell = decide({ ...base, action: 'shell', resources: [`Set-Content "${file}" hi`] });
  assert.equal(shell.effect, 'allow');
  // The harness is still denied, though it is not far away.
  assert.equal(decide({ ...base, action: 'edit', resources: [`${HARNESS}/src/api.js`] }).effect, 'deny');
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
  // 4 Nov: a worker wrapped the same call in `timeout 30`, and the whole
  // command's head was not an interpreter, so a shipped tool read as a harness
  // write and was refused. The statement is what matters, not its first word.
  assert.equal(
    shell('timeout 30 node F:\\dev\\Synapse\\skills\\visual-review\\bin\\shot.mjs page.html').effect,
    'allow',
  );
  // Inline code is not a shipped tool: `-e` must not buy a write into skills/.
  assert.equal(
    shell('node -e "x" F:\\dev\\Synapse\\skills\\visual-review\\SKILL.md').effect,
    'deny',
  );
  // 5 Nov: PowerShell's call operator is how a worker runs a shipped `.ps1` that is
  // not on PATH — the only form the shell offers — and it has no interpreter word
  // for the rule above to find. It was refused as a harness write, so the operator's
  // own skills were unusable through their shell's syntax.
  assert.equal(
    shell('& "F:\\dev\\Synapse\\skills\\app-check\\bin\\window.ps1" -Action query -TargetPid 111000').effect,
    'allow',
  );
  // The exemption is per statement: the same command may not also delete a skill.
  assert.equal(
    shell('& "F:\\dev\\Synapse\\skills\\app-check\\bin\\window.ps1"; Remove-Item F:\\dev\\Synapse\\skills\\visual-review\\SKILL.md').effect,
    'deny',
  );
  // A script that is in the harness but not in skills/ is not a shipped tool.
  assert.equal(shell('& "F:\\dev\\Synapse\\src\\build.ps1"').effect, 'deny');
});

// A skill's assets are made to be copied into a project. `Copy-Item` is not a read
// verb, so the source under `skills/` counted as a write into the harness and the
// built-in PROHIBITED entry refused the scaffold: a coder had to read every file
// and write it again (8 Nov). The carve-out is a copy whose sources are all under
// `skills/` and whose destination is outside Synapse.
test('a skill may copy its assets into a project', () => {
  const scaffold = 'F:\\dev\\Synapse\\skills\\win-app\\template';
  const copy = shell(`Copy-Item "${scaffold}" ".\\bin" -Recurse`);
  assert.equal(copy.effect, 'allow');
  assert.equal(copy.outside, false);
  assert.equal(copy.scope, 'project');
  assert.match(copy.reason, /copies a shipped skill/);
  // The aliases, a wildcard and the flag forms are the same command.
  assert.equal(shell(`cp -Recurse "${scaffold}\\*" "bin\\app"`).effect, 'allow');
  assert.equal(shell(`Copy-Item -Path "${scaffold}" -Destination "bin\\app" -Recurse`).effect, 'allow');
  assert.equal(shell(`Copy-Item -LiteralPath "${scaffold}" -Destination ".\\app" -Recurse`).effect, 'allow');
  // A second statement is judged on its own: a copy beside a project write is fine.
  assert.equal(
    shell(`Copy-Item "${scaffold}" ".\\bin" -Recurse\nSet-Content .\\bin\\README.txt hi`).effect,
    'allow',
  );
});

test('the copy carve-out is a copy, not a way into the harness', () => {
  const scaffold = 'F:\\dev\\Synapse\\skills\\win-app\\template';
  // A move would delete the skill it names.
  assert.equal(shell(`Move-Item "${scaffold}" ".\\bin"`).effect, 'deny');
  // A copy into Synapse is still a change to Synapse.
  assert.equal(shell(`Copy-Item "${scaffold}" "F:\\dev\\Synapse\\skills\\other" -Recurse`).effect, 'deny');
  // A source elsewhere in the harness is not a skill.
  assert.equal(shell('Copy-Item "F:\\dev\\Synapse\\src\\permissions.js" ".\\bin"').effect, 'deny');
  // A `..` that climbs out of skills/ resolves out of it.
  assert.equal(shell('Copy-Item "F:\\dev\\Synapse\\skills\\..\\src\\permissions.js" ".\\bin"').effect, 'deny');
  // A copy is not an excuse for a statement that deletes the skill.
  assert.equal(
    shell(`Copy-Item "${scaffold}" ".\\bin" -Recurse\nRemove-Item "${scaffold}" -Recurse`).effect,
    'deny',
  );
  // The destination is still judged as the write it is: the Desktop asks, and a
  // protected folder is refused.
  const away = shell(`Copy-Item "${scaffold}" "C:\\Users\\tester\\Desktop\\app" -Recurse`);
  assert.equal(away.effect, 'ask');
  assert.equal(away.scope, 'outside');
  const windows = [
    { path: HARNESS, label: 'Synapse', write: false, read: true },
    { path: 'C:/Windows', label: 'Windows', write: false, read: true },
  ];
  assert.equal(
    shell(`Copy-Item "${scaffold}" "C:\\Windows\\System32\\evil" -Recurse`, { protection: windows }).effect,
    'deny',
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

test('reading the harness is allowed except where keys and state live', () => {
  // Documents, source and scaffolds are readable.
  assert.equal(call('read', `${HARNESS}/logs/app.log`).effect, 'allow');
  assert.equal(call('read', `${HARNESS}/docs/notes/engine-notes.md`).effect, 'allow');
  assert.equal(call('read', `${HARNESS}/AGENTS.md`).effect, 'allow');
  // The Windows shell is not here any more: it is the win-app skill's template, so a
  // scaffold asset reaches a project without the harness being read (7 Nov).
  assert.equal(call('read', `${HARNESS}/templates/win-app/README.md`).effect, 'deny');
  // Keys and state are not.
  assert.equal(call('read', `${HARNESS}/data/provider-keys.json`).effect, 'deny');
  assert.equal(call('read', `${HARNESS}/config/synapse.config.json`).effect, 'deny');
  assert.equal(call('read', `${HARNESS}/bin/node/node.exe`).effect, 'deny');
  assert.equal(call('read', `${HARNESS}/.git/HEAD`).effect, 'deny');
});

// The list is a denylist, and that is the point: it used to be an allowlist, so every
// folder Synapse gained was refused until someone remembered to add it. `templates/`
// was refused that way, two reads in one step were declined, and the engine ended the
// turn as interrupted — the operator saw a run stop for reading a file that is not a
// secret (7 Nov).
test('a folder added to the harness later is readable without being listed', () => {
  assert.equal(call('read', `${HARNESS}/some-folder-added-later/notes.md`).effect, 'allow');
  assert.equal(call('read', `${HARNESS}/another one/file.txt`).effect, 'allow');
});

test('the folders that hold keys and state stay refused, and they are the ones on disk', () => {
  for (const rel of ['data/provider-keys.json', 'config/synapse.config.json']) {
    if (!fs.existsSync(path.join(process.cwd(), rel))) continue;
    assert.equal(call('read', `${HARNESS}/${rel.replace(/\//g, '\\')}`).effect, 'deny', `${rel} must stay refused`);
  }
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
  // The write tool is a separate action, and it is the one that was missing until
  // the smoke test found a file on the Desktop nobody was asked about (7 Nov).
  assert.ok(has('write', 'ask'));
  assert.ok(has('shell', 'ask'));
  assert.ok(has('execute', 'ask'));
  assert.ok(has('read', 'ask'));
  assert.ok(has('read', 'deny', '.ssh'));
});

test('a write outside the project asks, and a write inside it does not', () => {
  assert.equal(call('write', 'C:/Users/tester/Desktop/x.txt').effect, 'ask');
  assert.equal(call('write', `${PROJECT}/notes.md`).effect, 'allow');
  // The harness is refused outright, not asked about: it is the app itself.
  assert.equal(call('write', `${HARNESS}/web/app.js`).effect, 'deny');
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

test('an app-data write gets the portable hint', () => {
  const answer = decide({
    action: 'edit',
    resources: [`${HOME}/AppData/Roaming/FeverTracker/data.json`],
    cwd: CWD,
    projectRoot: PROJECT,
    harnessRoot: HARNESS,
    home: HOME,
  });
  assert.equal(answer.effect, 'ask');
  assert.match(answer.reason, /data folder beside the executable/);
  const other = decide({
    action: 'edit',
    resources: ['D:/x.txt'],
    cwd: CWD,
    projectRoot: PROJECT,
    harnessRoot: HARNESS,
    home: HOME,
  });
  assert.equal(other.effect, 'ask');
  assert.doesNotMatch(other.reason, /data folder beside the executable/);
});

test('reading AppData while writing in the project does not ask', () => {
  // The QC migration read the old AppData file and wrote its report in scratch;
  // the whole command was judged an outside write because it contained both.
  const command = `Get-Content "${HOME}/AppData/Roaming/FeverTracker/data.json"\nSet-Content "${PROJECT}/after.txt" hi`;
  assert.equal(shell(command).effect, 'allow');
});

test('an outside read beside a scratch delete does not ask', () => {
  const command =
    `Get-ChildItem "D:\\temp\\fever tracker" -File\n` +
    `Remove-Item "${SCRATCH}/fever-tracker-3f38e7d2/q2.png" -Force`;
  const answer = decide({
    action: 'shell',
    resources: [command],
    cwd: CWD,
    projectRoot: PROJECT,
    harnessRoot: HARNESS,
    scratchRoot: SCRATCH,
    home: HOME,
  });
  assert.equal(answer.effect, 'allow');
});

test('an outside write next to an AppData read still asks, with the right reason', () => {
  const command =
    `Get-Content "${HOME}/AppData/Roaming/FeverTracker/data.json"\n` +
    `Remove-Item "D:\\temp\\fever tracker\\data\\webview2" -Recurse -Force`;
  const answer = decide({
    action: 'shell',
    resources: [command],
    cwd: CWD,
    projectRoot: PROJECT,
    harnessRoot: HARNESS,
    scratchRoot: SCRATCH,
    home: HOME,
  });
  assert.equal(answer.effect, 'ask');
  assert.doesNotMatch(answer.reason, /data folder beside the executable/);
});

test('a shell command is split without breaking a quoted separator', () => {
  const info = analyzeCommand('Get-Content "F:\\dev\\Synapse\\logs\\a;b.log"', CWD, { home: HOME });
  assert.deepEqual(info.paths, ['F:/dev/Synapse/logs/a;b.log']);
});

test('a PowerShell pattern is not a path', () => {
  // The regex in -notmatch resolved to the drive root and made this read-only
  // verification ask; the flag now skips its pattern argument.
  const command = `Get-ChildItem bin\\publish\\FeverTracker.exe,bin\\FeverTracker.exe
Select-Object FullName,LastWriteTime
echo ---
Get-ChildItem bin -Recurse -File -Include *.cs,*.xaml,*.csproj,*.html,*.css,*.js,*.ico
Where-Object { $_.FullName -notmatch '\\\\(obj|publish|tests)\\\\' }
Sort-Object LastWriteTime -Descending
Select-Object -First 1
node --test bin/tests/*.test.mjs 2>&1
Select-String "tests |pass |fail "`;
  const info = analyzeCommand(command, CWD, { home: HOME });
  assert.equal(info.paths.some((p) => p.startsWith('/(obj')), false);
  assert.equal(shell(command).effect, 'allow');
  // A pattern's replacement is skipped too, and a real outside write still asks.
  assert.equal(shell("Get-Content x.log -replace '\\\\', '/'").effect, 'allow');
  assert.equal(shell('Set-Content D:\\x.txt hi').effect, 'ask');
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
  assert.equal(call('edit', `${HARNESS}/x`).scope, 'prohibited');
  assert.equal(call('edit', 'C:/Users/tester/.ssh/known_hosts').scope, 'secret');
  assert.equal(call('read', '.env').scope, 'project');
  assert.equal(call('read', 'C:/Windows/hosts').scope, 'outside');
});

// ── the screen ──────────────────────────────────────────────────
// A window brought to the front takes the operator's mouse, keyboard and focus.
// That is not a file: it is their machine, and the policy asks instead of deciding.
test('a command that takes the screen is recognised', () => {
  assert.equal(screenTaking('& "F:\\dev\\Synapse\\skills\\app-check\\bin\\window.ps1" -Action shot -TargetPid 1 -Out t.png'), true);
  assert.equal(screenTaking('& "F:\\dev\\Synapse\\skills\\app-check\\bin\\window.ps1" -Action launch -Exe calc.exe'), true);
  // Reading a window's size and title is not taking it.
  assert.equal(screenTaking('& "F:\\dev\\Synapse\\skills\\app-check\\bin\\window.ps1" -Action query -TargetPid 1'), false);
  // The skill's other entry point is the launcher, and it starts an app, brings its
  // window forward and photographs it: that is the screen too. Only `window.ps1`
  // was recognised, so a worker could take it without a card by using this file
  // (7 Nov — the operator's first test prompt produced no request at all).
  assert.equal(screenTaking('node "F:\\dev\\Synapse\\skills\\app-check\\bin\\app-check.mjs" --exe "C:\\Windows\\System32\\notepad.exe" --out ".synapse/shots"'), true);
  assert.equal(screenTaking('node "F:\\dev\\Synapse\\skills\\app-check\\bin\\app-check.mjs" --pid 1234 --out shots'), true);
  // Asking the tool what its options are is not taking anything.
  assert.equal(screenTaking('node "F:\\dev\\Synapse\\skills\\app-check\\bin\\app-check.mjs" --help'), false);
  assert.equal(screenTaking('Add-Type -MemberDefinition "SetForegroundWindow" -Name W'), true);
  assert.equal(screenTaking('[System.Windows.Forms.SendKeys]::SendWait("x")'), true);
  // Ordinary work is not the screen.
  assert.equal(screenTaking('Get-Content notes.md'), false);
  assert.equal(screenTaking('node F:\\dev\\Synapse\\skills\\visual-review\\bin\\shot.mjs page.html'), false);
});

test('the screen asks until the operator has given it for this run', () => {
  const shot = '& "F:\\dev\\Synapse\\skills\\app-check\\bin\\window.ps1" -Action shot -TargetPid 1 -Out t.png';
  const asked = shell(shot);
  assert.equal(asked.effect, 'ask');
  assert.equal(asked.scope, 'desk');
  assert.match(asked.reason, /take your screen/);
  // The lease is the answer: with it, the same command is the toolbox working.
  const allowed = shell(shot, { deskHeld: true });
  assert.equal(allowed.effect, 'allow');
});

test('a refusal about the screen says what it means', () => {
  const said = refusalNote({ role: 'coder-1', scope: 'desk' });
  assert.match(said, /did not give you their screen/);
  assert.match(said, /Do not try another command/);
});
// A shipped tool launches Windows programs — `-Exe C:\Windows\System32\cmd.exe` —
// and naming a program is execution, not a change. Judging it as a write refused
// the operator's own skill with "PROHIBITED: Windows is on the protected list"
// (6 Nov), which is the same false positive as the `&` form two days before.
test('a program a shipped tool runs is not a write into Windows', () => {
  const windows = [
    { path: HARNESS, label: 'Synapse', write: false, read: true },
    { path: 'C:/Windows', label: 'Windows', write: false, read: true },
  ];
  const launch =
    '& "F:\\dev\\Synapse\\skills\\app-check\\bin\\window.ps1" -Action launch -Exe C:\\Windows\\System32\\cmd.exe -WaitMs 8000';
  // Without a lease it is the screen question, not PROHIBITED.
  const asked = shell(launch, { protection: windows });
  assert.equal(asked.effect, 'ask');
  assert.equal(asked.scope, 'desk');
  // With the lease it is the toolbox working.
  assert.equal(shell(launch, { protection: windows, deskHeld: true }).effect, 'allow');
  // Writing into Windows is still refused, whoever does it.
  assert.equal(
    shell('& "F:\\dev\\Synapse\\skills\\app-check\\bin\\window.ps1" -Action shot -Out C:\\Windows\\evil.png', { protection: windows }).effect,
    'deny',
  );
  // And so is deleting a Windows binary.
  assert.equal(shell('Remove-Item C:\\Windows\\System32\\cmd.exe', { protection: windows }).effect, 'deny');
  // A cmd-style switch is a switch, not a path: `/c` used to resolve to `F:/c`.
  assert.equal(shell('& "C:\\Windows\\System32\\cmd.exe" /c dir', { protection: windows }).effect, 'allow');
});

// …and the same is true when a *launcher* names the program: `Start-Process
// …\powershell.exe` puts the path in an argument, where the head-program rule could
// not see it. A worker reading a temperature sensor was refused as "PROHIBITED:
// Windows is on the protected list" (11 Nov) — nothing was going to be written.
test('a program a launcher names is a run, and elevation is refused as itself', () => {
  const windows = [
    { path: HARNESS, label: 'Synapse', write: false, read: true },
    { path: 'C:/Windows', label: 'Windows', write: false, read: true },
  ];
  const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  assert.equal(
    shell(`Start-Process ${ps} -NoProfile -File .\\x.ps1`, { protection: windows }).effect,
    'allow',
  );
  // Asking Windows for administrator rights is a different thing, and says so: an
  // unattended run cannot answer the UAC prompt.
  const elevated = shell(`Start-Process ${ps} -Verb RunAs -ArgumentList '-NoProfile','Bypass'`, { protection: windows });
  assert.equal(elevated.effect, 'deny');
  assert.equal(elevated.scope, 'elevation', 'elevation must not be called a prohibited write');
  assert.match(elevated.reason, /administrator rights/);
  assert.doesNotMatch(elevated.reason, /PROHIBITED/);
  // What the analyser can still see: a write named outside the argument list.
  assert.equal(
    shell(`Start-Process ${ps} -Out C:\\Windows\\evil.txt`, { protection: windows }).effect,
    'deny',
  );
});
// The screen rules read the command line, so on 8 Nov the coder and the designer
// wrote the mouse movement into a script and ran the script: the command named
// nothing, and the cursor moved anyway. The script is read now, but only when it is
// about to be executed.
test('a script the command runs is read, because the mouse lives inside it', () => {
  const dir = tmpdir('synapse-perm-');
  try {
    const project = dir.replace(/\\/g, '/');
    const base = { cwd: dir, projectRoot: project, harnessRoot: HARNESS, home: HOME };
    fs.writeFileSync(
      path.join(dir, 'capture.ps1'),
      'Add-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(4,4)\n',
    );
    const asked = decide({ ...base, action: 'shell', resources: ['pwsh -NoProfile -File capture.ps1'] });
    assert.equal(asked.effect, 'ask');
    assert.equal(asked.scope, 'desk');

    // Reading a script is not running it, even when the script takes the screen.
    assert.equal(decide({ ...base, action: 'shell', resources: ['Get-Content capture.ps1'] }).effect, 'allow');

    // A script with nothing to hide is allowed.
    fs.writeFileSync(path.join(dir, 'quiet.ps1'), 'Get-ChildItem .\n');
    assert.equal(decide({ ...base, action: 'shell', resources: ['pwsh -File quiet.ps1'] }).effect, 'allow');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the managed cursor call is the mouse too', () => {
  const asked = shell('Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(10,10)');
  assert.equal(asked.effect, 'ask');
  assert.equal(asked.scope, 'desk');
});

test('running the project\'s own program asks for the screen', () => {
  const exe = `${PROJECT}/bin/app/App.exe`;
  for (const command of [`& "${exe}"`, `Start-Process "${exe}"`, `cmd /c "${exe}"`]) {
    const asked = shell(command);
    assert.equal(asked.effect, 'ask', command);
    assert.equal(asked.scope, 'desk', command);
  }
  // Looking at the program is not running it.
  assert.equal(shell(`Get-Item "${exe}"`).effect, 'allow');
});

// ── processes ───────────────────────────────────────────────────
// A shell command that stops processes it did not start is refused, not questioned: an
// unattended run must not wait for an answer, and the model can act on a refusal. The
// day that earned it (10 Nov): a worker tidied up with
// `Get-Process python | ForEach-Object { Stop-Process -Id $_.Id -Force }` and stopped the
// local model server answering its own run. Measured against a day of logs, 121 of the
// 122 kill commands were the project's own app by name, and those stay allowed.
test('one process it started, by its id: allowed', () => {
  for (const command of [
    'Stop-Process -Id 26232 -Force',
    'Stop-Process -Name SysMonitor -Force -ErrorAction SilentlyContinue',
    'Get-Process SysMonitor | Select-Object Id,Path | Stop-Process -Name SysMonitor',
    'Stop-Process -Name SysMonitor; Start-Sleep -Milliseconds 500; .\\build.ps1',
    // A pid it recorded and read back is the pattern the brief asks for, not a sweep.
    'Stop-Process -Id $serverPid -Force',
    // …and the same id inside a loop over two pid files, with a *read* of the process
    // list in the same command. Refused on 10 Nov: the "something listed processes"
    // test only excused a literal number, so a worker's own cleanup was denied and the
    // model had to find another way to stop the app it had started.
    'foreach($f in "app.pid","app3.pid"){ $p=[int](Get-Content $f); if($p){ Stop-Process -Id $p -Force } }; ' +
      'Get-Process | Where-Object { $_.ProcessName -eq "Demo App" } | Select-Object Id,Title',
  ]) {
    const decision = shell(command);
    assert.equal(decision.effect, 'allow', `${command} was ${decision.effect}: ${decision.reason}`);
  }
});

test('a sweep, a family, or an id it found: refused', () => {
  const cases = [
    'Get-Process python | ForEach-Object { Stop-Process -Id $_.Id -Force }',
    'Get-Process | Stop-Process -Force',
    'Get-NetTCPConnection -LocalPort 8080 | Stop-Process -Force',
    'Stop-Process -Id (Get-NetTCPConnection -LocalPort 8080).OwningProcess',
    'Stop-Process -Id $_.Id -Force',
    'Stop-Process -Name python -Force',
    'Stop-Process -Name python* -Force',
    'taskkill /IM python.exe /F',
    'pkill -f python',
  ];
  for (const command of cases) {
    const decision = shell(command);
    assert.equal(decision.effect, 'deny', `${command} was ${decision.effect}: ${decision.reason}`);
    assert.equal(decision.scope, 'processes', `${command} was denied for the wrong reason`);
    // The refusal has to say what to do instead, or the model retries the same command.
    assert.match(decision.reason, /by its id/, `${command}'s refusal does not name the fix`);
  }
  // A pipeline that only reads is untouched by any of this.
  assert.equal(shell('npm run build 2>&1 | Select-Object -Last 5').effect, 'allow');
});

// ── the shapes a hostile command uses ───────────────────────────
// Each of these was found by the strength tests (docs/strength-tests.md) trying to get a
// kill past the rule, and each is refused now.
test('a kill reached by another route is still a kill', () => {
  const dir = tmpdir('synapse-kill-');
  fs.writeFileSync(path.join(dir, 'sweep.ps1'), 'Get-Process python | ForEach-Object { Stop-Process -Id $_.Id -Force }');
  fs.writeFileSync(path.join(dir, 'safe.ps1'), 'Stop-Process -Name SysMonitor -Force');
  const from = (command) => call('shell', command, { cwd: dir, projectRoot: dir });
  const refused = [
    '(Get-Process python).Kill()',
    'Get-CimInstance Win32_Process -Filter "name=\'python.exe\'" | Invoke-CimMethod -MethodName Terminate',
    'wmic process where "name=\'python.exe\'" call terminate',
    'taskkill /F /FI "IMAGENAME eq python.exe"',
    'Stop-Process -Name p?thon -Force',
    'powershell -Command "Get-Process python | Stop-Process"',
    'cmd /c "taskkill /IM python.exe /F"',
    '.\\sweep.ps1',
  ];
  for (const command of refused) {
    const decision = from(command);
    assert.equal(decision.effect, 'deny', `${command} was ${decision.effect}: ${decision.reason}`);
    assert.equal(decision.scope, 'processes', `${command} was denied for the wrong reason`);
  }
  // And the two forms that must keep working: a specific id, and a project's own app —
  // including one stopped from inside a script.
  assert.equal(from('taskkill /PID 1234 /T /F').effect, 'allow', 'a by-id taskkill asks for a zone');
  assert.equal(from('.\\safe.ps1').effect, 'allow', 'a script that stops the project app was refused');
  fs.rmSync(dir, { recursive: true, force: true });
});
