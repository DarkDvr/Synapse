// The Architect's one git action: put the project back to the rollback point kept
// before the newest failed run.
//
// The runner creates that point (a ref under `refs/synapse/`) and keeps it only
// when a run ended badly. This server is deliberately narrow:
//
//   - only the newest result in the project can be restored, so a later task's
//     work can never be wiped by restoring an older one;
//   - only when the run left a checkpoint (a clean completed run has none);
//   - never while a delegation is live, which also keeps a worker from calling it
//     on itself;
//   - the ref is consumed on success, so the same rollback cannot happen twice.
//
// stdout carries JSON-RPC and nothing else. All logging goes to stderr.
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../paths.js';
import { restoreCheckpoint, dropCheckpoint } from '../git.js';

const PROTOCOL_VERSION = '2024-11-05';
const START_DIR = process.cwd();
try { process.chdir(DATA_DIR); } catch { /* the harness folder exists; nothing to do */ }

const TOOL = {
  name: 'restore',
  description:
    'Put the project back to the rollback point Synapse kept before a failed task. Use it only when a ' +
    'worker left the project broken and starting that task again is cheaper than repairing it. Only the ' +
    'newest failed run can be restored; it removes what happened since that run began, and the plan is ' +
    'not touched. Call it with the task id, then judge the row again.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'The task id whose run should be undone, e.g. "t3".' },
    },
    required: ['task'],
    additionalProperties: false,
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
const result = (id, payload) => send({ jsonrpc: '2.0', id, result: payload });
const toolText = (id, text, isError = false) => result(id, { content: [{ type: 'text', text }], isError });

function ledger() {
  const file = path.join(START_DIR, '.synapse', 'runs.jsonl');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {
    // A project with no ledger has no run to restore.
    return [];
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch {
        // A malformed line is not a reason to lose the rest of the ledger.
        return null;
      }
    })
    .filter(Boolean);
}

function openRuns(entries) {
  const closed = new Set(entries.filter((r) => r.kind === 'result').map((r) => r.callId));
  return entries.filter((r) => r.kind === 'delegate' && r.callId && !r.outcome && !closed.has(r.callId));
}

function latestFor(entries, task) {
  const results = entries.filter((r) => r.kind === 'result');
  const newest = results[results.length - 1] || null;
  const mine = [...results].reverse().find((r) => r.task === task) || null;
  return { newest, mine };
}

async function restore(id, task) {
  const entries = ledger();
  const live = openRuns(entries);
  if (live.length) {
    return toolText(
      id,
      'A delegation is still live in this project, so a restore is refused: it would pull the ground out from ' +
        'under the worker. Wait for the report first.',
      true,
    );
  }
  if (!task) return toolText(id, 'Which task? Give the id of the failed run, e.g. "t3".', true);
  const { newest, mine } = latestFor(entries, task);
  if (!mine) return toolText(id, `No finished run for ${task} is recorded in this project.`, true);
  if (!newest || newest.task !== task) {
    return toolText(
      id,
      `Only the newest run can be restored, and that is ${newest?.task || 'none'}. Restoring ${task} now would ` +
        `wipe work done after it; judge ${newest?.task || 'the newer run'} first.`,
      true,
    );
  }
  const ref = mine.checkpoint?.ref;
  if (!ref) {
    return toolText(
      id,
      `${task} kept no rollback point: a clean run deletes it. There is nothing to restore for this run.`,
      true,
    );
  }
  const done = await restoreCheckpoint(START_DIR, ref);
  if (!done.ok) return toolText(id, `The rollback did not happen: ${done.error}`, true);
  await dropCheckpoint(START_DIR, ref);
  try {
    fs.appendFileSync(
      path.join(START_DIR, '.synapse', 'runs.jsonl'),
      `${JSON.stringify({ kind: 'restore', task, ref, at: Date.now(), by: 'model' })}\n`,
    );
  } catch { /* the restore happened; a missing note is not worth undoing it */ }
  process.stderr.write(`restore ${task}: ${done.restored} written, ${done.deleted} removed\n`);
  return toolText(
    id,
    `Restored the project to before ${task}: ${done.restored} file(s) written back, ${done.deleted} removed. ` +
      `The plan is untouched and the row is still yours to judge.`,
  );
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return result(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'synapse-git', version: '1.0.0' },
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined;
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: [TOOL] });
    case 'tools/call': {
      const name = params?.name;
      if (name !== TOOL.name) return toolText(id, `Unknown tool: ${name}`, true);
      return restore(id, String(params?.arguments?.task || '').trim());
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
process.stderr.write('synapse-git MCP ready\n');
