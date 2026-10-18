// Local HTTP server: serves the web UI and the Synapse API, and relays the
// engine's live event stream to browser clients over SSE.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WEB_DIR } from './paths.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { req.destroy(); reject(new Error('request body too large')); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve(null);
      try { resolve(JSON.parse(data)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

export function createServer({ api, engine, logger, config }) {
  const app = logger.channel('app');
  const sseClients = new Set();

  // One frame shape for every client: engine events and Synapse's own.
  const broadcast = (ev) => {
    if (sseClients.size === 0) return;
    let frame;
    try { frame = `data: ${JSON.stringify(ev)}\n\n`; } catch { return; }
    for (const res of sseClients) {
      try { res.write(frame); } catch { /* dropped client */ }
    }
  };

  engine.on('event', broadcast);

  const sendJson = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  function serveStatic(res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const filePath = path.join(WEB_DIR, rel);
    if (!filePath.startsWith(WEB_DIR)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  }

  async function handleApi(req, res, pathname, query) {
    const { method } = req;
    const seg = pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);

    // GET /api/stream
    if (seg[0] === 'stream' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');
      res.write(`data: ${JSON.stringify({ kind: 'hello', ts: Date.now() })}\n\n`);
      sseClients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15000);
      ping.unref?.();
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }

    // GET /api/status
    if (seg[0] === 'status' && method === 'GET') return sendJson(res, 200, await api.status());
    // GET|PUT /api/config
    if (seg[0] === 'config') {
      if (method === 'GET') return sendJson(res, 200, await api.getConfig());
      if (method === 'PUT') return sendJson(res, 200, await api.saveConfig(await readBody(req)));
    }

    // GET /api/models  /api/agents
    if (seg[0] === 'models' && seg.length === 1 && method === 'GET') return sendJson(res, 200, await api.models());
    if (seg[0] === 'models' && seg[1] === 'cache' && method === 'GET') return sendJson(res, 200, await api.modelCache());
    if (seg[0] === 'models' && seg[1] === 'reset-asks' && method === 'POST') return sendJson(res, 200, await api.resetModelAsks());
    if (seg[0] === 'models' && seg[1] === 'inspect' && method === 'POST') {
      return sendJson(res, 200, await api.inspectModel(await readBody(req)));
    }
    if (seg[0] === 'agents' && method === 'GET') return sendJson(res, 200, await api.agents());

    // GET /api/pending — permissions, forms and active sessions in one call.
    // `?session=` asks for that session's own forms as well, so the question
    // panel knows what the open session is waiting on.
    if (seg[0] === 'pending' && method === 'GET') {
      return sendJson(res, 200, await api.pending(query?.get('session') || null));
    }

    // GET /api/runs — delegated work in flight (the live path + role cards)
    if (seg[0] === 'runs' && method === 'GET') return sendJson(res, 200, await api.runs());

    // GET /api/tools/stats — the tool-call census · POST /api/tools/reset — clear it
    if (seg[0] === 'tools' && seg[1] === 'stats' && method === 'GET') return sendJson(res, 200, await api.toolStats());
    if (seg[0] === 'tools' && seg[1] === 'reset' && method === 'POST') return sendJson(res, 200, await api.clearToolStats());

    // GET /api/tools/probe — case list + last run · POST /api/tools/probe/run
    if (seg[0] === 'tools' && seg[1] === 'probe' && seg[2] === 'run' && method === 'POST') {
      return sendJson(res, 200, await api.runProbe());
    }
    if (seg[0] === 'tools' && seg[1] === 'probe' && method === 'GET') return sendJson(res, 200, await api.probe());

    // /api/projects...
    if (seg[0] === 'projects') {
      if (seg.length === 1 && method === 'GET') return sendJson(res, 200, await api.projects());
      if (seg.length === 1 && method === 'POST') return sendJson(res, 200, await api.createProject(await readBody(req)));
      const projectId = decodeURIComponent(seg[1] || '');
      if (seg.length === 2 && method === 'PATCH') return sendJson(res, 200, await api.updateProject(projectId, await readBody(req)));
      if (seg.length === 2 && method === 'DELETE') return sendJson(res, 200, await api.deleteProject(projectId));
      if (seg[2] === 'open' && method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 200, await api.openProject(projectId, body?.what === 'cmd' ? 'cmd' : 'browse'));
      }
    }

    // /api/sessions...
    if (seg[0] === 'sessions') {
      if (seg.length === 1 && method === 'GET') return sendJson(res, 200, await api.sessions());
      if (seg.length === 1 && method === 'POST') return sendJson(res, 200, await api.createSession(await readBody(req)));
      const sessionId = decodeURIComponent(seg[1] || '');
      if (seg.length === 2 && method === 'PATCH') return sendJson(res, 200, await api.updateSession(sessionId, await readBody(req)));
      if (seg.length === 2 && method === 'DELETE') return sendJson(res, 200, await api.deleteSession(sessionId));
      if (seg[2] === 'model' && method === 'POST') return sendJson(res, 200, await api.switchModel(sessionId, await readBody(req)));
      if (seg[2] === 'messages' && method === 'GET') return sendJson(res, 200, await api.messages(sessionId));
      if (seg[2] === 'plan' && method === 'GET') return sendJson(res, 200, await api.plan(sessionId));
      if (seg[2] === 'auto' && method === 'POST') return sendJson(res, 200, await api.setAuto(sessionId, await readBody(req)));
      if (seg[2] === 'messages' && method === 'POST') return sendJson(res, 200, await api.sendMessage(sessionId, await readBody(req)));
      if (seg[2] === 'interrupt' && method === 'POST') return sendJson(res, 200, await api.interrupt(sessionId));
      if (seg[2] === 'permission' && method === 'POST') return sendJson(res, 200, await api.permission(sessionId, await readBody(req)));
      if (seg[2] === 'forms' && seg[4] === 'reply' && method === 'POST') {
        return sendJson(res, 200, await api.replyForm(sessionId, decodeURIComponent(seg[3] || ''), await readBody(req)));
      }
    }

    sendJson(res, 404, { error: `No route for ${method} ${pathname}` });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    try {
      if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, url.searchParams);
      return serveStatic(res, pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) app.error(`${req.method} ${pathname}: ${err.message}`);
      if (!res.headersSent) sendJson(res, status, { error: err.message });
      else res.end();
    }
  });

  return {
    server,
    broadcast,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.server.port, config.server.host, () => resolve());
    }),
    close: () => new Promise((resolve) => {
      for (const res of sseClients) { try { res.end(); } catch { /* ignore */ } }
      sseClients.clear();
      server.close(() => resolve());
    }),
  };
}
