// What a session may do, and who decides.
//
// Three zones. The project directory is the session's workspace: it may read,
// write and run there without asking anyone. The harness (`F:\dev\Synapse`) is
// ours: models may read the parts that help them (docs, logs, skills) and never
// write it — the harness decides, and the answer is no. Everything else on the
// machine belongs to the operator: a write or a command that reaches it asks.
//
// The engine is the enforcement point, but not the brain. Its ruleset can say
// `ask`, and when it does the engine blocks the tool and raises the request; this
// module answers it — allow, deny, or leave it for the operator. That is why the
// ruleset is only a handful of broad asks: the engine matches a path *as the
// model wrote it*, so a rule that allows `F:/dev/Synapse.Projects/x/**` says
// nothing about a relative `src/app.js`. Resolving the path here, against the
// session's real directory, is the only way to judge both forms the same.
//
// The cost is one local round trip per write, shell or read call. The benefit is
// one policy instead of a wall of globs that each need a relative twin.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { covers } from './protection.js';

const WRITE_ACTIONS = new Set(['edit', 'write', 'patch', 'create']);
const SHELL_ACTIONS = new Set(['shell', 'bash']);
const EXECUTE_ACTIONS = new Set(['execute']);
const READ_ACTIONS = new Set(['read']);

// Inside the harness, this is what a model may **not** read: the folders that hold
// keys and state rather than documents. `data/` has the provider keys and the engine's
// store, `config/` is the operator's own file, `bin/` and `vendor/` are binaries, and
// `.git/` is history nobody needs.
//
// It is a denylist on purpose. It used to be the other way round — a short list of
// readable folders — and that means every folder Synapse gains is refused by default
// until somebody remembers to add it. `templates/` was refused that way, two reads in
// one step were declined, and the engine ended the turn as interrupted: the operator
// saw a run "stop" for reading a file that is not a secret (7 Nov). Reads inside the
// harness are allowed unless they land in one of these.
//
// `templates/` stays here even though the Windows shell moved into the `win-app`
// skill: a scaffold is an asset for projects, and the skill is where it belongs. The
// harness is not a folder a model digs in (7 Nov).
const HARNESS_DENIED = ['data/', 'config/', 'bin/', '.git/', 'vendor/', 'node_modules/', 'templates/'];

// What the harness writes *for* the model, inside a folder that is otherwise closed.
// It is a read exception, never a write one: the harness makes these files, the model
// only looks at them.
const HARNESS_READABLE = ['data/browser/shots/'];

// Credential stores. Reading these is never part of building a project, and the
// operator allowed reads outside the workspace — this is the exception that
// makes that safe to say.
const SECRET_PARTS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.config/gcloud',
  '.config/gh',
  // Browser profiles hold cookies and saved passwords. Brave is handled by the
  // prohibited list instead (src/protection.js): it is not only unreadable, it is a
  // folder the operator can delete from that list deliberately, and the list is the
  // one place a path is called off limits.
  'AppData/Local/Google/Chrome/User Data',
  'AppData/Local/Microsoft/Edge/User Data',
  'AppData/Roaming/Mozilla/Firefox/Profiles',
];

// The verbs that cannot change anything. `git` is deliberately absent: `git
// status` is a read and `git checkout` is not, and one list cannot tell them
// apart, so git is judged as a command that might write.
const READ_VERBS = new RegExp(
  '^(?:get|test|resolve|select|where|measure|sort|format|out-string|' +
    'findstr|type|cat|ls|dir|head|tail|more|echo|' +
    'cd|chdir|set-location|push-location|pop-location|sl|pwd)\\b',
  'i',
);

const CD_VERBS = new Set(['cd', 'chdir', 'set-location', 'push-location', 'pushd', 'sl']);
const REDIRECT = /(?:^|[^0-9&>])>>?\s*("[^"]*"|'[^']*'|[^\s;&|]+)/g;

// Running a shipped script is the toolbox working. Deleting or editing one is
// not, so the toolbox allowance needs an interpreter at the front of the
// command, not just a path under `skills/`.
const INTERPRETERS = new Set(['node', 'nodejs', 'python', 'python3', 'py', 'pwsh', 'powershell', 'deno', 'bun', 'cmd', 'sh', 'bash']);

// Copying is the one verb that reads shipped assets and writes only where it is
// told. `Copy-Item` and its aliases (`cp`, `copy`, `cpi`) are what a coder uses to
// take the Windows-app scaffold out of a skill; `Move-Item` is deliberately absent,
// because a move deletes the skill it names.
const COPY_VERBS = new Set(['copy-item', 'cp', 'copy', 'cpi']);
// Flags that take the next word as their value. Without this, `-Destination X`
// would read `-destination` as a source and X as a second source.
const COPY_VALUE_FLAGS = new Set([
  'path', 'literalpath', 'destination', 'filter', 'include', 'exclude',
  'credential', 'fromsession', 'tosession', 'container',
]);

// Arguments that are patterns, not paths. `Where-Object { $_.FullName -notmatch
// '\\(obj|publish|tests)\\' }` resolved that regex to the drive root and made a
// completely read-only verification ask the operator (28 Oct). The flag names
// the pattern; the word after it is not a file.
const PATTERN_ARG =
  /^-(?:i|c)?(?:not)?match$|^-(?:i|c)?(?:not)?like$|^-(?:i|c)?replace$|^-(?:i|c)?split$|^-(?:i|c)?join$|^-pattern$/i;

/** A secrets file the model should ask about: .env, but not .env.example. */
const isEnvFile = (p) => /(^|\/)\.env(\.[^/]+)?$/i.test(String(p || '')) && !/\.env\.example$/i.test(String(p || ''));

/** Forward slashes, no trailing slash. The form the engine's rules use. */
const slash = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
const key = (value) => slash(value).toLowerCase();

/** Is `child` the same as, or under, `parent`? Case-insensitive on Windows. */
export function inside(child, parent) {
  const c = key(child);
  const p = key(parent);
  if (!c || !p) return false;
  return c === p || c.startsWith(`${p}/`);
}

/** The user-profile stores an app's data must not use: AppData and ProgramData. */
const isUserDataPath = (value) => /(?:^|\/)(?:appdata|programdata)(?:\/|$)/i.test(slash(value));

/** Which of the three zones a resolved path belongs to. */
export function zoneOf(target, { projectRoot, harnessRoot, scratchRoot }) {
  if (inside(target, projectRoot)) return 'project';
  if (scratchRoot && inside(target, scratchRoot)) return 'scratch';
  if (inside(target, harnessRoot)) return 'harness';
  return 'outside';
}

/** Is this path inside a credential store? Checked before any zone. */
export function isSecret(target, { home = os.homedir() } = {}) {
  const t = key(target);
  if (!t) return false;
  return SECRET_PARTS.some((part) => {
    const p = key(part);
    return t.includes(`/${p}/`) || t.endsWith(`/${p}`) || t.includes(`/${p}/**`);
  });
}

/**
 * Expand the path shapes a model writes, and say when one cannot be expanded.
 * An unexpanded variable is not guessed at: the caller turns it into an ask,
 * because a path we cannot name is a path we cannot judge.
 */
function expand(text, home) {
  let out = String(text || '');
  let unknown = false;
  const env = (name) => {
    const value = process.env[name];
    if (value === undefined || value === '') { unknown = true; return ''; }
    return value;
  };
  out = out.replace(/%([^%]+)%/g, (_, name) => env(name));
  out = out.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, name) => env(name));
  if (/^~(?=$|[\\/])/.test(out)) out = `${home}${out.slice(1)}`;
  return { text: out, unknown };
}

/** Does this token name a filesystem path at all? URLs and flags are not paths. */
function looksLikePath(token) {
  const t = String(token || '').replace(/^["']|["']$/g, '');
  if (!t) return false;
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (/^\\\\/.test(t)) return true;
  if (t === '.' || t === '..') return true;
  if (/^~(?=$|[\\/])/.test(t)) return true;
  if (/^\.{1,2}[\\/]/.test(t)) return true;
  if (t.includes('\\')) return true;
  if (t.includes('/') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return true;
  if (/^(?:%[^%]+%|\$env:[A-Za-z_][A-Za-z0-9_]*)[\\/]/i.test(t)) return true;
  return false;
}

/** Resolve one path-shaped token against the directory the command is in. */
export function resolvePath(value, cwd, { home = os.homedir() } = {}) {
  const raw = String(value || '').replace(/^["']|["']$/g, '').trim();
  if (!raw) return null;
  const { text, unknown } = expand(raw, home);
  if (unknown) return { unknown: true, raw };
  if (!text) return null;
  if (/^[A-Za-z]:[\\/]/.test(text) || /^\\\\/.test(text)) {
    return { path: slash(path.win32.normalize(text)), raw };
  }
  return { path: slash(path.resolve(cwd || process.cwd(), text)), raw };
}

/** Split a command into its pieces without breaking a quoted `;`.
 *
 *  A newline is a separator in PowerShell and in cmd, and models write multi-line
 *  shell scripts constantly. Without it, `Test-Path D:\` followed by a newline and
 *  `Set-Content …` was one "read" segment: the first verb excused the second
 *  statement, and an outside write was allowed without asking. Measured live.
 */
function segmentsOf(command) {
  const text = String(command || '');
  const out = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === '\n' || char === '\r') { out.push(current); current = ''; continue; }
    const two = text.slice(i, i + 2);
    if (two === '||' || two === '&&') { out.push(current); current = ''; i += 1; continue; }
    if (char === ';' || char === '|') { out.push(current); current = ''; continue; }
    current += char;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Split one piece into words, keeping a quoted path with spaces whole. */
function wordsOf(segment) {
  const text = String(segment || '');
  const out = [];
  let current = '';
  let quote = '';
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) { if (current) { out.push(current); current = ''; } continue; }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

/**
 * What a shell command names, resolved. `readsOnly` is the difference between a
 * command that looks at another folder and one that changes it.
 */
export function analyzeCommand(command, cwd, { home = os.homedir() } = {}) {
  const result = { paths: [], redirects: [], unknown: false, readsOnly: true, segments: [] };
  let dir = cwd;
  for (const segment of segmentsOf(command)) {
    const words = wordsOf(segment);
    if (!words.length) continue;
    const head = words[0].toLowerCase();
    // Each statement keeps its own read/write answer. A QC command that reads
    // AppData and writes its report in scratch is two statements, not one
    // outside write; judging the whole command by `readsOnly` asked for a card
    // in the last run (28 Oct).
    const part = { paths: [], redirects: [], readsOnly: true, verbRead: true, dir, words };
    const finish = () => {
      part.dir = dir;
      result.segments.push(part);
      result.paths.push(...part.paths);
      result.redirects.push(...part.redirects);
      if (!part.readsOnly) result.readsOnly = false;
    };

    // A directory change decides where the rest of the command runs, so it is
    // resolved first and carried forward. `Set-Location -Path X` writes the
    // target after a flag, so a flag is skipped rather than resolved as a path.
    if (CD_VERBS.has(head) && words[1]) {
      let targetWord = words[1];
      if (/^-\w/.test(targetWord) || /^\/[a-z]$/i.test(targetWord)) targetWord = words[2];
      if (!targetWord) continue;
      const target = resolvePath(targetWord, dir, { home });
      if (!target) { finish(); continue; }
      if (target.unknown) { result.unknown = true; finish(); continue; }
      part.paths.push(target.path);
      dir = target.path;
      finish();
      continue;
    }

    if (!READ_VERBS.test(words[0])) {
      part.readsOnly = false;
      part.verbRead = false;
    }

    let skip = 0;
    for (let w = 1; w < words.length; w += 1) {
      const word = words[w];
      if (skip > 0) { skip -= 1; continue; }
      if (PATTERN_ARG.test(word)) {
        // `-replace` takes a pattern and a replacement; the others one argument.
        skip = /replace$/i.test(word) ? 2 : 1;
        continue;
      }
      // A cmd-style switch (/c, -k) is a letter after a slash, not a path: it
      // resolved to F:/c and made cmd /c dir look like an outside write. The same is
      // true of a Windows tool's own multi-letter switch: `taskkill /PID 1234` was
      // resolved to F:/PID and asked for a zone, which a by-id stop must not do
      // (10 Nov, found by the strength tests).
      if (/^[-/][A-Za-z]$/.test(word)) continue;
      if (/^\/[A-Za-z]{2,}$/.test(word) && SLASH_SWITCH_TOOLS.has(head)) continue;
      const candidate = word.includes('=') ? word.slice(word.indexOf('=') + 1) : word;
      if (!looksLikePath(candidate)) continue;
      const target = resolvePath(candidate, dir, { home });
      if (!target) continue;
      if (target.unknown) { result.unknown = true; continue; }
      part.paths.push(target.path);
    }

    for (const match of segment.matchAll(REDIRECT)) {
      const target = resolvePath(match[1], dir, { home });
      if (!target) continue;
      if (target.unknown) { result.unknown = true; continue; }
      part.redirects.push(target.path);
      part.readsOnly = false;
    }
    finish();
  }
  return result;
}

// `scope` is where the request lands, in words the card can use: 'project',
// 'outside', 'harness', 'secret' or 'unknown'. The reason is a short sentence for
// the log and the tooltip; the card builds the lead from the scope and the action.
const allow = (reason, outside = false, scope = 'project') => ({ effect: 'allow', reason, outside: Boolean(outside), scope });
const ask = (reason, outside = false, scope = 'project') => ({ effect: 'ask', reason, outside: Boolean(outside), scope });
const deny = (reason, outside = false, scope = 'project') => ({ effect: 'deny', reason, outside: Boolean(outside), scope });

/**
 * The protected entry that decides this path, if any.
 *
 * The **most specific** covering entry wins, not the first one found: a rule about a
 * folder can be narrowed by a rule about one of its subfolders, which is how an operator
 * says "this folder is protected, except this part of it" (11 Nov). Specificity is the
 * length of the path, so `…\Synapse\data\browser\shots` beats `…\Synapse\data` and
 * `…\Synapse`; an entry with the same path as another cannot be created twice.
 *
 * `ctx.protection` is the list Settings > Prohibited keeps — `{ path, write, read }`
 * entries, built-in and added. It is read per request, so ticking a box applies to the
 * next tool call without a restart.
 */
function decidingEntry(target, ctx) {
  let best = null;
  for (const entry of ctx.protection || []) {
    if (!covers(entry.path, target)) continue;
    if (!best || key(entry.path).length > key(best.path).length) best = entry;
  }
  return best;
}

function prohibitedWrite(target, ctx) {
  const entry = decidingEntry(target, ctx);
  return entry && entry.write === false ? entry : null;
}

function prohibitedRead(target, ctx) {
  const entry = decidingEntry(target, ctx);
  return entry && entry.read === false ? entry : null;
}

/**
 * What the model is told when a request is refused.
 *
 * A bare "declined" invites the next attempt: in the 26 Oct test the worker tried
 * three routes to the same file. The message says the refusal is about this
 * request, forbids the obvious workaround, and names the one place to escalate.
 * A worker cannot reach the Architect mid-run, so its escalation is its report;
 * the Architect's is the operator in the chat.
 *
 * `reason` is the operator's own sentence, when they typed one. It comes first in
 * their words — a rule about workarounds is useful, but "that file is generated"
 * is what stops the worker guessing again.
 */
export function refusalNote({ role, scope, reason } = {}) {
  const worker = Boolean(role) && role !== 'architect';
  const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const said = why ? ` They said: "${why}".` : '';
  if (scope === 'prohibited') {
    return (
      'PROHIBITED: this path is on the operator\'s protected list and cannot be changed by any tool, even ' +
      'with permission. Do not try another tool, another path or a shell command to reach the same place. ' +
      'Stop and say in your report what you were trying to change and why.'
    ) + said;
  }
  if (scope === 'desk') {
    return (
      'The operator did not give you their screen. That is their machine, their mouse and their keyboard, and ' +
      'they are using it. Do not try another command, another window or another tool to reach it. Work without ' +
      'the screen, or say in your report what you needed it for and why.'
    ) + said;
  }
  if (scope === 'harness' || scope === 'secret') {
    return (
      'The harness refused this permanently: Synapse\'s own files and saved-password folders are never ' +
      'writable. Do not try another tool or another path to reach the same place. If the task depends on ' +
      'it, stop and explain why in your report.'
    ) + said;
  }
  return worker
    ? 'The operator declined this exact request.' + said + ' Do not try another path or tool to reach the same place. ' +
        'If you are certain it is needed, stop and say why in your report; the Architect decides what happens next.'
    : 'The operator declined this exact request.' + said + ' Do not try another path or tool to reach the same place. ' +
        'If you are certain it is needed, ask them why in this chat before trying again.';
}

// Single mode is one session and no delegation. The UI sends this rule itself on
// a mode switch (web/app.js, SINGLE_PERMISSIONS); the twin here is what a boot
// uses to bring a session created before the policy came in under it. Keep the
// two identical.
export const SINGLE_RULES = [{ action: 'subagent', resource: '*', effect: 'deny' }];

const first = (value) => (Array.isArray(value) ? value[0] : value);

function decideWrite(resources, ctx) {
  const list = (Array.isArray(resources) ? resources : [resources]).filter(Boolean);
  if (!list.length) return ask('The harness cannot tell what this would write.', true, 'unknown');
  const zones = [];
  const paths = [];
  for (const value of list) {
    const target = resolvePath(first(value), ctx.cwd, { home: ctx.home });
    if (!target || target.unknown) return ask('The harness cannot tell which folder this is.', true, 'unknown');
    // PROHIBITED beats every other rule: no card, no remembered grant, no answer.
    const guarded = prohibitedWrite(target.path, ctx);
    if (guarded) return deny(`PROHIBITED: ${guarded.label} is on the protected list.`, true, 'prohibited');
    if (isSecret(target.path, ctx)) return deny('The harness never opens saved-password folders.', true, 'secret');
    paths.push(target.path);
    zones.push(zoneOf(target.path, ctx));
  }
  if (zones.includes('harness')) {
    // The Synapse folder is a built-in protection, so reaching this line means the
    // operator switched that entry off on purpose. A change to Synapse itself is
    // then their decision to make, exactly like any other folder outside the project.
    return ask('Synapse is the app itself. Changing it is a deliberate choice.', true, 'harness');
  }
  if (zones.includes('outside')) {
    return ask(
      paths.some(isUserDataPath)
        ? 'App data belongs in a data folder beside the executable, not the user profile. This is outside the project.'
        : 'Only the project may be changed without asking. This is not in it.',
      true,
      'outside',
    );
  }
  if (zones.length && zones.every((z) => z === 'scratch')) {
    return allow('This is the scratch folder the harness gave you.', false, 'scratch');
  }
  return allow('This is in the project folder.', false, 'project');
}

// The things that take the operator's screen: the mouse, the keyboard and the
// focus of whatever they were doing. A window brought to the front is the usual
// one (app-check does it only when PrintWindow is refused), and input injection is
// the other.
const SCREEN_APIS = /\b(?:setforegroundwindow|sendinput|sendkeys|mouse_event|setcursorpos|keybd_event|appactivate)\b/i;
// Both of the skill's entry points, not just the PowerShell one. `app-check.mjs` is
// the launcher the skill's own instructions suggest first: it starts an app, brings
// its window forward and photographs it, and only `window.ps1` was recognised — so a
// worker could take the screen without a card by using the other file (7 Nov).
const WINDOW_TOOL = /app-check[\\/]+bin[\\/]+(?:window\.ps1|app-check\.mjs)/i;
// Asking what a window is called is not taking it, and neither is asking the tool
// what its options are.
const SCREEN_QUERY = /(?:-\s*action\s+"?query"?|--help\b|\s-h\b)/i;
// The managed way to the same API: `[System.Windows.Forms.Cursor]::Position`.
// Only the type's own member, never the word "cursor" — a CSS file full of
// `cursor: pointer` must not read as a mouse grab (8 Nov).
const MANAGED_CURSOR = /\[\s*[^\]]*\bcursor\s*\]\s*::\s*position/i;
// Scripts a statement may be *running*, as opposed to reading: a path ending in a
// script extension, named by the head or after an interpreter.
const SCRIPT_FILE = /\.(?:ps1|psm1|bat|cmd|mjs|cjs|js|py|sh)$/i;
const SCRIPT_MAX_BYTES = 256 * 1024;

/**
 * Would this command take the operator's screen?
 *
 * Not a permission question about a file: the machine is the operator's, and a
 * model that yanks a window in front of them mid-sentence has taken something that
 * was not the harness's to give. The gate asks once per run instead (src/desk.js).
 */
export function screenTaking(command) {
  const text = String(command || '');
  if (!text) return false;
  if (SCREEN_APIS.test(text) || MANAGED_CURSOR.test(text)) return true;
  // The shipped window tools: every action but `query` may put a window in front,
  // because the screenshot falls back to the screen when PrintWindow is refused.
  if (WINDOW_TOOL.test(text) && !SCREEN_QUERY.test(text)) return true;
  return false;
}

/**
 * The scripts a statement *runs*, resolved. Reading a script is not running it, so
 * only the shapes that execute one count: the script is the head, or an interpreter
 * is the head and the script follows it (`pwsh -File x.ps1`, `node x.mjs`,
 * `cmd /c x.bat`).
 */
function scriptsRun(part) {
  const words = part.words || [];
  let at = 0;
  while (at < words.length && (words[at] === '&' || words[at] === '.')) at += 1;
  const head = words[at];
  if (!head) return [];
  if (SCRIPT_FILE.test(head)) return [head];
  const base = String(head).toLowerCase().replace(/\.exe$/i, '');
  if (!INTERPRETERS.has(base)) return [];
  for (let i = at + 1; i < words.length; i += 1) {
    const word = words[i];
    if (word === '-File' || word === '-f') return words[i + 1] ? [words[i + 1]] : [];
    if (/^[-/][A-Za-z]/.test(word) || word.includes('=')) continue;
    if (SCRIPT_FILE.test(word)) return [word];
  }
  return [];
}

/**
 * Does a script this command runs do something only the screen allows?
 *
 * The hole this closes was found by the coder and the designer on 8 Nov: the
 * screen rules read the command line, so they wrote the mouse movement into
 * `capture.ps1` and ran the script — `.\capture.ps1 -Exe …` names nothing and took
 * the mouse anyway. The file is read here, bounded, and only when it is about to be
 * executed.
 */
function scriptTakesScreen(segments, ctx) {
  for (const part of segments) {
    for (const raw of scriptsRun(part)) {
      const target = resolvePath(raw, part.dir || ctx.cwd, { home: ctx.home });
      if (!target || target.unknown || !target.path) continue;
      if (zoneOf(target.path, ctx) !== 'project' && zoneOf(target.path, ctx) !== 'scratch') continue;
      try {
        const stat = fs.statSync(target.path);
        if (!stat.isFile() || stat.size > SCRIPT_MAX_BYTES) continue;
        if (screenTaking(fs.readFileSync(target.path, 'utf8'))) return true;
      } catch {
        // A script that is not there cannot be inspected; running it will fail.
        continue;
      }
    }
  }
  return false;
}

/**
 * The same rule, one level down: a script the command runs.
 *
 * A worker that knows the shell is judged will put the sweep in a file — `.\sweep.ps1`
 * names nothing in the command itself. The screen rule already reads scripts for exactly
 * that reason, so the text is read once, bounded, and scanned with the same shapes: a
 * project's own app by name stays allowed; a family or a sweep does not (10 Nov, found
 * by the strength tests).
 */
function scriptStopsProcesses(segments, ctx) {
  for (const part of segments) {
    for (const raw of scriptsRun(part)) {
      const target = resolvePath(raw, part.dir || ctx.cwd, { home: ctx.home });
      if (!target || target.unknown || !target.path) continue;
      const zone = zoneOf(target.path, ctx);
      if (zone !== 'project' && zone !== 'scratch') continue;
      try {
        const stat = fs.statSync(target.path);
        if (!stat.isFile() || stat.size > SCRIPT_MAX_BYTES) continue;
        const verdict = scanForStop(fs.readFileSync(target.path, 'utf8'));
        if (verdict) return verdict;
      } catch {
        // A script that is not there cannot be inspected; running it will fail.
        continue;
      }
    }
  }
  return null;
}

/**
 * Does this statement run a program the project built?
 *
 * A GUI program takes the screen from the inside, where no command text can be
 * read: the SysMonitor widget calls `SetForegroundWindow` itself when its tray menu
 * opens. Running the project's own executable is therefore the one program launch
 * that asks for the screen (8 Nov).
 */
function runsProjectProgram(segments, ctx) {
  const program = /\.(?:exe|com)$/i;
  const built = (p) => {
    try { return fs.statSync(p).isFile(); } catch {
      // Not there, or not statable: it is not a program this project built.
      return false;
    }
  };
  // A *bare* name is only the project's program if the file is really there: `curl.exe`
  // resolves against the working directory and so looked exactly like a program the
  // project had built — every download asked for the operator's screen while it ran,
  // which is the bother they reported on 9 Nov. A name with a path in it is taken at
  // its word, because the model has said where it means.
  const mine = (target, named) =>
    Boolean(target && !target.unknown && target.path) &&
    program.test(target.path) &&
    zoneOf(target.path, ctx) === 'project' &&
    (/[\\/]/.test(String(named || '')) || built(target.path));
  const launchers = new Set(['start-process', 'start', 'cmd', 'explorer']);
  for (const part of segments) {
    if (part.readsOnly) continue;
    const words = part.words || [];
    let at = 0;
    while (at < words.length && (words[at] === '&' || words[at] === '.')) at += 1;
    const head = String(words[at] || '');
    if (!head) continue;
    const cwd = part.dir || ctx.cwd;
    const base = head.toLowerCase().replace(/\.exe$/i, '');
    if (launchers.has(base)) {
      // `Start-Process x.exe`, `start x.exe`, `cmd /c x.exe`: the program is an
      // argument, and running it is the thing that takes the screen.
      for (let i = at + 1; i < words.length; i += 1) {
        const word = words[i];
        if (/^[-/][A-Za-z]/.test(word) || word.includes('=')) continue;
        if (mine(resolvePath(word, cwd, { home: ctx.home }), word)) return true;
      }
      continue;
    }
    if (mine(resolvePath(head, cwd, { home: ctx.home }), head)) return true;
  }
  return false;
}

/**
 * A shell statement that stops processes it did not start.
 *
 * The incident (10 Nov): a worker finished its task, tidied up, and ran
 * `Get-Process python | ForEach-Object { Stop-Process -Id $_.Id -Force }`. That is not a
 * name and not a path — it is "whatever the list happens to hold" — and the list held
 * the local model server answering the run, which then retried against a closed port for
 * eight minutes. No path rule can see it: nothing in the command names a file.
 *
 * Three shapes are refused, and nothing else is touched:
 *
 *  * **a sweep** — processes piped (or looked up) into a stop with no name: it stops the
 *    whole list, whatever is on it;
 *  * **a family** — `-Name python`, `taskkill /IM python.exe`, a wildcard, `pkill`: a
 *    name reaches every process that carries it, and a runtime's name is shared by every
 *    other program written in that language;
 *  * **a discovered id** — `-Id (Get-NetTCPConnection …)`, `-Id $pid`: an id the command
 *    found rather than one it was given is no safer than a name.
 *
 * A by-name stop of a project's own program (`Stop-Process -Name SysMonitor`) stays
 * allowed: measured against a day of logs, 121 of the 122 kill commands were exactly
 * that, and refusing them would break the way a project tests its own app. Stopping by
 * `-Id <a number>` stays allowed too — that is the shape the brief asks for.
 *
 * A refusal, not a question: an unattended night run must not stop to wait for an answer
 * (the operator's rule), and a refusal tells the model what to do instead.
 */
const SWEEP_TEXT =
  'This stops every process the list holds, and the services running this work are on that list. ' +
  'Stop the one process you started, by its id: Stop-Process -Id <pid>.';
const FAMILY_TEXT =
  'A name stops every process that carries it, and a language runtime\'s name is shared by every other ' +
  'program written in it - one of them may be a service this run depends on. Stop the one process you ' +
  'started, by its id: Stop-Process -Id <pid>.';

/** Anything in a command that can end a process, including the forms with no verb. */
const STOP_ANYWHERE =
  /\b(stop-process|taskkill|pkill|killall|kill|kill\.exe)\b|\.kill\s*\(|invoke-cimmethod[^;|]*\bterminate\b|wmic[^;|]*\bcall\s+terminate\b|call\s+terminate\b/i;

/** Something that lists processes or ports, so a stop next to it is a sweep. */
const LIST_ANYWHERE = /\b(get-process|tasklist|get-nettcpconnection|netstat|wmic|pgrep|ps)\b/i;

/** A nested shell's payload: `powershell -Command "…"`, `cmd /c "…"`, `bash -c '…'`. */
function nestedPayloads(text) {
  const out = [];
  const re = /(?:powershell|pwsh|cmd|bash|sh)(?:\.exe)?\s+(?:-command|-c|\/c|\/k)\s+(["'])([\s\S]+?)\1/gi;
  for (const match of String(text || '').matchAll(re)) out.push(match[2]);
  return out;
}

/**
 * An explicit id a stop was *given*: `-Id 1234`, `-Id $pid`, `/PID $p`.
 *
 * Anything else is a list of processes, not one: a subexpression
 * (`-Id (Get-NetTCPConnection …)`), the pipeline's own object (`-Id $_.Id`), an
 * array, or no id at all. The brief asks a model to read its pid back from a file
 * and stop that, so a plain variable is the *good* shape and has to survive the
 * "something also listed processes" test below. On 10 Nov a worker's cleanup was
 * refused for exactly that reason: `Stop-Process -Id $p` inside a loop over two pid
 * files, with `Get-Process … | Select-Object` in the same command — a read that is
 * not a stop, excused only when the id happened to be a literal number.
 */
function plainId(text) {
  const m = /(?:-id|\/pid)\s+(\([^)]*\)|\$[A-Za-z_][\w.]*|\d+)/i.exec(String(text || ''));
  if (!m) return false;
  const arg = m[1];
  if (arg.startsWith('(')) return false;
  if (/^\$_/.test(arg)) return false;
  if (/^\d+$/.test(arg)) return true;
  return /^\$[A-Za-z_]/.test(arg);
}

/** The verdict for one piece of command text, or null when it stops nothing it should not. */
function scanForStop(text) {
  const t = String(text || '').toLowerCase();
  if (!STOP_ANYWHERE.test(t)) return null;
  // A family, by name or by filter: `-Name python`, `/IM python.exe`, `/FI "IMAGENAME eq …"`.
  const named =
    /(?:-name|--name|\/im)\s+["']?([\w.*?[\]]+)/i.exec(t) ||
    /\/fi\s+"?imagename\s+eq\s+["']?([\w.*?[\]]+)/i.exec(t);
  if (named) {
    const name = named[1].replace(/\.exe$/i, '').replace(/["']/g, '');
    if (/[*?[\]]/.test(name) || INTERPRETERS.has(name)) return FAMILY_TEXT;
  }
  // These never answer to an id.
  if (/\b(pkill|killall)\b/.test(t)) return FAMILY_TEXT;
  if (/invoke-cimmethod[^;|]*\bterminate\b/.test(t)) return FAMILY_TEXT;
  if (/wmic[^;|]*\bcall\s+terminate\b/.test(t)) return FAMILY_TEXT;
  // An id it looked up is no safer than a name; an id it was given is fine.
  //
  // "Looked up" means a subexpression (`-Id (Get-NetTCPConnection …)`) or the pipeline's
  // own object (`-Id $_.Id`) — the things that carry a list. A plain variable is the
  // *good* pattern: the strength tests watched a worker start a server, write its pid to
  // a file, read it back and stop that one (`taskkill /PID $pid`), which is what the
  // brief asks for, and refusing `-Id $anything` would refuse it whenever the model
  // reached for `Stop-Process` instead (10 Nov).
  if (/-id\s+\(/i.test(t) || /-id\s+\$_/i.test(t)) return SWEEP_TEXT;
  if (/\/pid\s+\(/i.test(t) || /\/pid\s+\$_/i.test(t)) return SWEEP_TEXT;
  if (/\.kill\s*\(/.test(t) && !/-id\s+"?\d+/.test(t)) return SWEEP_TEXT;
  // A stop with nothing to name after something listed processes. The statement walk
  // applies this too, but a nested shell's payload is one quoted word and never reaches
  // the walk: `powershell -Command "Get-Process python | Stop-Process"` slipped through
  // until the strength tests found it (10 Nov).
  if (LIST_ANYWHERE.test(t) && STOP_ANYWHERE.test(t)) {
    if (/(?:-name|--name|\/im|\/fi)\b/.test(t)) return null;
    if (plainId(t)) return null;
    return SWEEP_TEXT;
  }
  return null;
}

function stopsOtherProcesses(segments = [], command = '') {
  // A pipe is its own separator (segmentsOf splits on `;`, `&&`, newlines and `|`), so
  // "list then stop" has to be read across the statements: `Get-NetTCPConnection … |
  // Stop-Process` used to slip through for exactly that reason. The raw command is
  // scanned as well, because a nested shell is one quoted word and hides its own text.
  const all = segments.map((part) => (part.words || []).map((word) => String(word)));
  const heads = all.map((words) => String(words[0] || '').toLowerCase().replace(/\.exe$/, ''));
  const lists = heads.some((head) => LIST_VERBS.has(head));
  const texts = [...all.map((words) => words.join(' ')), String(command || '')].filter(Boolean);

  for (const text of texts) {
    const direct = scanForStop(text);
    if (direct) return direct;
    for (const payload of nestedPayloads(text)) {
      const inner = scanForStop(payload);
      if (inner) return inner;
    }
  }

  // A stop with nothing to name, after something in the same command listed processes.
  if (lists) {
    for (const words of all) {
      const at = words.findIndex((word) =>
        /^(stop-process|taskkill|kill)$/i.test(String(word).replace(/\.exe$/i, '')),
      );
      if (at < 0) continue;
      const rest = words.slice(at + 1).join(' ').toLowerCase();
      if (/(?:-name|--name|\/im|\/fi)\b/.test(rest)) continue;
      if (plainId(rest)) continue;
      return SWEEP_TEXT;
    }
  }
  return null;
}

const LIST_VERBS = new Set(['get-process', 'ps', 'tasklist', 'get-nettcpconnection', 'netstat', 'wmic', 'pgrep']);

/** Windows tools whose /Switch is a switch, never a path. */
const SLASH_SWITCH_TOOLS = new Set(['taskkill', 'wmic', 'sc', 'net', 'reg', 'shutdown', 'robocopy', 'icacls', 'schtasks']);

function decideShell(resources, ctx) {
  // A shell command may arrive as one string or as its lines, one resource per
  // line. Joining with a space merged them into a single statement: measured
  // 26 Oct, `Test-Path F:\perm-test` + `Set-Content ...\newline.txt` arrived as
  // two resources, the first read verb excused the second line, and the outside
  // write was allowed. A newline is the separator that keeps them apart.
  const command = (Array.isArray(resources) ? resources : [resources])
    .map((value) => String(value || ''))
    .join('\n')
    .trim();
  if (!command) return ask('The harness got an empty command.', true, 'unknown');

  const info = analyzeCommand(command, ctx.cwd, { home: ctx.home });
  if (info.unknown) return ask('The harness cannot tell where this command lands.', true, 'unknown');

  // PROHIBITED before everything else: a statement that is not read-only may not
  // name a protected path, and neither may a redirect, wherever the command starts.
  // Reading one is fine unless the entry is sealed (Brave), which decides below.
  const segments = Array.isArray(info.segments) && info.segments.length
    ? info.segments
    : [{ paths: info.paths, redirects: info.redirects, readsOnly: info.readsOnly }];

  // Elevation is neither a path nor a kill: `Start-Process … -Verb RunAs` asks
  // Windows for administrator rights, and the UAC prompt is a thing only the
  // operator can answer. It used to be judged as a write into Windows and refused
  // as "Windows is on the protected list", which was untrue — nothing was going to
  // be written there — and unhelpful to a model that could just as well read the
  // sensor without admin (11 Nov). An unattended run must not sit on a prompt it
  // cannot answer, so it is a refusal with the real reason.
  const asksElevation = segments.some((part) => {
    if (part.readsOnly) return false;
    const words = part.words || [];
    let at = 0;
    while (at < words.length && (words[at] === '&' || words[at] === '.')) at += 1;
    const head = String(words[at] || '').toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/, '');
    if (!/^(start-process|start)$/.test(head)) return false;
    return /(?:^|\s)[-/]verb\s+["']?runas\b/i.test(words.join(' '));
  });
  if (asksElevation) {
    return deny(
      'This asks Windows for administrator rights, and an unattended run cannot answer the UAC prompt. ' +
        'Do the same work without elevation; if it truly needs admin, ask the operator to do that one step.',
      true,
      'elevation',
    );
  }

  const skillsRoot = `${slash(ctx.harnessRoot)}/skills`;

  // Copying a shipped skill's assets into a project is the toolbox working, not a
  // change to Synapse. `Copy-Item` is not a read verb, so a source under `skills/`
  // counted as a write into the harness and the built-in PROHIBITED entry refused
  // it: a coder had to read every file of the scaffold and write it again (8 Nov).
  //
  // The carve-out is narrow on purpose. The verb must be a copy — a move would
  // delete the skill. Every source must resolve inside `skills/`, so a `..` that
  // climbs back into `src/` is not a skill copy. The destination must be outside
  // the harness, because a copy into Synapse is still a change to Synapse; and the
  // destination keeps being judged as the write it is, so copying to the Desktop
  // asks and copying into the project is allowed.
  const analyzeCopy = (part) => {
    const words = part.words || [];
    const head = String(words[0] || '').toLowerCase().replace(/\.exe$/i, '');
    if (!COPY_VERBS.has(head)) return null;
    const positional = [];
    let destination = null;
    for (let i = 1; i < words.length; i += 1) {
      const word = words[i];
      if (/^[-/][A-Za-z]/.test(word)) {
        const flag = word.replace(/^[-/]+/, '').toLowerCase();
        if (COPY_VALUE_FLAGS.has(flag) && i + 1 < words.length) {
          const value = words[i + 1];
          if (flag === 'destination') destination = value;
          else if (flag === 'path' || flag === 'literalpath') positional.push(value);
          i += 1;
        }
        continue;
      }
      positional.push(word.includes('=') ? word.slice(word.indexOf('=') + 1) : word);
    }
    if (!destination && positional.length >= 2) destination = positional.pop();
    if (!destination || !positional.length) return null;
    const dest = resolvePath(destination, ctx.cwd, { home: ctx.home });
    if (!dest || dest.unknown || !dest.path) return null;
    if (inside(dest.path, ctx.harnessRoot)) return null;
    const sources = positional.map((word) => resolvePath(word, ctx.cwd, { home: ctx.home }));
    if (!sources.every((source) => source && !source.unknown && source.path && inside(source.path, skillsRoot))) return null;
    return { sources: sources.map((source) => source.path), destination: dest.path };
  };

  const copies = new Map();
  for (const part of segments) {
    const copy = analyzeCopy(part);
    if (copy) copies.set(part, copy);
  }
  // Per statement, never per command: `Copy-Item skills\a proj\b; Remove-Item
  // skills\a` still deletes a skill, and the second statement must be judged as
  // the write it is.
  const copySource = (p, part) => Boolean(copies.get(part)?.sources.includes(p));

  const decisionPaths = segments.flatMap((part) => part.paths.filter((p) => !copySource(p, part)));

  const zones = decisionPaths.map((p) => zoneOf(p, ctx));
  const redirectZones = info.redirects.map((p) => zoneOf(p, ctx));
  // The scratch zone is ours and is meant to be written: it counts as "inside"
  // for the decision, and the sentence at the end says which zone it was.
  const insideZones = (z) => z === 'project' || z === 'scratch';
  const outside = [...zones, ...redirectZones].some((z) => !insideZones(z));
  const scope = zones.includes('harness') || redirectZones.includes('harness')
    ? 'harness'
    : outside
      ? 'outside'
      : 'project';
  const anySecret = [...info.paths, ...info.redirects].some((p) => isSecret(p, ctx));
  if (anySecret) return deny('The harness never opens saved-password folders.', true, 'secret');

  // Processes, after PROHIBITED (which outranks everything) and before any allow: a
  // command that stops processes it did not start is refused, not questioned. See
  // stopsOtherProcesses above for the three shapes and the day that earned them.
  const stopsOthers = stopsOtherProcesses(segments, command) || scriptStopsProcesses(segments, ctx);
  if (stopsOthers) return deny(stopsOthers, true, 'processes');

  const harnessPaths = decisionPaths.filter((p) => zoneOf(p, ctx) === 'harness');
  // A shipped tool runs from the harness's own `skills/` folder, and that is what
  // this allows — statement by statement, never for the whole command, so a second
  // statement that deletes a skill is still judged as the write it is.
  //
  // Two ways to name the script: after an interpreter (`node "<path>"`,
  // `timeout 30 node "<path>"` — measured 4 Nov, the command's head was `timeout`),
  // or with no interpreter at all — PowerShell's call operator (`& "<path>"`, which
  // is how a worker runs a shipped `.ps1`), or the script path as the statement's
  // own head. Inline code is still not a tool: `node -e "…"` names a script it does
  // not run, and treating that as one would let a one-liner write anywhere under
  // `skills/`.
  //
  // Measured 5 Nov: a worker ran `& "…\skills\app-check\bin\window.ps1" -Action shot
  // -Out "…\shots\t5.png"`, the only form PowerShell offers for a `.ps1` that is not
  // on PATH, and the PROHIBITED entry for Synapse refused it as a harness write. The
  // operator's own skills were unusable through the one syntax their shell uses.
  const invokesShippedScript = (words = []) => {
    if (!words.length) return false;
    let at = -1;
    for (let i = words.length - 1; i >= 0; i -= 1) {
      if (INTERPRETERS.has(words[i].toLowerCase().replace(/\.exe$/i, ''))) {
        at = i;
        break;
      }
    }
    if (at === -1) {
      let head = 0;
      while (head < words.length && (words[head] === '&' || words[head] === '.')) head += 1;
      const word = words[head];
      if (!word) return false;
      const target = resolvePath(word, ctx.cwd, { home: ctx.home });
      return Boolean(target && !target.unknown && inside(target.path, skillsRoot));
    }
    for (let i = at + 1; i < words.length; i += 1) {
      const word = words[i];
      if (/^[-/]/.test(word)) {
        const flag = word.replace(/^[-/]+/, '').toLowerCase();
        // `-e`/`-c`/`-Command` carry code, not a file: no tool to allow here.
        if (['e', 'c', 'eval', 'command', 'encodedcommand', 'exec'].includes(flag)) return false;
        continue;
      }
      const target = resolvePath(word, ctx.cwd, { home: ctx.home });
      if (!target || target.unknown) return false;
      return inside(target.path, skillsRoot);
    }
    return false;
  };
  const toolParts = new Set(segments.filter((part) => invokesShippedScript(part.words)));
  const runsShippedTool = toolParts.size > 0;
  // A program named in a shipped tool's arguments is *run*, not written:
  // `-Exe C:\Windows\System32\cmd.exe` launches cmd. Judging that as a change to
  // Windows refused the operator's own skill with "PROHIBITED: Windows is on the
  // protected list" (6 Nov). Only statements that run a shipped script get this,
  // and only program extensions — a path the tool is told to write to
  // (`-Out …\evil.png`) is still judged as the write it is.
  const PROGRAM_EXT = /\.(?:exe|com|bat|cmd|ps1|msi)$/i;
  // The program a statement runs — the head word, or the word after PowerShell's
  // call operator. & "C:\Windows\System32\cmd.exe" /c dir is execution too.
  const headProgram = (part) => {
    const words = part.words || [];
    let at = 0;
    while (at < words.length && (words[at] === '&' || words[at] === '.')) at += 1;
    const word = words[at];
    if (!word || /^[-/]/.test(word)) return null;
    const target = resolvePath(word, ctx.cwd, { home: ctx.home });
    return target && !target.unknown && PROGRAM_EXT.test(target.path) ? target.path : null;
  };
  // A program a launcher verb names is *run*, not written — the same rule as the
  // head of a statement below. `Start-Process …\powershell.exe` puts the program in
  // an argument, so `headProgram` only saw the verb `Start-Process` and the path was
  // judged a write into Windows: a worker reading a temperature sensor was refused
  // as PROHIBITED (11 Nov). Only the launcher's own target is exempt — a second
  // path in the arguments is still judged for what it is.
  const LAUNCHER_VERBS = new Set(['start-process', 'start', 'explorer']);
  const launcherProgram = (part) => {
    const words = part.words || [];
    let at = 0;
    while (at < words.length && (words[at] === '&' || words[at] === '.')) at += 1;
    const head = String(words[at] || '').toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/, '');
    if (!LAUNCHER_VERBS.has(head)) return null;
    for (let i = at + 1; i < words.length; i += 1) {
      const word = words[i];
      if (/^[-/]/.test(word)) continue;
      const target = resolvePath(word, ctx.cwd, { home: ctx.home });
      if (target && !target.unknown && PROGRAM_EXT.test(target.path)) return target.path;
    }
    return null;
  };
  // The harness keeps its stricter rule: only a shipped tool under skills/ may run,
  // so & "…\src\build.ps1" is still the app changing itself. Everything else may
  // be run by its own path — running a program is not writing to it.
  const programInTool = (p, part) =>
    PROGRAM_EXT.test(String(p || '')) &&
    (toolParts.has(part) ||
      (p === headProgram(part) && zoneOf(p, ctx) !== 'harness') ||
      (p === launcherProgram(part) && zoneOf(p, ctx) !== 'harness'));
  // PROHIBITED: a statement that is not read-only may not name a protected path,
  // and neither may a redirect. Running a shipped script is the exception — it is
  // execution, not a change — so the script words that statement names are not
  // counted as writes. Writing *into* skills/ is still caught, redirect included.
  const toolPath = (p, part) => toolParts.has(part) && inside(p, skillsRoot);
  const guardedWrite = segments
    .flatMap((part) => [
      ...(part.readsOnly ? [] : part.paths.filter((p) => !toolPath(p, part) && !programInTool(p, part) && !copySource(p, part))),
      ...part.redirects,
    ])
    .find((p) => prohibitedWrite(p, ctx));
  if (guardedWrite) {
    const entry = prohibitedWrite(guardedWrite, ctx);
    return deny(`PROHIBITED: ${entry.label} is on the protected list.`, true, 'prohibited');
  }
  // A write with no path of its own runs in the statement's directory: `cd
  // C:\Windows` then `del x` names nothing and still lands in Windows. A copy is
  // not that: it runs where it is, and both paths it names are judged already.
  const guardedDir = segments.find((part) => !part.readsOnly && !copies.has(part) && part.dir && prohibitedWrite(part.dir, ctx));
  if (guardedDir) {
    const entry = prohibitedWrite(guardedDir.dir, ctx);
    return deny(`PROHIBITED: ${entry.label} is on the protected list.`, true, 'prohibited');
  }
  // The screen: the one thing on this machine that is the operator's while they are
  // using it. A command that takes it must be their decision, not a policy default —
  // after PROHIBITED, which still outranks every rule here. `deskHeld` is the lease
  // they gave for this run (src/desk.js).
  //
  // Three shapes now, and the second and third were the 8 Nov hole: a call named in
  // the command, a **script** the command runs whose text does it (`.\capture.ps1`
  // moved the mouse and named nothing), and a **program the project built**, whose
  // insides nobody can read (the widget takes the foreground itself).
  const takesScreen =
    screenTaking(command) || scriptTakesScreen(segments, ctx) || runsProjectProgram(segments, ctx);
  if (takesScreen && !ctx.deskHeld) {
    return ask(
      'This would take your screen: the mouse, the keyboard and the focus of whatever you are doing.',
      true,
      'desk',
    );
  }
  if (info.readsOnly) {
    const sealed = segments
      .flatMap((part) => [...part.paths, ...part.redirects])
      .map((p) => prohibitedRead(p, ctx))
      .find(Boolean);
    if (sealed) return deny(`PROHIBITED: ${sealed.label} is not read either.`, true, 'prohibited');
  }
  // A copy's source is a read, and it is judged like one: an entry whose Read is
  // unticked still refuses it, and so does a source the harness would not let a
  // model read at all.
  const copySources = [...copies.values()].flatMap((copy) => copy.sources);
  const sealedCopy = copySources.map((p) => prohibitedRead(p, ctx)).find(Boolean);
  if (sealedCopy) return deny(`PROHIBITED: ${sealedCopy.label} is not read either.`, true, 'prohibited');
  const unreadableCopy = copySources.find((p) => !harnessReadable(p, ctx));
  if (unreadableCopy) return deny("These are Synapse's private files.", true, 'harness');
  const writesHarness =
    redirectZones.includes('harness') || (harnessPaths.length > 0 && !info.readsOnly && !runsShippedTool);
  if (writesHarness) {
    // The Synapse folder is a built-in protection, so this line means the operator
    // switched that entry off on purpose: a change to the harness is then their
    // decision to make, like any other folder outside the project.
    return ask('Synapse is the app itself. Changing it is a deliberate choice.', true, 'harness');
  }
  if (harnessPaths.length > 0 && info.readsOnly && !harnessPaths.every((p) => harnessReadable(p, ctx))) {
    return deny("These are Synapse's private files.", true, 'harness');
  }

  const parts = Array.isArray(info.segments) && info.segments.length
    ? info.segments
    : [{ paths: info.paths, redirects: info.redirects, readsOnly: info.readsOnly, verbRead: info.readsOnly }];
  const outsideWrites = [];
  for (const part of parts) {
    const outsidePartPaths = part.paths.filter((p) => zoneOf(p, ctx) === 'outside' && !programInTool(p, part));
    const outsidePartRedirects = part.redirects.filter((p) => zoneOf(p, ctx) === 'outside');
    // A write with no explicit path runs in the statement's directory: `del x`
    // after `cd D:\projects` is an outside write, though it names nothing.
    const dirOutside = part.dir && zoneOf(part.dir, ctx) === 'outside';
    if (!outsidePartPaths.length && !outsidePartRedirects.length) {
      if (!part.verbRead && dirOutside) outsideWrites.push(part.dir);
      continue;
    }
    // A read verb with its redirects inside is reading that outside path: the
    // read is allowed, whatever the other statements write. `part.readsOnly` also
    // goes false for an inside redirect, which is why `verbRead` is separate.
    if (part.verbRead && !outsidePartRedirects.length) continue;
    outsideWrites.push(...outsidePartPaths, ...outsidePartRedirects);
  }
  if (outsideWrites.length) {
    return ask(
      outsideWrites.some(isUserDataPath)
        ? 'App data belongs in a data folder beside the executable, not the user profile. This is outside the project.'
        : 'Commands may run in the project without asking. This one reaches further.',
      true,
      'outside',
    );
  }

  if (copies.size && !outside) {
    const toScratch = zones.length > 0 && zones.every((z) => z === 'scratch');
    return allow(
      toScratch ? 'This copies a shipped skill into the scratch folder.' : 'This copies a shipped skill into the project.',
      false,
      toScratch ? 'scratch' : 'project',
    );
  }
  if (zones.length === 0 && redirectZones.length === 0) {
    return allow('This runs in the project folder.', false, 'project');
  }
  if (zones.length && zones.every((z) => z === 'scratch') && redirectZones.every((z) => z === 'scratch')) {
    return allow('This runs in the scratch folder.', false, 'scratch');
  }
  return allow(
    outside
      ? 'Reading is allowed. This one is outside the project.'
      : 'Reading is allowed. This is in the project folder.',
    outside,
    scope,
  );
}

/**
 * The harness paths a model may read: everything except the folders that hold keys
 * and state. A folder Synapse gains tomorrow is readable without anyone remembering
 * to add it — which is the difference between a rule and a trap.
 */
function harnessReadable(target, ctx) {
  const suffix = key(target).slice(key(ctx.harnessRoot).length);
  // Listing the harness root shows folder names, not content.
  if (!suffix) return true;
  const rel = `${suffix}/`.replace(/^\/+/, '');
  // An exception is part of the harness that exists *for* the model. The browser writes
  // a screenshot under data\browser\shots and answers with its path; refusing the read
  // made the tool pointless — the model took a picture it could not look at (11 Nov).
  // The rule stays: data\ is closed, except the one folder the harness fills for them.
  if (HARNESS_READABLE.some((part) => rel.startsWith(key(part)))) return true;
  return !HARNESS_DENIED.some((part) => rel.startsWith(key(part)));
}

function decideRead(resources, ctx) {
  const list = (Array.isArray(resources) ? resources : [resources]).filter(Boolean);
  let outside = false;
  let scope = 'project';
  for (const value of list) {
    const target = resolvePath(first(value), ctx.cwd, { home: ctx.home });
    if (!target || target.unknown) return ask('The harness cannot tell which folder this is.', true, 'unknown');
    const zone = zoneOf(target.path, ctx);
    if (zone !== 'project' && zone !== 'scratch') outside = true;
    if (zone === 'harness') scope = 'harness';
    else if (zone === 'outside' && scope !== 'harness') scope = 'outside';
    if (isSecret(target.path, ctx)) return deny('The harness never opens saved-password folders.', outside, 'secret');
    // A protected entry whose Read box is unticked is not read either: the browser
    // treats a read as a touch. Every other protected path is readable — that is
    // the point of the tier, so OS logs and drivers can be inspected.
    const guarded = prohibitedRead(target.path, ctx);
    if (guarded) return deny(`PROHIBITED: ${guarded.label} is not read either.`, outside, 'prohibited');
    // A .env holds live keys. The model may read .env.example; the real file is
    // the operator's to hand over, because the values are the point of it.
    if (isEnvFile(target.path)) return ask('This file holds keys or passwords.', outside, zone);
    if (zone !== 'harness') continue;
    if (!harnessReadable(target.path, ctx)) return deny("These are Synapse's private files.", true, 'harness');
  }
  return allow('Reading is allowed.', outside, scope);
}

/**
 * The decision for one permission request.
 *
 * `resources` is what the engine sent — a path for a file tool, the command text
 * for a shell tool. `cwd` is the session's directory: relative paths resolve
 * there, which is what makes the three zones work for both forms.
 */
/**
 * What one "Always Allow" stands for.
 *
 * A file action is a path: the operator judged *that file*, and a relative and an
 * absolute name for it are the same consent, so the name is resolved.
 *
 * A shell command is not its argument string. The model re-runs the same script
 * with a different tail (`2>&1 | Select-Object …`) and every variant asked again
 * — measured 27 Oct against a scratch script in the engine's temp folder. The
 * grant is the executable and the files the command names, plus whether it reads,
 * writes or runs them: `-ExecutionPolicy Bypass` and a pipe do not change it; a
 * different file, executable or kind of command still asks.
 *
 * Falls back to the raw resources when the command cannot be analysed: a grant
 * that covers less is the safe failure.
 */
export function grantKey({ action, resources, cwd, projectRoot, harnessRoot, home = os.homedir() }) {
  const a = String(action || '').toLowerCase();
  const list = (Array.isArray(resources) ? resources : [resources]).map((r) => String(r || ''));
  if (WRITE_ACTIONS.has(a) || READ_ACTIONS.has(a)) {
    return list
      .map((r) => resolvePath(r, cwd, { home })?.path || r)
      .map((p) => key(p))
      .sort();
  }
  if (!SHELL_ACTIONS.has(a)) return list;
  const command = list.join('\n').trim();
  if (!command) return list;
  const info = analyzeCommand(command, cwd, { home });
  if (info.unknown || !info.paths.length) return list;
  const head = (wordsOf(segmentsOf(command)[0] || '')[0] || '').toLowerCase();
  if (!head) return list;
  const mode = info.redirects.length ? 'write' : info.readsOnly ? 'read' : 'run';
  const paths = [...new Set(info.paths.map((p) => key(p)))].sort();
  return [`${head}|${mode}|${paths.join('|')}`];
}

export function decide({ action, resources, cwd, projectRoot, harnessRoot, scratchRoot, home = os.homedir(), protection = [], deskHeld = false }) {
  const a = String(action || '').toLowerCase();
  const ctx = { cwd, projectRoot, harnessRoot, scratchRoot, home, protection, deskHeld };
  if (WRITE_ACTIONS.has(a)) return decideWrite(resources, ctx);
  if (SHELL_ACTIONS.has(a)) return decideShell(resources, ctx);
  if (EXECUTE_ACTIONS.has(a)) return ask('This is code the harness cannot inspect.', false, 'unknown');
  if (READ_ACTIONS.has(a)) return decideRead(resources, ctx);
  return allow('Nothing in the policy restricts this.', false, 'project');
}

/**
 * The ruleset every session carries.
 *
 * One broad ask per tool family, then the credential denies. Everything else
 * keeps the engine's default agent permissions (allow), because a rule appended
 * later wins and we do not want to re-state the whole world here.
 *
 * `write` is a family of its own and it is the one that was missing (found by the
 * smoke test, 7 Nov): the engine asks for `edit`, `shell`, `execute` and `read`
 * because those rules exist, and for `write` it asks nobody — so a model could
 * create a file anywhere on the machine without a card. The policy's decision for a
 * write was always right; the engine was simply never asked to run it.
 *
 * Order matters: the asks come first so the denies still win on a match, and a
 * caller's own rules (Single's `subagent` deny, a role's folder rules) are
 * appended after this by the caller.
 */
export function rulesFor({ home = os.homedir() } = {}) {
  const rules = [
    { action: 'edit', resource: '*', effect: 'ask' },
    // The write tool's own action. Without this line a write to the Desktop is not
    // a permission request at all — there is nothing for the gate to answer.
    { action: 'write', resource: '*', effect: 'ask' },
    { action: 'shell', resource: '*', effect: 'ask' },
    { action: 'execute', resource: '*', effect: 'ask' },
    // Reads too: the read tool would otherwise reach a relative `..\..\` path
    // that no absolute rule can describe. One gate, one policy.
    { action: 'read', resource: '*', effect: 'ask' },
  ];
  for (const part of SECRET_PARTS) {
    rules.push({ action: 'read', resource: `${slash(home)}/${part}/**`, effect: 'deny' });
    rules.push({ action: 'read', resource: `**/${part}/**`, effect: 'deny' });
  }
  return rules;
}
