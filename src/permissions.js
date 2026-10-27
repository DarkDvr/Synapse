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
import os from 'node:os';
import path from 'node:path';

const WRITE_ACTIONS = new Set(['edit', 'write', 'patch', 'create']);
const SHELL_ACTIONS = new Set(['shell', 'bash']);
const EXECUTE_ACTIONS = new Set(['execute']);
const READ_ACTIONS = new Set(['read']);

// Inside the harness, this is what a model may read. The list is short on
// purpose: `data/` holds provider keys and session records, `config/` is the
// operator's, and nothing under `bin/` is a document.
const HARNESS_READABLE = ['skills/', 'docs/', 'logs/', 'src/', 'web/', 'AGENTS.md', 'README.md'];
const HARNESS_DENIED = ['data/', 'config/', 'bin/', '.git/', 'vendor/'];

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
  'AppData/Local/Google/Chrome/User Data',
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

/** A secrets file the model should ask about: .env, but not .env.example. */
const isEnvFile = (p) => /(^|\/)\.env(\.[^/]+)?$/i.test(String(p || '')) && !/\.env\.example$/i.test(String(p || ''));

/** Forward slashes, no trailing slash. The form the engine's rules use. */
export const slash = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');

const key = (value) => slash(value).toLowerCase();

/** Is `child` the same as, or under, `parent`? Case-insensitive on Windows. */
export function inside(child, parent) {
  const c = key(child);
  const p = key(parent);
  if (!c || !p) return false;
  return c === p || c.startsWith(`${p}/`);
}

/** Which of the three zones a resolved path belongs to. */
export function zoneOf(target, { projectRoot, harnessRoot }) {
  if (inside(target, projectRoot)) return 'project';
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
export function segmentsOf(command) {
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
  const result = { paths: [], redirects: [], unknown: false, readsOnly: true };
  let dir = cwd;
  for (const segment of segmentsOf(command)) {
    const words = wordsOf(segment);
    if (!words.length) continue;
    const head = words[0].toLowerCase();

    // A directory change decides where the rest of the command runs, so it is
    // resolved first and carried forward. `Set-Location -Path X` writes the
    // target after a flag, so a flag is skipped rather than resolved as a path.
    if (CD_VERBS.has(head) && words[1]) {
      let targetWord = words[1];
      if (/^-\w/.test(targetWord) || /^\/[a-z]$/i.test(targetWord)) targetWord = words[2];
      if (!targetWord) continue;
      const target = resolvePath(targetWord, dir, { home });
      if (!target) continue;
      if (target.unknown) { result.unknown = true; continue; }
      result.paths.push(target.path);
      dir = target.path;
      continue;
    }

    if (!READ_VERBS.test(words[0])) result.readsOnly = false;

    for (const word of words.slice(1)) {
      const candidate = word.includes('=') ? word.slice(word.indexOf('=') + 1) : word;
      if (!looksLikePath(candidate)) continue;
      const target = resolvePath(candidate, dir, { home });
      if (!target) continue;
      if (target.unknown) { result.unknown = true; continue; }
      result.paths.push(target.path);
    }

    for (const match of segment.matchAll(REDIRECT)) {
      const target = resolvePath(match[1], dir, { home });
      if (!target) continue;
      if (target.unknown) { result.unknown = true; continue; }
      result.redirects.push(target.path);
      result.readsOnly = false;
    }
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
  for (const value of list) {
    const target = resolvePath(first(value), ctx.cwd, { home: ctx.home });
    if (!target || target.unknown) return ask('The harness cannot tell which folder this is.', true, 'unknown');
    if (isSecret(target.path, ctx)) return deny('The harness never opens saved-password folders.', true, 'secret');
    zones.push(zoneOf(target.path, ctx));
  }
  if (zones.includes('harness')) {
    return deny('Synapse is the app itself; it may be read, not changed.', true, 'harness');
  }
  if (zones.includes('outside')) {
    return ask('Only the project may be changed without asking. This is not in it.', true, 'outside');
  }
  return allow('This is in the project folder.', false, 'project');
}

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

  const zones = info.paths.map((p) => zoneOf(p, ctx));
  const redirectZones = info.redirects.map((p) => zoneOf(p, ctx));
  const outside = [...zones, ...redirectZones].some((z) => z !== 'project');
  const scope = zones.includes('harness') || redirectZones.includes('harness')
    ? 'harness'
    : outside
      ? 'outside'
      : 'project';
  const anySecret = [...info.paths, ...info.redirects].some((p) => isSecret(p, ctx));
  if (anySecret) return deny('The harness never opens saved-password folders.', true, 'secret');

  const harnessPaths = info.paths.filter((p) => zoneOf(p, ctx) === 'harness');
  const head = (wordsOf(segmentsOf(command)[0] || '')[0] || '').toLowerCase();
  const toolbox =
    INTERPRETERS.has(head) &&
    harnessPaths.length > 0 &&
    harnessPaths.every((p) => inside(p, `${slash(ctx.harnessRoot)}/skills`));
  const writesHarness =
    redirectZones.includes('harness') || (harnessPaths.length > 0 && !info.readsOnly && !toolbox);
  if (writesHarness) {
    return deny('Synapse is the app itself; it may be read, not changed.', true, 'harness');
  }
  if (harnessPaths.length > 0 && info.readsOnly && !harnessPaths.every((p) => harnessReadable(p, ctx))) {
    return deny("These are Synapse's private files.", true, 'harness');
  }

  const outsidePaths = info.paths.filter((p) => zoneOf(p, ctx) === 'outside');
  const outsideWrite = redirectZones.includes('outside');
  if ((outsidePaths.length || outsideWrite) && (outsideWrite || !info.readsOnly)) {
    return ask('Commands may run in the project without asking. This one reaches further.', true, 'outside');
  }

  if (zones.length === 0 && redirectZones.length === 0) {
    return allow('This runs in the project folder.', false, 'project');
  }
  return allow('Reading is allowed. This one is outside the project.', outside, scope);
}

/** The harness paths a model may read: documents and logs, not state or keys. */
function harnessReadable(target, ctx) {
  const suffix = key(target).slice(key(ctx.harnessRoot).length);
  // Listing the harness root shows folder names, not content.
  if (!suffix) return true;
  const rel = `${suffix}/`.replace(/^\/+/, '');
  if (HARNESS_DENIED.some((part) => rel.startsWith(key(part)))) return false;
  return HARNESS_READABLE.some((part) => rel.startsWith(key(part)));
}

function decideRead(resources, ctx) {
  const list = (Array.isArray(resources) ? resources : [resources]).filter(Boolean);
  let outside = false;
  let scope = 'project';
  for (const value of list) {
    const target = resolvePath(first(value), ctx.cwd, { home: ctx.home });
    if (!target || target.unknown) return ask('The harness cannot tell which folder this is.', true, 'unknown');
    const zone = zoneOf(target.path, ctx);
    if (zone !== 'project') outside = true;
    if (zone === 'harness') scope = 'harness';
    else if (zone === 'outside' && scope !== 'harness') scope = 'outside';
    if (isSecret(target.path, ctx)) return deny('The harness never opens saved-password folders.', outside, 'secret');
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
export function decide({ action, resources, cwd, projectRoot, harnessRoot, home = os.homedir() }) {
  const a = String(action || '').toLowerCase();
  const ctx = { cwd, projectRoot, harnessRoot, home };
  if (WRITE_ACTIONS.has(a)) return decideWrite(resources, ctx);
  if (SHELL_ACTIONS.has(a)) return decideShell(resources, ctx);
  if (EXECUTE_ACTIONS.has(a)) return ask('This is code the harness cannot inspect.', false, 'unknown');
  if (READ_ACTIONS.has(a)) return decideRead(resources, ctx);
  return allow('Nothing in the policy restricts this.', false, 'project');
}

/**
 * The ruleset every session carries.
 *
 * Four broad asks, then the credential denies. Everything else keeps the
 * engine's default agent permissions (allow), because a rule appended later
 * wins and we do not want to re-state the whole world here.
 *
 * Order matters: the asks come first so the denies still win on a match, and a
 * caller's own rules (Single's `subagent` deny, a role's folder rules) are
 * appended after this by the caller.
 */
export function rulesFor({ home = os.homedir() } = {}) {
  const rules = [
    { action: 'edit', resource: '*', effect: 'ask' },
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
