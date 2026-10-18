// A tiny MCP server (stdio, JSON-RPC 2.0, newline-delimited) exposing one tool:
// a working web search.
//
// Why this exists: the engine's built-in `websearch` needs a provider key and
// returns HTTP 403 on this machine, so the models had no search at all. Rather
// than fake it, Synapse registers this server in the engine's own config
// (see engines/opencode.js) and the engine hands the tool to the model like any
// other. Nothing here is engine-specific — it is a plain MCP server.
//
// stdout carries JSON-RPC and nothing else. All logging goes to stderr.
import { webSearch, formatResults } from '../search.js';

const PROTOCOL_VERSION = '2024-11-05';

const TOOL = {
  name: 'websearch',
  description:
    'Search the web and return the top results with titles, URLs and snippets. ' +
    'Works without any API key. Use this for current facts, versions, documentation ' +
    'and anything you cannot read from the local filesystem.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for.' },
      limit: {
        type: 'integer',
        description: 'How many results to return (1-10, default 5).',
        minimum: 1,
        maximum: 10,
      },
    },
    required: ['query'],
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
        serverInfo: { name: 'synapse-search', version: '1.0.0' },
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
      const limit = Math.min(10, Math.max(1, Number(args.limit) || 5));
      try {
        const found = await webSearch(args.query, { limit });
        process.stderr.write(`search "${String(args.query).slice(0, 80)}" -> ${found.length} results\n`);
        return toolText(id, formatResults(found));
      } catch (err) {
        process.stderr.write(`search failed: ${err.message}\n`);
        return toolText(id, `Web search failed: ${err.message}`, true);
      }
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
process.stderr.write('synapse-search MCP ready\n');
