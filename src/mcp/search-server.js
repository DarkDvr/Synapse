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
import { webFetch, formatPage } from '../fetch.js';
import { readSessions } from '../site-sessions.js';

const PROTOCOL_VERSION = '2024-11-05';

const TOOL = {
  name: 'websearch',
  description:
    'Search the web and return the top results with titles, URLs and snippets. ' +
    'Works without any API key. Use this for current facts, versions, documentation ' +
    'and anything you cannot read from the local filesystem. Follow up with webfetch ' +
    'on a result that matters.',
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

const FETCH_TOOL = {
  name: 'webfetch',
  description:
    'Read one web page as clean text: the article or README, not the site around it. ' +
    'Prefer this over fetching raw HTML yourself. GitHub repositories, issues, pull requests ' +
    'and file links are read through GitHub itself, and X/Twitter posts through oEmbed, so ' +
    'those come back exact. Some sites (Reddit, x.com, login-only forums) refuse anonymous ' +
    'readers; the error says which wall was hit, so you can tell the operator instead of guessing.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The page to read. A bare domain is treated as https.' },
      maxChars: {
        type: 'integer',
        description: 'How much text to return (2000-60000, default 14000).',
        minimum: 2000,
        maximum: 60000,
      },
    },
    required: ['url'],
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
      return result(id, { tools: [TOOL, FETCH_TOOL] });

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      if (name === FETCH_TOOL.name) {
        const maxChars = Math.min(60000, Math.max(2000, Number(args.maxChars) || 14000));
        try {
          // The operator's saved sessions: only the entry for this host is sent, and
          // it is never logged (src/site-sessions.js owns both rules).
          const page = await webFetch(args.url, { maxChars, sessions: readSessions() });
          process.stderr.write(`fetch ${String(args.url).slice(0, 100)} -> ${page.source}, ${page.chars} chars\n`);
          return toolText(id, formatPage(page));
        } catch (err) {
          process.stderr.write(`fetch failed: ${err.message}\n`);
          return toolText(id, `Could not read ${args.url}: ${err.message}`, true);
        }
      }
      if (name !== TOOL.name) return toolText(id, `Unknown tool: ${name}`, true);
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
