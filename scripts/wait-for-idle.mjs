// Is anything running? Answer before a restart can kill it.
//
//   bin\node\node.exe scripts\wait-for-idle.mjs [--timeout 300] [--force]
//
// Exit 0 only when the engine says nothing is active, no card is waiting, no run is live
// and no chat is mid-turn. Exit 1 otherwise — and with [--force] it says so on the way out.
//
// It exists because a hand-written check missed a live turn twice (12 Nov). Both times the
// check looked reasonable: `/api/pending` said `active: []` and `/api/runs` was empty. A
// turn can be live with both true — the card list is not the engine's list of work, and the
// gap between the check and the stop is enough for a turn to start. So this asks three
// questions and needs all three to say "idle":
//
//   1. the engine's own `/api/session/active` — workers included, and it survives a reload;
//   2. `/api/pending` — a card waiting for the operator, or a stop in progress;
//   3. every chat's transcript — an assistant message with no `completed` is a live turn,
//      and ANY such message counts, not only the last one (a steer can follow it).
import fs from 'node:fs';
import path from 'node:path';

const UI = 'http://127.0.0.1:8700';
const ENGINE = 'http://127.0.0.1:8720';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const timeoutSec = argOf('--timeout', 0);
const force = args.includes('--force');

const get = async (url, headers) => {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
};

const engineAuth = () => {
  try {
    const pw = fs.readFileSync(path.join(process.cwd(), 'data', 'engine', 'opencode', 'password.txt'), 'utf8').trim();
    return { authorization: `Basic ${Buffer.from(`opencode:${pw}`).toString('base64')}` };
  } catch {
    return null;
  }
};

async function read() {
  const found = [];
  const pending = await get(`${UI}/api/pending`).catch(() => null);
  if (!pending) return { up: false, found: ['the UI is not answering'] };
  if (pending.canStop) found.push('a stop is in progress');
  if ((pending.permissions || []).length) found.push(`${pending.permissions.length} card(s) waiting`);
  if ((pending.forms || []).length) found.push(`${pending.forms.length} question(s) waiting`);
  if ((pending.active || []).length) found.push(`${pending.active.length} active session(s) in the pending list`);

  const runs = (await get(`${UI}/api/runs`).catch(() => ({ runs: [] }))).runs || [];
  for (const r of runs) found.push(`run ${r.task} (${r.role})`);

  const auth = engineAuth();
  if (auth) {
    // The engine's authority: workers, the Architect, everything.
    const raw = await get(`${ENGINE}/api/session/active`, auth).catch(() => null);
    const list = Array.isArray(raw) ? raw : raw?.data || [];
    if (list.length) found.push(`${list.length} session(s) active in the engine`);
  } else {
    found.push('the engine password could not be read, so its list is unknown');
  }

  const projects = (await get(`${UI}/api/projects`).catch(() => ({ projects: [] }))).projects || [];
  for (const p of projects) {
    for (const s of p.sessions || []) {
      const m = await get(`${UI}/api/sessions/${s.id}/messages`).catch(() => null);
      if (!m) continue;
      const openTurn = (m.messages || []).filter((x) => x.type === 'assistant' && !x.completed).length;
      if (openTurn) found.push(`${p.name}: ${openTurn} unfinished assistant message(s)`);
    }
  }
  return { up: true, found };
}

const deadline = Date.now() + timeoutSec * 1000;
let report = await read();
while (report.found.length && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  report = await read();
}

if (!report.up) {
  console.error(`not idle: ${report.found.join('; ')}`);
  process.exit(1);
}
if (report.found.length) {
  console.error(`NOT IDLE — do not restart: ${report.found.join('; ')}`);
  if (force) console.error('(a restart now would kill that work)');
  process.exit(1);
}
console.log('idle: nothing is running, no card waiting, no chat mid-turn');
