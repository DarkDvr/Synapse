// Cleaning up what a project leaves running.
//
// Workers and their tools start things: a static server so a browser can see a
// page, a script that watches a folder. Nothing owns them when the run ends. Timer
// Test 1 left a `python -m http.server 8765` and Shift Test 6 left a
// `qc-serve.js` on 8321 — both still listening hours later, both serving pages from
// projects nobody was looking at. This module finds those and stops them.
//
// The rules are the ones in AGENTS.md, and they are not negotiable:
//
//  * **never match by process name** — `opencode` is also the operator's editor,
//    and `*@opencode*` is its install path;
//  * **prefer an identity this harness owns** — a project folder it created, a
//    script under its own tree;
//  * **prove the match before acting** — a command line that names the project, or
//    a port whose page really is the project's;
//  * **and never touch what it cannot prove.** An unattributable process is listed
//    for the operator, not killed.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/** Never, whatever the evidence says. */
const DENY = /@opencodedesktop|ai\.opencode\.desktop/i;

/** Runtimes that can serve a page. A worker's leftovers come from these. */
const RUNTIME = /(?:node|python|python3|pwsh|powershell|deno|bun)\.exe$/i;

const sh = (cmd, args, timeout = 12000) =>
  new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });

/** Every process, as `{ pid, parent, started, exe, cmd }`. Empty when it cannot tell. */
export async function listProcesses() {
  const out = await sh('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
  ]);
  if (!out.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((r) => r && Number.isFinite(Number(r.ProcessId)))
    .map((r) => ({
      pid: Number(r.ProcessId),
      parent: Number(r.ParentProcessId) || 0,
      started: Number(new Date(r.CreationDate)) || 0,
      exe: String(r.ExecutablePath || ''),
      cmd: String(r.CommandLine || ''),
    }));
}

/** Listening TCP ports and the process holding each: `[{ port, pid }]`. */
export async function listListeners() {
  const out = await sh('netstat.exe', ['-ano', '-p', 'TCP']);
  const found = [];
  for (const line of out.split(/\r?\n/)) {
    // "  TCP    127.0.0.1:8765    0.0.0.0:0    LISTENING    47920"
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (m) found.push({ port: Number(m[1]), pid: Number(m[2]) });
  }
  return found;
}

/** Is this process one this harness may stop? */
export function mayStop(proc, { keep = [] } = {}) {
  if (!proc || !proc.pid || proc.pid <= 4) return false;
  if (keep.includes(proc.pid)) return false;
  if (DENY.test(proc.exe) || DENY.test(proc.cmd)) return false;
  return RUNTIME.test(proc.exe) || RUNTIME.test(proc.cmd);
}

/** A few files that identify a folder by *content* — same names prove nothing. */
function probeFiles(dir) {
  const out = [];
  const wants = /\.(html?|css|js|mjs|json|txt|md)$/i;
  const look = (base) => {
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= 4) return;
      const full = path.join(base, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isDirectory()) {
        // One level down only: `bin/`, `src/`, never a node_modules crawl.
        if (rel.split(path.sep).length < 2) look(full);
        continue;
      }
      if (!wants.test(entry.name)) continue;
      try {
        if (fs.statSync(full).size < 1024 * 1024) out.push(rel);
      } catch {
        /* unreadable */
      }
    }
  };
  look(dir);
  return out;
}

/** Fetch a path from a port, as bytes, or null. */
function getBytes(port, rel, timeout = 900) {
  const asked = `/${rel.split(path.sep).join('/')}`;
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: asked, timeout }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/**
 * Is this port really serving *this* folder?
 *
 * By content, never by name: two projects with a `bin/` and an `index.html` have
 * identical listings, so the only proof is a file served byte for byte the same as
 * the one on disk. A test spins a real server to hold this down.
 */
export async function servesProject(port, dir) {
  for (const rel of probeFiles(dir)) {
    let local = null;
    try {
      local = fs.readFileSync(path.join(dir, rel));
    } catch {
      continue;
    }
    const remote = await getBytes(port, rel);
    if (remote && remote.equals(local)) return true;
  }
  return false;
}

/**
 * What is still running for this project.
 *
 * Two independent proofs, either is enough: a command line that names the project
 * folder, or a listening port whose page really is the project's. The second
 * exists because `python -m http.server` names nothing at all.
 */
export async function findForProject(dir, procs = null) {
  const key = String(dir || '').toLowerCase().replace(/\\/g, '/');
  if (!key) return [];
  const all = procs || (await listProcesses());
  const byPid = new Map(all.map((p) => [p.pid, p]));
  const hits = new Map();

  for (const proc of all) {
    if (!mayStop(proc)) continue;
    if (String(proc.cmd).toLowerCase().replace(/\\/g, '/').includes(key)) hits.set(proc.pid, { proc, why: 'names the folder' });
  }

  for (const { port, pid } of await listListeners()) {
    if (hits.has(pid)) continue;
    const proc = byPid.get(pid);
    if (!mayStop(proc)) continue;
    // Only ports that a runtime holds and that answer with this project's files.
    if (await servesProject(port, dir)) hits.set(pid, { proc, why: `serves it on port ${port}` });
  }

  return [...hits.values()];
}

/**
 * Stop them, saying what it is about to do first.
 *
 * `dryRun` lists and stops nothing — the operator sees the selection alone, which
 * is the rule this machine paid days for.
 */
export async function sweepProject(dir, { log = null, keep = [], dryRun = false } = {}) {
  const found = await findForProject(dir);
  const stop = found.filter((f) => !keep.includes(f.proc.pid));
  if (!stop.length) return { found: 0, stopped: [], kept: [] };

  const describe = (f) => `pid ${f.proc.pid} (${path.basename(f.proc.exe || 'process')}: ${f.why})`;
  log?.info?.(`cleanup: ${stop.length} process(es) still running for ${path.basename(dir)}: ${stop.map(describe).join(', ')}`);
  if (dryRun) return { found: stop.length, stopped: [], kept: stop.map((f) => f.proc.pid) };

  const stopped = [];
  for (const { proc, why } of stop) {
    try {
      process.kill(proc.pid);
      stopped.push({ pid: proc.pid, why });
    } catch (err) {
      log?.warn?.(`cleanup: could not stop pid ${proc.pid}: ${err.message}`);
    }
  }
  if (stopped.length) {
    log?.info?.(`cleanup: stopped ${stopped.length} (${stopped.map((s) => s.pid).join(', ')}) for ${path.basename(dir)}`);
  }
  return { found: stop.length, stopped, kept: [] };
}

/**
 * Files a worker left behind in `.synapse/` that its plan never asked for.
 *
 * The Designer on Fever Tracker finished with `contrast.mjs` and `serve.mjs` in
 * `.synapse/design/`, and a nested `.synapse/design/.synapse/design/shots/` where
 * a render wrote to a relative output path twice. None of it is a deliverable, all
 * of it makes the next worker's folder look like it contains something meant, and
 * the operator had to clean it by hand.
 *
 * Deliberately narrow, because this deletes: only scripts, logs and temp files;
 * only inside `.synapse/`; never a file the plan names in `reads`, and never one of
 * the files Synapse itself reads (plan, runs, features, requirement, decisions).
 * A nested `.synapse` under `.synapse` is always scratch. Anything it removes is
 * logged by path, and `dryRun` lists instead of deleting.
 */
const SCRATCH = /\.(mjs|js|cjs|ts|ps1|sh|bat|cmd|py|tmp|log|bak)$/i;
const KEEP = new Set(['plan.json', 'runs.jsonl', 'features.json', 'requirement.md', 'decisions.md']);

export function findScratch(dir, { named = [] } = {}) {
  const root = path.join(dir, '.synapse');
  const keep = new Set([...named].map((n) => path.resolve(dir, n).toLowerCase()));
  const out = [];
  const walk = (at, depth) => {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) {
        // `.synapse` inside `.synapse` is a doubled relative path, not structure.
        if (entry.name === '.synapse') {
          out.push({ path: full, why: 'nested .synapse (a relative path doubled)' });
          continue;
        }
        walk(full, depth + 1);
        continue;
      }
      if (!SCRATCH.test(entry.name)) continue;
      if (KEEP.has(entry.name.toLowerCase())) continue;
      if (keep.has(full.toLowerCase())) continue;
      out.push({ path: full, why: 'scratch file' });
    }
  };
  walk(root, 0);
  return out;
}

/** Remove them, saying what first. `dryRun` lists and deletes nothing. */
export function sweepScratch(dir, { log = null, named = [], dryRun = false } = {}) {
  const found = findScratch(dir, { named });
  if (!found.length) return { found: 0, removed: [] };
  const list = found.map((f) => path.relative(dir, f.path).replace(/\\/g, '/'));
  log?.info?.(`cleanup: ${found.length} scratch item(s) in .synapse for ${path.basename(dir)}: ${list.join(', ')}`);
  if (dryRun) return { found: found.length, removed: [], would: list };
  const removed = [];
  for (const f of found) {
    try {
      fs.rmSync(f.path, { recursive: true, force: true });
      removed.push(path.relative(dir, f.path).replace(/\\/g, '/'));
    } catch (err) {
      log?.warn?.(`cleanup: could not remove ${f.path}: ${err.message}`);
    }
  }
  if (removed.length) log?.info?.(`cleanup: removed ${removed.length} scratch item(s) (${removed.join(', ')})`);
  return { found: found.length, removed };
}

/**
 * Helper processes left behind by an engine that is gone.
 *
 * The engine spawns its MCP servers as children; they should die with it, and when
 * it is killed outright they do not. A node process whose command line is under
 * this repository's `src/mcp/` and whose parent is no longer running is exactly
 * that, and nothing else.
 */export async function sweepOrphans(root, { log = null, keep = [], dryRun = false } = {}) {
  const all = await listProcesses();
  const live = new Set(all.map((p) => p.pid));
  const mine = `${String(root).toLowerCase().replace(/\\/g, '/')}/src/mcp/`;
  const orphans = all.filter(
    (p) =>
      mayStop(p, { keep }) &&
      String(p.cmd).toLowerCase().replace(/\\/g, '/').includes(mine) &&
      !live.has(p.parent),
  );
  if (!orphans.length) return { found: 0, stopped: [] };
  log?.info?.(`cleanup: ${orphans.length} orphaned helper(s): ${orphans.map((p) => p.pid).join(', ')}`);
  if (dryRun) return { found: orphans.length, stopped: [] };
  const stopped = [];
  for (const p of orphans) {
    try {
      process.kill(p.pid);
      stopped.push(p.pid);
    } catch {
      /* already gone */
    }
  }
  if (stopped.length) log?.info?.(`cleanup: stopped orphaned helper(s) ${stopped.join(', ')}`);
  return { found: orphans.length, stopped };
}
