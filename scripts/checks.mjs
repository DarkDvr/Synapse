// Run the checks with Auto-Shutdown forcibly off, then put it back.
//
//   bin\node\node.exe scripts\checks.mjs                    # the full suite
//   bin\node\node.exe scripts\checks.mjs -- node --version   # any command
//   bin\node\node.exe scripts\checks.mjs --force             # skip the idle warning
//
// Why this exists: a test run counts as "nothing to do" to the app. A project with
// Auto-Shutdown on, an idle engine and an empty run list is exactly the condition the
// auto-shutdown tick waits for — so the machine powered off under the tests, twice. A
// note in AGENTS.md was not enough (15 Nov), so the harness now turns the switches off
// itself, proves they are off, runs the command, and restores them.
//
// What it turns off:
//   * every chat's Auto-Shutdown (per project, in `synapse.automation`);
//   * the old global `shutdown.whenDone`, which is the default for chats that never
//     stored their own automation;
//   * any countdown already armed, so a minute the tests take cannot become a power-off.
//
// It reads before it writes: a chat that already had the switch off is not "restored" to
// on afterwards.
import path from 'node:path';
import { spawn } from 'node:child_process';

const UI = process.env.SYNAPSE_URL || 'http://127.0.0.1:8700';
const NODE = path.join(process.cwd(), 'bin', 'node', 'node.exe');
const DEFAULT = [NODE, '--test', '--test-timeout=120000', 'tests/*.test.mjs'];

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const split = argv.indexOf('--');
const command = split >= 0 ? argv.slice(split + 1) : argv.filter((a) => !a.startsWith('--'));
const run = command.length ? command : DEFAULT;

const say = (line) => console.log(line);
const warn = (line) => console.error(line);

const api = async (method, pathname, body) => {
  const res = await fetch(`${UI}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status} ${text.slice(0, 160)}`);
  return json;
};

const up = async () => {
  try {
    await api('GET', '/api/status');
    return true;
  } catch {
    return false;
  }
};

async function snapshot() {
  const [projects, config, runs] = await Promise.all([
    api('GET', '/api/projects').catch(() => ({ projects: [] })),
    api('GET', '/api/config').catch(() => ({})),
    api('GET', '/api/runs').catch(() => ({ runs: [] })),
  ]);
  const sessions = [];
  for (const project of projects.projects || []) {
    for (const session of project.sessions || []) {
      if (!session?.id) continue;
      if (session.automation?.autoShutdown === true) sessions.push({ id: session.id, name: project.name });
    }
  }
  return {
    sessions,
    whenDone: config?.shutdown?.whenDone === true,
    config,
    runs: runs.runs || [],
  };
}

async function disable(snap) {
  const turned = [];
  for (const session of snap.sessions) {
    try {
      await api('POST', `/api/sessions/${encodeURIComponent(session.id)}/automation`, {
        patch: { autoShutdown: false },
      });
      turned.push(session);
      say(`  auto-shutdown off: ${session.name}`);
    } catch (err) {
      warn(`  could not switch it off for ${session.name}: ${err.message}`);
    }
  }
  if (snap.whenDone) {
    const next = JSON.parse(JSON.stringify(snap.config || {}));
    next.shutdown = { ...(next.shutdown || {}), whenDone: false };
    await api('PUT', '/api/config', next);
    say('  auto-shutdown off: the global default (shutdown.whenDone)');
  }
  // A countdown already running is cancelled here rather than waited out.
  await api('POST', '/api/power-off/cancel').catch(() => null);
  return turned;
}

async function verify() {
  const now = await snapshot();
  const left = now.sessions.map((s) => s.name);
  if (now.whenDone) left.push('shutdown.whenDone');
  return left;
}

async function restore(turned) {
  for (const session of turned) {
    try {
      await api('POST', `/api/sessions/${encodeURIComponent(session.id)}/automation`, {
        patch: { autoShutdown: true },
      });
      say(`  auto-shutdown back on: ${session.name}`);
    } catch (err) {
      warn(`  could not restore auto-shutdown for ${session.name}: ${err.message}`);
    }
  }
  if (turned.length) {
    warn(`  note: ${turned.length} project(s) have Auto-Shutdown on again; the app now checks the machine's last input before powering off.`);
  }
}

function runCommand() {
  return new Promise((resolve) => {
    const child = spawn(run[0], run.slice(1), { stdio: 'inherit', env: process.env, cwd: process.cwd() });
    child.on('error', (err) => {
      warn(`could not run ${run[0]}: ${err.message}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

let turned = [];
let restoring = false;
const restoreOnce = async () => {
  if (restoring) return;
  restoring = true;
  if (turned.length) {
    say('restoring the switches it changed:');
    await restore(turned);
  }
};

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restoreOnce().finally(() => process.exit(130));
  });
}

if (!(await up())) {
  say(`the app is not answering on ${UI} — nothing can power the machine off, so the checks run as they are.`);
  const code = await runCommand();
  process.exit(code);
}

const snap = await snapshot();
if (!snap.sessions.length && !snap.whenDone) {
  say('auto-shutdown is already off for every project — nothing to change.');
} else {
  say('auto-shutdown is on somewhere; switching it off for the length of the run:');
  turned = await disable(snap);
  const left = await verify();
  if (left.length) {
    warn(`NOT SAFE — auto-shutdown is still on for: ${left.join(', ')}. The command was not run.`);
    await restoreOnce();
    process.exit(1);
  }
  say('verified: no project and no global default can power the machine off during the run.');
}

if (snap.runs.length) {
  warn(`note: ${snap.runs.length} run(s) are live right now (${snap.runs.map((r) => r.task).join(', ')})${force ? '' : ' — the tests do not touch them, but a restart would'}.`);
}

say(`running: ${run.slice(0, 3).join(' ')}${run.length > 3 ? ' …' : ''}`);
const code = await runCommand();
await restoreOnce();
process.exit(code);
