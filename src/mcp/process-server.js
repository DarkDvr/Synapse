// A process a model owns: start it, read its log, stop it by the id Synapse gave.
//
// The shell tool can start a server, but nothing owns it afterwards — that is why
// the cleanup code exists, and why the brief has to say "stop what you started by
// its id". This tool is the missing half: Synapse launches the process, keeps its
// pid in the project, and answers the same id for logs and for the stop.
//
// Three rules:
//   - the command is judged by the same shell policy as any other (a process
//     outside the project, or a protected path, is refused before anything runs);
//   - the registry and the logs live inside `.synapse`, so the work is not
//     scattered and a project's deletion takes them with it;
//   - `stop` kills the tree of the pid Synapse recorded, never a name.
//
// stdout carries JSON-RPC and nothing else. All logging goes to stderr.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_FILE, DATA_DIR } from '../paths.js';
import { checkDecision } from '../checks.js';

const PROTOCOL_VERSION = '2024-11-05';
const MAX_LIVE = 5;
const LOG_TAIL = 40;
const LOG_MAX = 8000;

const START_DIR = process.cwd();
try { process.chdir(DATA_DIR); } catch { /* the harness folder exists; nothing to do */ }

const STATE_DIR = path.join(START_DIR, '.synapse', 'processes');
const REGISTRY = path.join(START_DIR, '.synapse', 'processes.json');

let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {
  // No config yet is the default policy, not a failed start.
  config = {};
}

const TOOL = {
  name: 'process',
  description:
    'Run a long-lived process — a dev server, a watcher, a preview — and keep control of it. ' +
    'action "start" launches the command in the project and answers an id and a log file; "logs" returns ' +
    'the end of that log; "stop" kills the tree of that id. Use it instead of leaving a server running ' +
    'from a shell call, and always stop what you started when the task is done.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'logs', 'stop'], description: 'What to do.' },
      command: { type: 'string', description: 'For start: the command line, run in the project folder.' },
      id: { type: 'string', description: 'For logs and stop: the id start answered, e.g. "p1".' },
      lines: { type: 'integer', description: 'For logs: how many lines from the end (default 40, max 200).' },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
const result = (id, payload) => send({ jsonrpc: '2.0', id, result: payload });
const toolText = (id, text, isError = false) => result(id, { content: [{ type: 'text', text }], isError });

function readRegistry() {
  try {
    const parsed = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    return Array.isArray(parsed?.processes) ? parsed.processes : [];
  } catch {
    // No registry yet, or one that cannot be read: an empty list is the safe answer.
    return [];
  }
}

function writeRegistry(processes) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(REGISTRY, `${JSON.stringify({ version: 1, processes }, null, 2)}\n`, 'utf8');
  } catch { /* a registry that cannot be written costs a stop, not the process */ }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is not ours to signal; anything else says gone.
    return err.code === 'EPERM';
  }
}

/** Drop entries that are gone and old; the log file stays for the operator. */
function pruned(processes) {
  return processes.filter((p) => p && p.id && (!p.stoppedAt || Date.now() - p.stoppedAt < 86400000));
}

function start(id, command) {
  const cmd = String(command || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!cmd) return toolText(id, 'Give the command to start, as one line.', true);
  const decision = checkDecision(cmd, { dir: START_DIR, config });
  if (decision.effect !== 'allow') {
    return toolText(
      id,
      `That command is not a process this project may start: ${decision.reason || 'the policy did not allow it'}. ` +
        `Run it through the shell if it is a one-off, or narrow it to the project folder.`,
      true,
    );
  }
  const processes = pruned(readRegistry());
  const live = processes.filter((p) => !p.stoppedAt && alive(p.pid));
  if (live.length >= MAX_LIVE) {
    return toolText(
      id,
      `There are already ${live.length} processes running (${live.map((p) => p.id).join(', ')}). ` +
        `Stop one before starting another.`,
      true,
    );
  }
  const next = processes.reduce((n, p) => Math.max(n, Number(String(p.id).replace(/\D/g, '')) || 0), 0) + 1;
  const procId = `p${next}`;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const logFile = path.join(STATE_DIR, `${procId}.log`);
    fs.writeFileSync(logFile, '', { flag: 'a' });
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    logStream.on('error', () => process.stderr.write(`process ${procId}: the log file could not be written\n`));
    const child = spawn(cmd, {
      cwd: START_DIR,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // The server stays alive for the run, so its pipes are the log. The stream is
    // shared by stdout and stderr, in the order the process wrote them.
    child.stdout.pipe(logStream, { end: false });
    child.stderr.pipe(logStream, { end: false });
    child.on('error', (err) => process.stderr.write(`process ${procId} could not start: ${err.message}\n`));
    const entry = {
      id: procId,
      pid: child.pid,
      command: cmd,
      log: `.synapse/processes/${procId}.log`,
      startedAt: Date.now(),
    };
    child.on('close', () => {
      logStream.end();
      try {
        const all = readRegistry();
        const found = all.find((p) => p.id === procId);
        if (found && !found.stoppedAt) {
          found.stoppedAt = Date.now();
          writeRegistry(all);
        }
      } catch { /* the process is gone; the registry can wait for the next call */ }
    });
    processes.push(entry);
    writeRegistry(processes);
    process.stderr.write(`process ${procId} started (pid ${child.pid}): ${cmd}\n`);
    return toolText(
      id,
      `Started ${procId} (pid ${child.pid}). Its log is ${entry.log}. ` +
        `Read it with action "logs", stop it with action "stop" and id ${procId}.`,
    );
  } catch (err) {
    return toolText(id, `The process did not start: ${err.message}`, true);
  }
}

function logs(rpcId, procId, wanted) {
  const entry = readRegistry().find((p) => p.id === String(procId || '').trim());
  if (!entry) return toolText(rpcId, `No process named "${procId}" in this project.`, true);
  const count = Math.min(200, Math.max(1, Number(wanted) || LOG_TAIL));
  let text = '';
  try { text = fs.readFileSync(path.join(START_DIR, entry.log), 'utf8'); } catch {
    // No log yet is an empty log, not a failed tool.
    text = '';
  }
  if (!text.trim()) {
    return toolText(rpcId, `${entry.id} (pid ${entry.pid}) has written nothing to ${entry.log} yet.`);
  }
  const tail = text.split('\n').slice(-count).join('\n').slice(-LOG_MAX);
  return toolText(
    rpcId,
    `${entry.id} (pid ${entry.pid}, ${alive(entry.pid) && !entry.stoppedAt ? 'running' : 'not running'}) — ` +
      `last ${count} line(s) of ${entry.log}:\n${tail}`,
  );
}

function stop(rpcId, procId) {
  const processes = readRegistry();
  const entry = processes.find((p) => p.id === String(procId || '').trim());
  if (!entry) return toolText(rpcId, `No process named "${procId}" in this project.`, true);
  if (entry.stoppedAt || !alive(entry.pid)) {
    entry.stoppedAt = entry.stoppedAt || Date.now();
    writeRegistry(processes);
    return toolText(rpcId, `${entry.id} is not running. Its log is still at ${entry.log}.`);
  }
  return new Promise((resolve) => {
    execFile(
      'taskkill',
      ['/PID', String(entry.pid), '/T', '/F'],
      { windowsHide: true, timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) {
          resolve(
            toolText(
              rpcId,
              `Could not stop ${entry.id} (pid ${entry.pid}): ${String(stderr || err.message).trim()}`,
              true,
            ),
          );
          return;
        }
        entry.stoppedAt = Date.now();
        writeRegistry(processes);
        process.stderr.write(`process ${entry.id} stopped (pid ${entry.pid})\n`);
        resolve(toolText(rpcId, `Stopped ${entry.id} (pid ${entry.pid}). Its log is at ${entry.log}.`));
      },
    );
  });
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return result(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'synapse-process', version: '1.0.0' },
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined;
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: [TOOL] });
    case 'tools/call': {
      if (params?.name !== TOOL.name) return toolText(id, `Unknown tool: ${params?.name}`, true);
      const args = params?.arguments || {};
      if (args.action === 'start') return start(id, args.command);
      if (args.action === 'logs') return logs(id, args.id, args.lines);
      if (args.action === 'stop') return stop(id, args.id);
      return toolText(id, `"${args.action}" is not an action. Use start, logs or stop.`, true);
    }
    case 'resources/list':
      return result(id, { resources: [] });
    case 'resources/templates/list':
      return result(id, { resourceTemplates: [] });
    case 'prompts/list':
      return result(id, { prompts: [] });
    default:
      if (id !== undefined) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
      return undefined;
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // A partial line is not a request; the next line starts clean.
      continue;
    }
    Promise.resolve(handle(msg)).catch((err) => {
      if (msg?.id !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } });
      }
    });
  }
});
process.stdin.on('end', () => process.exit(0));
process.stderr.write('synapse-process MCP ready\n');
