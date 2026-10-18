// A tiny MCP server (stdio, JSON-RPC 2.0, newline-delimited) exposing the
// development plan the Architect publishes and reports progress against.
//
// Why this exists: the plan has to be *structured* — the rail renders it, and
// the orchestration layer will execute from it — and a plan buried in prose is
// neither. This server is deliberately stateless: it validates the call, tells
// the model what it accepted, and returns. The record that matters is the tool
// call itself, which the engine writes into the session transcript, and which
// Synapse reads back in src/plans.js. That is the same path the tool census
// uses, so the plan needs no IPC, no port and no shared process.
//
// stdout carries JSON-RPC and nothing else. All logging goes to stderr.
import { ROLES, STATUSES } from '../plans.js';

const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'plan_publish',
    description:
      'Publish (or replace) your development plan for this job as an ordered list of tasks. ' +
      'Call it once you understand the request and before you start editing or delegating. ' +
      'Each task names the role that should do it, so the operator can see who does what and ' +
      'which model that role runs on. Keep it to real milestones — usually 2 to 12 tasks. ' +
      'The reply lists the task ids; use task_status with those ids to report progress.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'One line: what this job delivers when it is done.',
        },
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: 24,
          description: 'The milestones, in the order they should happen.',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'What the task produces — one line, imperative.',
              },
              role: {
                type: 'string',
                enum: ROLES,
                description: 'Which role does this task.',
              },
              detail: {
                type: 'string',
                description: 'Optional: acceptance criteria, files, or the shape of the result.',
              },
              dependsOn: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional: task ids this one needs first, e.g. ["t1"].',
              },
            },
            required: ['title', 'role'],
            additionalProperties: false,
          },
        },
      },
      required: ['goal', 'tasks'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_status',
    description:
      'Report a change to one task of the published plan. Use it for real milestones — when you ' +
      'start a task, when it is finished, or when it is blocked — not for every step. Mark a task ' +
      '`blocked` only when it cannot proceed without the operator, and say why in `note`: that is ' +
      'what turns the task red and asks for attention. Give a one-line `result` when a task lands.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The task id from plan_publish, e.g. "t3".',
        },
        status: {
          type: 'string',
          enum: STATUSES,
          description:
            'todo · doing · done · blocked (needs the operator) · failed (ran and did not hold).',
        },
        result: {
          type: 'string',
          description: 'Optional: what the task produced, one line.',
        },
        note: {
          type: 'string',
          description: 'Optional: why it is blocked or failed.',
        },
      },
      required: ['id', 'status'],
      additionalProperties: false,
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, payload) {
  send({ jsonrpc: '2.0', id, result: payload });
}

function toolText(id, text, isError = false) {
  result(id, { content: [{ type: 'text', text }], isError });
}

/** The receipt the model works from: it is where the task ids come from. */
function publishReceipt(args) {
  const goal = String(args?.goal || '').trim();
  const tasks = Array.isArray(args?.tasks) ? args.tasks : [];
  if (!tasks.length) return 'Nothing published: `tasks` was empty.';

  const lines = [`Plan recorded — ${tasks.length} task(s).`];
  if (goal) lines.push(`Goal: ${goal}`);
  tasks.forEach((t, i) => {
    const role = String(t?.role || 'architect');
    const warn = ROLES.includes(role) ? '' : `  (unknown role "${role}" — the cards are ${ROLES.join(', ')})`;
    lines.push(`  t${i + 1} · ${role} · ${String(t?.title || '').trim()}${warn}`);
  });
  lines.push(
    'Use these ids with task_status as you go: `doing` when you start, `done` when it lands, ' +
      '`blocked` only when it needs the operator.',
  );
  return lines.join('\n');
}

function statusReceipt(args) {
  const id = String(args?.id || '').trim();
  const status = String(args?.status || '').trim();
  if (!/^t\d+$/i.test(id)) {
    return `Unknown task id "${id}". Use the ids from the plan_publish reply, e.g. "t1".`;
  }
  if (!STATUSES.includes(status)) return `Unknown status "${status}". One of: ${STATUSES.join(', ')}.`;
  const result = args?.result ? ` — ${String(args.result)}` : '';
  const note = args?.note ? ` (${String(args.note)})` : '';
  return `Noted: ${id.toLowerCase()} → ${status}${result}${note}.`;
}

async function handle(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return result(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'synapse-plan', version: '1.0.0' },
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined; // notifications take no reply

    case 'ping':
      return result(id, {});

    case 'tools/list':
      return result(id, { tools: TOOLS });

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      if (name === 'plan_publish') {
        const tasks = Array.isArray(args.tasks) ? args.tasks.length : 0;
        process.stderr.write(`plan_publish -> ${tasks} task(s)\n`);
        return toolText(id, publishReceipt(args));
      }
      if (name === 'task_status') {
        process.stderr.write(`task_status ${String(args.id)} -> ${String(args.status)}\n`);
        return toolText(id, statusReceipt(args));
      }
      return toolText(id, `Unknown tool: ${name}`, true);
    }

    // Clients probe these even when the server does not advertise them.
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
process.stderr.write('synapse-plan MCP ready\n');
