// A tiny MCP server (stdio, JSON-RPC 2.0, newline-delimited) exposing one tool:
// a worker's own estimate of how long a long command will take.
//
// Like the delegate tool, it is deliberately stateless and does nothing itself: the
// request is an ordinary tool call in the transcript, and the harness reads it from
// there on its next poll. That split is why it can be this small — and why the
// lease survives a page reload, a reconnect, or a second view.
//
// The worker calls it *before* the long command, because a model inside a shell
// call cannot answer anything. The harness then holds the stall clock off for the
// lease, and at its end asks the worker whether it needs more.
//
// stdout carries JSON-RPC and nothing else. All logging goes to stderr.
const PROTOCOL_VERSION = '2024-11-05';

const MAX_MINUTES = 480;

const TOOL = {
  name: 'lease',
  description:
    'Tell Synapse that the command you are about to run will take a long time, so it does not ' +
    'mistake silence for a stall. Call it once, immediately BEFORE a download, build, install or ' +
    'any other command you expect to run longer than about ten minutes. Give your honest estimate ' +
    'in minutes and a one-line reason. Synapse holds the stall clock off until the lease ends; if ' +
    'it ends while you are still working, it asks you, and you may call lease once more for the ' +
    'time you need. This does not start or run anything — it is only a warning with a clock.',
  inputSchema: {
    type: 'object',
    properties: {
      minutes: {
        type: 'number',
        description:
          'How long the command will take, in minutes. Be generous: a 90-minute download is 90, ' +
          'and a 5-hour one is 300. Between 0.1 and 480.',
      },
      reason: {
        type: 'string',
        description: 'One short line saying what is running, e.g. "downloading a 200 GB archive".',
      },
    },
    required: ['minutes'],
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
        serverInfo: { name: 'synapse-lease', version: '1.0.0' },
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
      const args = params?.arguments || {};
      const minutes = Number(args.minutes);
      const reason = String(args.reason || '').trim().slice(0, 200);

      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_MINUTES) {
        return toolText(
          id,
          `"${args.minutes}" is not a lease. Give minutes as a number between 0.1 and ${MAX_MINUTES}.`,
          true,
        );
      }
      process.stderr.write(`lease ${minutes} min${reason ? ` — ${reason}` : ''}\n`);
      const shown = minutes >= 1 ? `${Math.round(minutes)} minute(s)` : `${Math.round(minutes * 60)} second(s)`;
      return toolText(
        id,
        `Lease noted: ${shown}${reason ? ` — ${reason}` : ''}.\n` +
          `Synapse will not treat silence as a stall until it ends. If it ends while you are still ` +
          `working, you will be asked; call lease once more with the time you need (one extension). ` +
          `If you are stuck, say so and stop instead.`,
      );
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
process.stderr.write('synapse-lease MCP ready\n');
