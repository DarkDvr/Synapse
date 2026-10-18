// A tiny MCP server (stdio, JSON-RPC 2.0, newline-delimited) exposing one tool:
// the Architect's request to hand a plan task to the role that owns it.
//
// Like the plan tool before it, this server is deliberately stateless and does
// **not** do the work. It cannot: it has no idea which session called it, and it
// cannot reach the harness. It does not need to. The request is recorded in the
// transcript as an ordinary tool call, Synapse reads it from there on the turn
// boundary, and the actual delegation — creating a worker session on that role's
// model, running it, reporting back — is the harness's job.
//
// That split is why the reply is only a receipt: the Architect is told the task
// is queued and that it will be told the outcome, so it must not sit and wait,
// and must not mark anything done on its own.
//
// stdout carries JSON-RPC and nothing else. All logging goes to stderr.
import { ROLES } from '../plans.js';

const PROTOCOL_VERSION = '2024-11-05';

const TOOL = {
  name: 'delegate',
  description:
    'Hand one task of the project plan to the role that owns it, and let that role do the work. ' +
    'Call it once per task, using the task id from the plan file, and then stop: the task runs ' +
    'asynchronously in its own session on that role\'s own model, and you will be told the outcome ' +
    'in a later message. Never mark a delegated task done yourself — wait for the report, judge it, ' +
    'and only then update the plan.',
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description:
          'The id of the task to delegate, exactly as written in the plan file, e.g. "t1".',
      },
      note: {
        type: 'string',
        description:
          'Optional extra guidance for whoever picks it up: constraints, files to read, or what ' +
          '"done" looks like for this one.',
      },
    },
    required: ['task'],
    additionalProperties: false,
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, payload) {
  send({ jsonrpc: '2.0', id, result: payload });
}

function toolText(id, text, isError = false) {
  result(id, { content: [{ type: 'text', text }], isError });
}

async function handle(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return result(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'synapse-delegate', version: '1.0.0' },
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined; // notifications take no reply

    case 'ping':
      return result(id, {});

    case 'tools/list':
      return result(id, { tools: [TOOL] });

    case 'tools/call': {
      const name = params?.name;
      if (name !== TOOL.name) return toolText(id, `Unknown tool: ${name}`, true);
      const args = params?.arguments || {};
      const task = String(args.task || '').trim();

      if (!/^[A-Za-z0-9._-]+$/.test(task)) {
        return toolText(
          id,
          `"${task}" is not a task id. Use the id from the plan file, e.g. "t1".`,
          true,
        );
      }
      process.stderr.write(`delegate ${task}${args.note ? ' (with a note)' : ''}\n`);
      return toolText(
        id,
        `Queued: ${task}.\n` +
          `It runs in its own session, on the model configured for its role (${ROLES.join(', ')}). ` +
          `You will be told the outcome when it finishes — do not wait, do not do the work yourself, ` +
          `and do not change the task's status until you have the report.`,
      );
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
process.stderr.write('synapse-delegate MCP ready\n');
