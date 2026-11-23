// The Chrome DevTools Protocol client, with no dependencies.
//
// Node ships `WebSocket`, and Chromium speaks CDP over it. This is the same client
// skills/visual-review/bin/shot.mjs has been using to render pages since the beginning,
// lifted out so the renderer and the browser share one implementation of the protocol
// rather than two that drift.
//
// The shape is deliberately small: numbered requests, one event queue, and helpers for
// the three things a caller always needs — evaluate, wait for an event, take a picture.
import fs from 'node:fs';
import path from 'node:path';

/** The port a running Chromium wrote into its profile, or null. */
export function readPort(profileDir) {
  try {
    const raw = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/);
    const port = Number(raw[0]);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    // No port file yet: the browser writes it after its first window.
    return null;
  }
}

/** Wait until a port appears (the browser writes it after its first window). */
export async function waitForPort(profileDir, { timeoutMs = 30000, everyMs = 200 } = {}) {
  const at = Date.now();
  while (Date.now() - at < timeoutMs) {
    const port = readPort(profileDir);
    if (port) {
      // A port file can name a listener that has already closed (a crashed instance).
      try {
        await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        return port;
      } catch { /* still starting, or stale */ }
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return null;
}

/** The page targets the browser is willing to hand over. */
export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

/**
 * Attach to one websocket and answer the small client both a page and the browser use.
 *
 * The browser endpoint is a different target from a page: `Browser.download*` events and
 * `Browser.setDownloadBehavior` only exist there. Everything else — numbered requests, the
 * event queue, evaluate, screenshot — is the same protocol.
 */
async function clientFor(wsUrl, target = null) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('could not attach to the browser'));
  });

  let seq = 0;
  const pending = new Map();
  const events = [];
  const listeners = new Set();
  ws.onmessage = (m) => {
    let msg;
    try { msg = JSON.parse(m.data); } catch { return; /* a malformed frame is not ours */ }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || 'the browser refused the call'));
      else resolve(msg.result);
      return;
    }
    events.push(msg);
    if (events.length > 400) events.splice(0, 200);
    // A download's progress arrives as events, not as answers: a queue that is only
    // polled cannot tell begin from progress from done without losing one.
    for (const fn of listeners) {
      try { fn(msg); } catch { /* a listener must not take the protocol down */ }
    }
  };

  // Every request answers or fails in this long. Without it a half-open socket — the
  // operator closed the window between two tool calls — made `read` wait for ever: the
  // tool never returned, the model never spoke, and the run sat there until it was
  // stopped (11 Nov, twice, seven minutes each).
  const SEND_TIMEOUT_MS = 60000;
  const send = (method, params = {}, timeoutMs = SEND_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`the browser did not answer ${method} in ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });

  const waitEvent = async (method, timeoutMs = 20000) => {
    const at = Date.now();
    for (;;) {
      const hit = events.findIndex((e) => e.method === method);
      if (hit >= 0) return events.splice(hit, 1)[0].params;
      if (Date.now() - at > timeoutMs) return null;
      await new Promise((r) => setTimeout(r, 40));
    }
  };

  /** Every protocol event, as it arrives. Returns a function that unsubscribes. */
  const onEvent = (fn) => {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  /** Evaluate an expression in the page and return its value. */
  const evaluate = async (expression, { awaitPromise = true, timeoutMs } = {}) => {
    const { result } = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    }, timeoutMs);
    if (result?.subtype === 'error') throw new Error(result.description || 'the page threw');
    return result?.value;
  };

  /**
   * A PNG of the page, viewport or whole.
   *
   * `captureBeyondViewport` on its own still returns the viewport — measured 16 Nov: a
   * page 888 px tall came back 1280x800. The whole page needs a clip the size of its
   * content, which is what `Page.getLayoutMetrics` reports.
   */
  const screenshot = async ({ full = false } = {}) => {
    const params = { format: 'png' };
    if (full) {
      params.captureBeyondViewport = true;
      params.fromSurface = true;
      try {
        const metrics = await send('Page.getLayoutMetrics');
        const size = metrics?.cssContentSize || metrics?.contentSize || null;
        if (size?.width && size?.height) {
          params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
        }
      } catch {
        // No metrics means the viewport is what we can give; the caller sees the size.
      }
    }
    const shot = await send('Page.captureScreenshot', params);
    return Buffer.from(shot.data, 'base64');
  };

  const close = () => {
    listeners.clear();
    try { ws.close(); } catch { /* already gone */ }
  };

  return { target, send, waitEvent, onEvent, evaluate, screenshot, close };
}

/** Connect to one page target, by address or by the id a new tab was given. */
export async function connect(port, { preferUrl = null, targetId = null } = {}) {
  const targets = (await listTargets(port)).filter((t) => t.type === 'page');
  const target = targetId
    ? targets.find((t) => t.id === targetId)
    : (preferUrl && targets.find((t) => t.url.includes(preferUrl))) || targets[0];
  if (!target?.webSocketDebuggerUrl) throw new Error('the browser has no page to drive');
  return clientFor(target.webSocketDebuggerUrl, target);
}

/**
 * Connect to the browser itself, not a page.
 *
 * Downloads are browser-scoped: their events are emitted on `/json/version`'s websocket,
 * and `Browser.setDownloadBehavior` is accepted only there. The page connection cannot
 * see them, which is why this is a second client rather than another flag on `connect`.
 */
export async function connectBrowser(port) {
  const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  if (!info?.webSocketDebuggerUrl) throw new Error('the browser has no debugging endpoint');
  return clientFor(info.webSocketDebuggerUrl, null);
}
