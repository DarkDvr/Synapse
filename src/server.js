// Local HTTP server: serves the web UI and the Synapse API, and relays the
// engine's live event stream to browser clients over SSE.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WEB_DIR } from './paths.js';
import { isLoopback, isPrivateAddress, parseCookies, tokenMatches, loginPage, REMOTE_COOKIE } from './remote.js';
import { createPresence } from './presence.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  // The panel grounds are photographs. Served as octet-stream they still often
  // paint, but Chrome is within its rights to refuse, and "usually" is not a
  // reason to leave a type out of a table that exists to hold types.
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// A message carries attachments as base64: 48 MB of files is about 64 MB of
// JSON, so the message route gets its own ceiling and every other route keeps
// the 2 MB the rest of the API was written against.
const MESSAGE_BODY_LIMIT = 70 * 1024 * 1024;

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        const err = new Error(`request body too large: ${(size / (1024 * 1024)).toFixed(1)} MB, the limit is ${Math.round(limit / (1024 * 1024))} MB`);
        err.status = 413;
        reject(err);
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve(null);
      try { resolve(JSON.parse(data)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

export function createServer({ api, engine, logger, config, remote, onRemote }) {
  const app = logger.channel('app');
  const sseClients = new Map(); // res -> view { id, address, name, local, since }
  const presence = createPresence({ logger });

  // One frame shape for every client: engine events and Synapse's own.
  const broadcast = (ev) => {
    if (sseClients.size === 0) return;
    let frame;
    try { frame = `data: ${JSON.stringify(ev)}\n\n`; } catch { return; }
    for (const res of sseClients.keys()) {
      try { res.write(frame); } catch { /* dropped client */ }
    }
  };

  /** The views list and the Settings lock, for every page at once. */
  const broadcastPresence = () => {
    broadcast({ kind: 'presence', views: presence.list(), lock: presence.holder(), ts: Date.now() });
  };

  /** Who is asking: the view's name, or the address when the page is unknown. */
  const actorOf = (req) => {
    const id = String(req.headers['x-client-id'] || '') || null;
    const view = id ? presence.byId(id) : null;
    if (view) return { id: view.id, name: view.name, local: view.local };
    const address = addressOf(req);
    return { id: null, name: isLoopback(address) ? presence.hostname : address, local: isLoopback(address) };
  };

  engine.on('event', broadcast);

  const sendJson = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  const addressOf = (req) => req.socket.remoteAddress || '';

  /** The login page, and the one place a token becomes a cookie. */
  function handleLogin(req, res, query) {
    const supplied = query?.get('token') || '';
    if (supplied && tokenMatches(supplied, remote?.token)) {
      res.writeHead(302, {
        'set-cookie': `${REMOTE_COOKIE}=${encodeURIComponent(remote.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
        location: '/',
      });
      res.end();
      return;
    }
    const html = loginPage({ error: supplied ? 'That token is not valid. Copy the link from the host PC and try again.' : '' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  }

  function denyRemote(res, message) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(message);
  }

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
      res.writeHead(200, {
        'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
        // The UI is served from disk while it is being worked on: a stylesheet
        // the browser kept from an earlier version produces a bug report about
        // code that no longer exists. Cheap here — the files are local.
        'cache-control': 'no-cache',
      });
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
      const view = presence.join({ id: crypto.randomUUID(), address: addressOf(req) });
      res.write(': connected\n\n');
      res.write(`data: ${JSON.stringify({
        kind: 'hello',
        clientId: view.id,
        you: { id: view.id, name: view.name, local: view.local },
        presence: { views: presence.list(), lock: presence.holder() },
        ts: Date.now(),
      })}\n\n`);
      sseClients.set(res, view);
      broadcastPresence();
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15000);
      ping.unref?.();
      req.on('close', () => {
        clearInterval(ping);
        sseClients.delete(res);
        const left = presence.leave(view.id);
        if (left.released) broadcast({ kind: 'settings-lock', holder: null, ts: Date.now() });
        broadcastPresence();
      });
      return;
    }

    // GET /api/status
    if (seg[0] === 'status' && method === 'GET') return sendJson(res, 200, await api.status());

    // GET /api/views — who is connected, and who is editing Settings. The page
    // asks once on load; live changes arrive as `presence` and `settings-lock`.
    if (seg[0] === 'views' && method === 'GET') {
      return sendJson(res, 200, presence.status(String(req.headers['x-client-id'] || '') || null));
    }

    // GET|POST /api/settings/lock — one view edits Settings at a time.
    if (seg[0] === 'settings' && seg[1] === 'lock') {
      const clientId = String(req.headers['x-client-id'] || '') || null;
      if (method === 'GET') return sendJson(res, 200, presence.status(clientId).lock || null);
      if (method === 'POST') {
        const body = await readBody(req);
        const action = body?.action === 'release' ? 'release' : 'acquire';
        if (action === 'release') {
          const released = presence.release(clientId);
          broadcast({ kind: 'settings-lock', holder: null, ts: Date.now() });
          return sendJson(res, 200, { ok: true, released });
        }
        const result = presence.acquire(clientId);
        if (!result.ok) {
          return sendJson(res, 409, {
            error: result.holder
              ? `Settings are open on ${result.holder.name}. Close them there first.`
              : result.error,
            holder: result.holder || null,
          });
        }
        broadcast({ kind: 'settings-lock', holder: presence.holder(), ts: Date.now() });
        return sendJson(res, 200, { ok: true, lock: result.holder });
      }
    }

    // GET /api/busy?session= — is this session's project working, and why.
    if (seg[0] === 'busy' && method === 'GET') {
      return sendJson(res, 200, await api.busy(query?.get('session') || null));
    }
    // GET|POST /api/remote — the STATUS > Remote Access switch. GET includes the
    // one-click link only for the host itself; a LAN client never receives it.
    if (seg[0] === 'remote' && seg.length === 1) {
      if (method === 'GET') return sendJson(res, 200, remote.status(isLoopback(addressOf(req))));
      if (method === 'POST') {
        const body = await readBody(req);
        const status = await onRemote(body?.enabled === true);
        // Before the listener moves and before this response: every other view
        // must learn the switch changed, including the one that clicked it.
        broadcast({ kind: 'remote', remote: status, by: actorOf(req).name, ts: Date.now() });
        // Answer first: the listener has to close the sockets before it can move
        // to the other interface, and this response must be on the wire by then.
        sendJson(res, 200, status);
        setTimeout(() => {
          relisten(remote.bindHost()).catch((err) => app.error(`remote access listener could not move: ${err.message}`));
        }, 150);
        return;
      }
    }
    // GET /api/toolchain — what this PC can build (Settings → Windows)
    if (seg[0] === 'toolchain' && method === 'GET') {
      return sendJson(res, 200, await api.toolchain({ force: query?.get('force') === '1' }));
    }
    // POST /api/restart — relaunch Synapse (Settings > Save Changes).
    if (seg[0] === 'restart' && method === 'POST') return sendJson(res, 200, await api.restart());
    // POST /api/shutdown — stop the server (tray > Stop Server). The app reads
    // exit code 0 as "stopped on purpose" and leaves the window open.
    if (seg[0] === 'shutdown' && method === 'POST') return sendJson(res, 200, await api.shutdown());
    // GET|PUT /api/config
    if (seg[0] === 'config') {
      if (method === 'GET') return sendJson(res, 200, await api.getConfig());
      if (method === 'PUT') return sendJson(res, 200, await api.saveConfig(await readBody(req)));
    }

    // The engine: is there a newer one, and do it.
    //   GET  /api/engine/update        what we already know (no network)
    //   POST /api/engine/update/check  ask npm (the operator's click)
    //   POST /api/engine/update        stop, install, start
    if (seg[0] === 'engine' && seg[1] === 'update') {
      if (seg.length === 2 && method === 'GET') return sendJson(res, 200, await api.engineUpdate());
      if (seg[2] === 'check' && method === 'POST') return sendJson(res, 200, await api.checkEngineUpdate());
      if (seg.length === 2 && method === 'POST') return sendJson(res, 200, await api.updateEngine());
    }

    // Synapse's own release. Same shape as the engine's: a cached status, an
    // on-demand check, and an update that stages the zip and closes the app.
    if (seg[0] === 'synapse' && seg[1] === 'update') {
      if (seg.length === 2 && method === 'GET') return sendJson(res, 200, await api.synapseUpdate());
      if (seg[2] === 'check' && method === 'POST') return sendJson(res, 200, await api.checkSynapseUpdate());
      if (seg.length === 2 && method === 'POST') return sendJson(res, 200, await api.updateSynapse());
    }

    // GET /api/models  /api/agents  /api/skills
    // GET /api/providers/health — which local servers are answering right now
    // (the sidebar's Local LLM row), and no cached claim is given when none is up.
    if (seg[0] === 'providers' && seg[1] === 'health' && method === 'GET') {
      return sendJson(res, 200, await api.providerHealth());
    }
    // POST /api/providers/models — ask a provider what it serves (Settings >
    // Providers > Refresh List); it is the only provider call outside a turn.
    if (seg[0] === 'providers' && seg[1] === 'models' && method === 'POST') {
      return sendJson(res, 200, await api.providerModels(await readBody(req)));
    }
    if (seg[0] === 'models' && seg.length === 1 && method === 'GET') return sendJson(res, 200, await api.models());
    if (seg[0] === 'skills' && seg.length === 1 && method === 'GET') return sendJson(res, 200, await api.skills());
    if (seg[0] === 'models' && seg[1] === 'cache' && method === 'GET') return sendJson(res, 200, await api.modelCache());
    if (seg[0] === 'models' && seg[1] === 'issues' && seg[2] === 'clear' && method === 'POST') {
      return sendJson(res, 200, await api.clearModelIssues(await readBody(req)));
    }
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

    // GET /api/permissions?session= — decisions for the permission chip. A page
    // opened after the fact asks here; live ones arrive on the stream.
    if (seg[0] === 'permissions' && seg.length === 1 && method === 'GET') {
      return sendJson(res, 200, await api.permissionDecisions(query?.get('session') || null));
    }

    // GET /api/runs — delegated work in flight (the live path + role cards)
    if (seg[0] === 'runs' && method === 'GET') return sendJson(res, 200, await api.runs());
    if (seg[0] === 'runs' && seg[1] === 'cancel' && method === 'POST') {
      return sendJson(res, 200, await api.cancelRun(await readBody(req)));
    }
    // POST /api/runs/resume — the operator fixed what was refused; a stopped
    // project may take tasks again. Called after a role's model is changed.
    if (seg[0] === 'runs' && seg[1] === 'resume' && method === 'POST') {
      return sendJson(res, 200, await api.resumeRuns(await readBody(req)));
    }

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
      if (seg.length === 2 && seg[1] === 'inspect' && method === 'POST') {
        return sendJson(res, 200, await api.inspectProjectDir(await readBody(req)));
      }
      if (seg.length === 2 && seg[1] === 'wipe' && method === 'POST') {
        return sendJson(res, 200, await api.wipeProjectDir(await readBody(req)));
      }
      const projectId = decodeURIComponent(seg[1] || '');
      if (seg.length === 2 && method === 'PATCH') return sendJson(res, 200, await api.updateProject(projectId, await readBody(req)));
      // What the delete dialog has to show before it asks: the folder, and whether
      // there are deliverables in `bin\` that need their own consent.
      if (seg[2] === 'delete-info' && method === 'GET') return sendJson(res, 200, await api.projectDeleteInfo(projectId));
      if (seg.length === 2 && method === 'DELETE') {
        return sendJson(res, 200, await api.deleteProject(projectId, await readBody(req)));
      }
      if (seg[2] === 'open' && method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 200, await api.openProject(projectId, body?.what === 'cmd' ? 'cmd' : 'browse'));
      }
    }

    // /api/sessions... — the engine's word for a chat. The only creation route
    // left is "make this project's chat"; renaming and deleting a chat are gone
    // with the session list (a project's chat is the project).
    if (seg[0] === 'sessions') {
      if (seg.length === 1 && method === 'POST') return sendJson(res, 200, await api.createSession(await readBody(req)));
      const sessionId = decodeURIComponent(seg[1] || '');
      if (seg[2] === 'model' && method === 'POST') return sendJson(res, 200, await api.switchModel(sessionId, await readBody(req)));
      if (seg[2] === 'messages' && method === 'GET') return sendJson(res, 200, await api.messages(sessionId));
      if (seg[2] === 'plan' && method === 'GET') return sendJson(res, 200, await api.plan(sessionId));
      if (seg[2] === 'auto' && method === 'POST') return sendJson(res, 200, await api.setAuto(sessionId, await readBody(req)));
      // "Full auto": unanswered asks and questions take the default after the
      // wait in Settings → Workers (20 seconds by default).
      if (seg[2] === 'full-auto' && method === 'POST') {
        return sendJson(res, 200, await api.setFullAuto(sessionId, await readBody(req)));
      }
      // A message can carry attachments, which travel as base64 — 8 MB of file is
      // 11 MB of JSON. Measured 25 Oct: an ordinary screenshot was refused with
      // "request body too large" and the operator saw a toast that vanished.
      if (seg[2] === 'messages' && method === 'POST') {
        return sendJson(res, 200, await api.sendMessage(sessionId, await readBody(req, MESSAGE_BODY_LIMIT), actorOf(req)));
      }
      // POST /api/sessions/{id}/steer — guidance into work already running. The
      // engine reads it at the next step boundary; Stop is still the hard stop.
      if (seg[2] === 'steer' && method === 'POST') {
        return sendJson(res, 200, await api.steer(sessionId, await readBody(req, MESSAGE_BODY_LIMIT), actorOf(req)));
      }
      if (seg[2] === 'interrupt' && method === 'POST') return sendJson(res, 200, await api.interrupt(sessionId));
      // POST /api/sessions/{id}/compact — discard the conversation, leave a
      // handover, start a fresh one. Slow by nature (the engine summarises), so
      // the client shows "Compacting…" and this answer arrives when it is done.
      if (seg[2] === 'compact' && method === 'POST') {
        return sendJson(res, 200, await api.compactSession(sessionId));
      }
      if (seg[2] === 'permission' && method === 'POST') {
        return sendJson(res, 200, await api.permission(sessionId, await readBody(req), actorOf(req)));
      }
      if (seg[2] === 'forms' && seg[4] === 'reply' && method === 'POST') {
        return sendJson(res, 200, await api.replyForm(sessionId, decodeURIComponent(seg[3] || ''), await readBody(req), actorOf(req)));
      }
    }

    sendJson(res, 404, { error: `No route for ${method} ${pathname}` });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const address = addressOf(req);
    try {
      // The login page is the only thing a remote browser may see before it has
      // the token. Everything else — API and static UI alike — needs the cookie.
      if (pathname === '/login') return handleLogin(req, res, url.searchParams);
      if (!isLoopback(address)) {
        if (!remote?.enabled()) return denyRemote(res, 'Remote access is off on this PC.');
        if (!isPrivateAddress(address)) return denyRemote(res, 'Remote access is limited to the local network.');
        const cookies = parseCookies(req.headers.cookie);
        if (!tokenMatches(cookies[REMOTE_COOKIE], remote.token)) {
          if (pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'remote access requires the link from the host PC' });
          res.writeHead(302, { location: '/login' });
          return res.end();
        }
      }
      if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, url.searchParams);
      return serveStatic(res, pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) app.error(`${req.method} ${pathname}: ${err.message}`);
      if (!res.headersSent) sendJson(res, status, { error: err.message, ...(err.busy ? { busy: err.busy } : {}) });
      else res.end();
    }
  });

  const listen = (host) => new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('error', onError);
      reject(err);
    };
    server.once('error', onError);
    server.listen(config.server.port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  /**
   * Move the listener between loopback and the LAN. Closing the old server would
   * otherwise wait for the SSE connections, which never end on their own, so the
   * sockets are closed first; browsers reconnect. The API answers before this is
   * called, so the switch's own response is already delivered.
   */
  const relisten = async (host) => {
    if (!server.listening) return listen(host);
    await new Promise((resolve) => {
      server.close(() => resolve());
      try { server.closeAllConnections?.(); } catch { /* Node without it: close still runs */ }
    });
    return listen(host);
  };

  return {
    server,
    broadcast,
    listen,
    relisten,
    close: () => new Promise((resolve) => {
      for (const res of sseClients.keys()) { try { res.end(); } catch { /* ignore */ } }
      sseClients.clear();
      try { server.closeAllConnections?.(); } catch { /* ignore */ }
      server.close(() => resolve());
    }),
  };
}
