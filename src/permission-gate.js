// Answering the engine's permission requests from the policy.
//
// The engine blocks a tool and raises `permission.asked`. This turns that event
// into one of three outcomes: allow (reply `once`), deny (reply `reject`), or
// leave it — the operator's card. The policy is in permissions.js; this file is
// only the plumbing: which session asked, from which directory, and what to tell
// the engine.
//
// `once` is deliberate even for an allow. `always` writes a rule into the session
// that bypasses the policy for the rest of the run; the next identical call must
// be judged again, which is the point of having a policy.
//
// A session whose directory is not known is left to the operator. Guessing a
// working directory would judge the request against the wrong zone, and a wrong
// allow is worse than a prompt.
import os from 'node:os';
import { decide, grantKey, resolvePath, refusalNote } from './permissions.js';

export function createPermissionGate({
  engine,
  logger,
  root,
  home = os.homedir(),
  scratchRoot = null,
  onDecision,
  memory,
  // How long an unanswered card waits before it is allowed once. Tests pass a
  // few milliseconds; the product reads `fullAuto.timeoutSec` (20 seconds by
  // default). `getTimeoutMs` wins when present so a Settings change applies to
  // the next ask without a restart. Zero is valid: no card is shown at all.
  permissionTimeoutMs = 20_000,
  getTimeoutMs = null,
}) {
  const log = logger.channel('app');
  // sessionId -> { directory, role, task, title }. The directory never changes
  // for a session's life; the role and task make the console line readable.
  const sessions = new Map();
  // Requests left to the operator, and whether their session wants them answered
  // automatically. Every ask is held here, not only the ones whose switch is on,
  // so flipping the switch arms a card that is already on screen.
  const pendingAsks = new Map(); // requestId -> { request, info, entry, timer }
  // Requests the gate is judging right now. The engine lists a request as pending
  // the moment it raises it, and the page polls that list — so a request the
  // policy is about to answer itself (a write inside the project) would reach the
  // page as a card for one poll and vanish on the next. That flash is what "a
  // bunch of permissions appear and disappear" looked like in a run where every
  // call was allowed (30 Oct); `GET /api/pending` skips these ids.
  const answering = new Set();
  const fullAutoOn = new Set();
  // Full auto is the chat's standing decision, not the session's: a worker asking
  // for a shell command belongs to the same project as the Architect whose switch
  // the operator turned on. `true`/`false` here is the explicit answer for that
  // project and beats a worker's saved metadata; no entry means "ask the session".
  const fullAutoDirs = new Map();

  /** The wait, read each time so a Settings change applies to the next ask.
   *  Zero is a real value: answer at once, with no card. */
  const waitMs = () => {
    const fallback = Number.isFinite(Number(permissionTimeoutMs)) ? Math.max(0, Number(permissionTimeoutMs)) : 20_000;
    if (!getTimeoutMs) return fallback;
    const ms = Number(getTimeoutMs());
    // A missing or broken setting must not silently become "allow at once".
    return Number.isFinite(ms) ? Math.max(0, ms) : fallback;
  };
  // Tool calls this session announced, newest last. The engine sends
  // `source:{id}` on some permission asks (edit, read) but not on shell asks —
  // measured 28 Oct on 2.1.2: the shell event has id, sessionID, action,
  // resources and save, and no source at all. The chip is keyed by the tool
  // call's own id, so a shell ask without this fallback could never draw one.
  // The ask always follows the call it belongs to, and a call blocks until it is
  // answered, so the newest unclaimed call of the same family is the right one.
  const recentTools = new Map(); // sessionId -> [{ id, name, input, at }]
  const claimedTools = new Set(); // `${sessionId}\0${toolCallId}`
  const TOOL_MEMORY_MS = 120_000;
  const TOOL_MEMORY_MAX = 24;

  // "Always Allow" means this exact request again in this session, decided by the
  // operator. It is deliberately not the engine's own `always`: that saves the
  // request's `save` patterns for the whole project, and for an edit those
  // patterns are `*` — one click would let the AI edit anything, including
  // Synapse. The real memory is on disk (`permission-memory.js`); the fallback
  // keeps the gate usable on its own, e.g. in tests.
  const fallback = new Set();
  const memoryKey = (sessionId, action, resources) =>
    `${String(sessionId || '')}\u0000${String(action || '').toLowerCase()}\u0000${(resources || [])
      .map(String)
      .join('\u0001')}`;

  /** Remember one request for this session. Only the operator's answer reaches
   *  here; the gate itself never widens what it may do. What "the request" is
   *  comes from `grantKey`: a path for a file action, the executable and the
   *  files it names for a shell command — so the same script with a different
   *  tail does not ask again, and a different file still does. */
  function remember(sessionId, action, resources) {
    if (!sessionId) return false;
    const dir = sessions.get(sessionId)?.directory || root;
    const grant = grantKey({ action, resources, cwd: dir, projectRoot: dir, harnessRoot: root, home });
    if (memory) return Boolean(memory.remember(sessionId, action, grant));
    fallback.add(memoryKey(sessionId, action, grant));
    return true;
  }

  const wasRemembered = (sessionId, action, resources) =>
    memory
      ? Boolean(memory.has(sessionId, action, resources))
      : fallback.has(memoryKey(sessionId, action, resources));

  /** The request inside an engine event, whatever envelope it arrived in. */
  function requestOf(ev) {
    const raw = ev?.raw || {};
    const data = raw.data || raw.properties || raw;
    const req = data.request || data;
    return {
      requestId: data.requestID || data.id || req.requestID || req.id || null,
      sessionId: req.sessionID || data.sessionID || ev?.sessionId || null,
      action: String(req.action || req.title || '').trim(),
      resources: Array.isArray(req.resources) ? req.resources : [],
      // The tool call this request belongs to, for the chip on its card. Some
      // asks carry it; a shell ask on 2.1.2 does not, which is why `observe`
      // keeps the calls and `inferToolCall` fills it in.
      toolCallId: req.source?.id || null,
    };
  }

  const same = (a) => String(a || '').replace(/\\/g, '/').replace(/\s+/g, ' ').trim().toLowerCase();
  const toolFamily = (name) => {
    const n = String(name || '').toLowerCase();
    if (/^(edit|write|patch|create|multiedit|apply_patch)$/.test(n)) return 'write';
    if (/^(shell|bash|execute|run|terminal)$/.test(n)) return 'shell';
    if (n === 'read') return 'read';
    return n;
  };
  const actionFamily = (action) => {
    const a = String(action || '').toLowerCase();
    if (/^(edit|write|patch|create|multiedit)$/.test(a)) return 'write';
    if (/^(shell|bash|execute|run)$/.test(a)) return 'shell';
    if (a === 'read') return 'read';
    return a;
  };

  /** Remember the tool calls the session announces, so an ask without a source
   *  can still be pinned to the call it is blocking. */
  function observe(ev) {
    const type = String(ev?.type || '');
    if (!/^session\.tool\.(input\.started|input\.ended|called)$/.test(type)) return;
    const data = ev?.raw?.data || {};
    const sessionId = data.sessionID || ev?.sessionId || null;
    const id = data.id || data.callID || null;
    if (!sessionId || !id) return;
    let list = recentTools.get(sessionId);
    if (!list) {
      list = [];
      recentTools.set(sessionId, list);
    }
    let entry = list.find((x) => x.id === id);
    if (!entry) {
      entry = { id, name: '', input: null, at: Date.now() };
      list.push(entry);
    }
    if (data.name) entry.name = data.name;
    if (data.input && typeof data.input === 'object') entry.input = data.input;
    // `input.ended` carries the model's JSON as text; parsing it here means a
    // call is matchable even if `session.tool.called` never arrives.
    if (typeof data.text === 'string' && !entry.input) {
      try {
        const parsed = JSON.parse(data.text);
        if (parsed && typeof parsed === 'object') entry.input = parsed;
      } catch { /* a fragment, not a complete input; `called` will carry it */ }
    }
    entry.at = Date.now();
    if (list.length > TOOL_MEMORY_MAX) list.splice(0, list.length - TOOL_MEMORY_MAX);
  }

  /** How strongly a remembered tool call matches the ask's resources. */
  function matchScore(tool, resources) {
    const input = tool?.input && typeof tool.input === 'object' ? tool.input : {};
    const command = same(input.command || input.cmd || input.script || input.code || '');
    const path = same(input.filePath || input.path || input.file || input.file_path || '');
    let score = 0;
    for (const raw of resources || []) {
      const value = same(raw);
      if (!value) continue;
      if (command && command.includes(value)) score += 3;
      else if (command && value.includes(command)) score += 1;
      if (path && (path.endsWith(value) || value.endsWith(path))) score += 3;
    }
    return score;
  }

  /** The call an ask belongs to when the engine omitted `source`. */
  function inferToolCall(request) {
    const list = (recentTools.get(request.sessionId) || []).filter(
      (tool) => Date.now() - tool.at <= TOOL_MEMORY_MS,
    );
    if (!list.length) return null;
    const family = actionFamily(request.action);
    const candidates = list.filter(
      (tool) => !claimedTools.has(`${request.sessionId}\u0000${tool.id}`) && toolFamily(tool.name) === family,
    );
    if (!candidates.length) return null;
    let best = candidates[0];
    let bestScore = matchScore(best, request.resources);
    for (const tool of candidates.slice(1)) {
      const score = matchScore(tool, request.resources);
      // A resource match outranks recency; with none, the newest call wins.
      if (score > bestScore || (score === bestScore && tool.at >= best.at)) {
        best = tool;
        bestScore = score;
      }
    }
    return best.id;
  }

  async function sessionOf(sessionId, directory) {
    const cached = sessions.get(sessionId);
    if (cached) {
      if (directory && cached.directory !== directory) cached.directory = directory;
      return cached;
    }
    let raw = null;
    try {
      raw = await engine.getSession(sessionId);
    } catch { /* the engine may have moved on; the event's directory may still do */ }
    const info = {
      directory: raw?.directory || directory || null,
      role: raw?.metadata?.synapse?.role || null,
      task: raw?.metadata?.synapse?.task || null,
      title: raw?.title || null,
      // Set on the session, so it survives a restart: an ask that arrives before
      // the operator's window has said anything about the switch still honours it.
      // `permissionTimeout` is the old name.
      fullAuto:
        raw?.metadata?.synapse?.fullAuto === true || raw?.metadata?.synapse?.permissionTimeout === true,
    };
    if (info.directory) sessions.set(sessionId, info);
    return info;
  }

  const dirKey = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const fullAutoEnabled = (sessionId, info) => {
    if (fullAutoOn.has(sessionId)) return true;
    if (info?.directory) {
      const chosen = fullAutoDirs.get(dirKey(info.directory));
      if (chosen !== undefined) return chosen;
    }
    return info?.fullAuto === true;
  };

  /** Arm a pending ask, if its session wants the timeout. A zero wait is not a
   *  timeout at all: the ask is answered on the next microtask, before a card can
   *  be painted. */
  function arm(p) {
    if (p.timer || p.queued || !fullAutoEnabled(p.request.sessionId, p.info)) return;
    const wait = waitMs();
    p.wait = wait;
    if (!wait) {
      p.queued = true;
      queueMicrotask(() => {
        p.queued = false;
        fire(p);
      });
      return;
    }
    p.timer = setTimeout(() => fire(p), wait);
    p.timer.unref?.();
  }

  async function fire(p) {
    if (!pendingAsks.has(p.request.requestId)) return;
    // The switch may have been turned off during the wait: then the card is the
    // operator's again, and nothing is answered behind their back.
    if (!fullAutoEnabled(p.request.sessionId, p.info)) {
      if (p.timer) clearTimeout(p.timer);
      p.timer = null;
      return;
    }
    const wait = waitMs();
    pendingAsks.delete(p.request.requestId);
    try {
      await engine.replyPermission(p.request.sessionId, p.request.requestId, 'once');
      const where = [p.info.role, p.info.task].filter(Boolean).join(' ');
      onDecision?.({
        ...p.entry,
        effect: 'allow',
        // A zero wait never put a card in front of the operator; a timed-out
        // one did. The chip is green for the first and amber for the second.
        asked: wait > 0,
        decided: true,
        decidedBy: wait > 0 ? 'timeout' : 'full-auto',
        reason:
          wait > 0
            ? `No answer within ${Math.round(wait / 1000)} seconds — allowed once.`
            : 'Full auto answers immediately — allowed once.',
      });
      log.info(
        wait > 0
          ? `permission timed out${where ? ` (${where})` : ''}: ${p.request.action || 'tool call'} — no answer, allowed once`
          : `permission allowed immediately${where ? ` (${where})` : ''}: ${p.request.action || 'tool call'} — full auto, no card`,
      );
    } catch (err) {
      // The request stays pending when the reply fails, so the operator still
      // sees the card. That is the safe way for this to break.
      pendingAsks.set(p.request.requestId, p);
      p.timer = null;
      log.warn(`could not answer a ${wait > 0 ? 'timed-out' : 'full-auto'} ${p.request.action || 'tool'} request: ${err.message}`);
    }
  }

  /**
   * Turn the timeout on or off for a session. An open card follows immediately:
   * on arms it, off disarms it. Called by the API when the menu is toggled; a
   * session's saved metadata is honoured on its own at the first ask.
   */
  function setFullAuto(sessionId, on, directory = '') {
    if (!sessionId && !directory) return false;
    const key = dirKey(directory || sessions.get(sessionId)?.directory || '');
    if (on) {
      if (sessionId) fullAutoOn.add(sessionId);
      if (key) fullAutoDirs.set(key, true);
    } else {
      if (sessionId) fullAutoOn.delete(sessionId);
      if (key) fullAutoDirs.set(key, false);
    }
    for (const p of pendingAsks.values()) {
      const sameProject = key && dirKey(p.info?.directory) === key;
      if (p.request.sessionId !== sessionId && !sameProject) continue;
      if (on) arm(p);
      else if (p.timer) {
        clearTimeout(p.timer);
        p.timer = null;
      }
    }
    return true;
  }

  /** The operator (or another view) answered a card: the timer must not fire. */
  function answered(requestId) {
    const p = pendingAsks.get(requestId);
    if (!p) return false;
    if (p.timer) clearTimeout(p.timer);
    pendingAsks.delete(requestId);
    return true;
  }

  /** Settings changed the wait while cards were open: re-arm them on the new
   *  number, including a new zero, which answers them at once. */
  function retime() {
    const next = waitMs();
    for (const p of pendingAsks.values()) {
      // An unrelated Settings save must not give a card that has already waited
      // another full wait; only a changed wait moves it.
      if (p.wait === next && (p.timer || p.queued)) continue;
      if (p.timer) clearTimeout(p.timer);
      p.timer = null;
      p.queued = false;
      arm(p);
    }
    return pendingAsks.size;
  }

  const shown = (request) => {
    const text = request.resources.map((r) => String(r || '')).join(' ').replace(/\s+/g, ' ').trim();
    return text.length > 160 ? `${text.slice(0, 157)}…` : text;
  };

  async function answer(request, directory) {
    answering.add(request.requestId);
    try {
    const info = await sessionOf(request.sessionId, directory);
    if (!info.directory) {
      log.info(`permission left to the operator (${request.action || 'tool call'}) — the session directory is not known yet`);
      return null;
    }
    const verdict = decide({
      action: request.action,
      resources: request.resources,
      cwd: info.directory,
      projectRoot: info.directory,
      harnessRoot: root,
      scratchRoot,
      home,
    });
    const who = [info.role, info.task].filter(Boolean).join(' ');
    const what = shown(request);
    const isPath = /^(edit|write|read|patch|create)$/i.test(request.action);
    const entry = {
      requestId: request.requestId,
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      action: request.action,
      resources: request.resources,
      resolved: isPath
        ? request.resources.map((r) => resolvePath(r, info.directory, { home })?.path || String(r))
        : [],
      outside: verdict.outside,
      scope: verdict.scope,
      reason: verdict.reason,
      role: info.role,
      task: info.task,
      title: info.title,
      at: Date.now(),
    };
    const forgiven =
      verdict.effect === 'ask' &&
      wasRemembered(
        request.sessionId,
        request.action,
        grantKey({
          action: request.action,
          resources: request.resources,
          cwd: info.directory,
          projectRoot: info.directory,
          harnessRoot: root,
          home,
        }),
      );
    if (verdict.effect === 'ask' && !forgiven) {
      // Pending: the chip is not drawn yet, but the operator's answer needs the
      // request on record to become one.
      onDecision?.({ ...entry, effect: 'ask', asked: true, decided: false, decidedBy: null });
      log.info(`permission asked${who ? ` (${who})` : ''}: ${request.action || 'tool call'} ${what} — ${verdict.reason}`);
      const pending = { request, info, entry, timer: null, queued: false };
      pendingAsks.set(request.requestId, pending);
      arm(pending);
      return verdict;
    }
    const decision = verdict.effect === 'deny' ? 'reject' : 'once';
    try {
      await engine.replyPermission(request.sessionId, request.requestId, decision);
      // The reply's own `message` field is dropped on this route: measured on
      // 2.1.2, the tool error is always "The user declined this tool call", with
      // no feedback. A synthetic note is the channel that actually reaches a
      // worker, and it says what the refusal means and where to escalate. The
      // Architect is not sent one: the operator is in its chat, the refusal is
      // already on its card, and the extra turn ended with an empty message
      // (measured 26 Oct) instead of the Architect's closing report.
      const escalate = Boolean(info.role) && info.role !== 'architect';
      if (verdict.effect === 'deny' && escalate) {
        Promise.resolve(
          engine.synthetic?.(request.sessionId, refusalNote({ role: info.role, scope: verdict.scope }), {
            description: 'permission refused',
          }),
        ).catch((err) => log.warn(`could not explain the refusal to ${request.sessionId}: ${err.message}`));
      }
      onDecision?.({
        ...entry,
        effect: forgiven ? 'allow' : verdict.effect,
        // An auto-answer — policy or remembered — never asked the operator just
        // now. It was recorded as `asked: true` and drew an amber chip for a call
        // nobody was asked about; measured 26 Oct in the decision log.
        asked: false,
        decided: true,
        decidedBy: forgiven ? 'operator' : 'harness',
        ...(forgiven ? { reason: 'You allowed this earlier in the session.' } : {}),
      });
      log.info(
        `permission ${forgiven ? 'allow' : verdict.effect}${forgiven ? ' (remembered)' : ''}${
          who ? ` (${who})` : ''
        }: ${request.action || 'tool call'} ${what} — ${
          forgiven ? 'you allowed this earlier' : verdict.reason
        }`,
      );
    } catch (err) {
      // The request stays pending when the reply fails, so the operator still
      // sees the card. That is the safe way for this to break.
      onDecision?.({ ...entry, effect: 'ask', asked: true, decided: false, decidedBy: null });
      log.warn(`could not answer a ${request.action || 'tool'} request for ${request.sessionId}: ${err.message}`);
    }
    return verdict;
    } finally {
      answering.delete(request.requestId);
    }
  }

  /** Handle one engine event. Returns a promise for tests; the caller ignores it. */
  function handle(ev) {
    if (ev?.type !== 'permission.asked') return null;
    const request = requestOf(ev);
    if (!request.requestId || !request.sessionId) {
      log.warn('permission.asked without a request or session id — left to the operator');
      return null;
    }
    // The engine sometimes omits `source` (all shell asks measured on 2.1.2).
    // Pair the ask with the call this session just announced; otherwise the
    // decision would be stored without a tool-call id and no chip could be drawn.
    if (!request.toolCallId) request.toolCallId = inferToolCall(request);
    if (request.toolCallId) claimedTools.add(`${request.sessionId}\u0000${request.toolCallId}`);
    return answer(request, ev.directory).catch((err) => {
      // A policy that throws must not take the server down with it; the request
      // stays pending, which puts it in front of the operator.
      log.warn(`permission check failed for ${request.sessionId}: ${err.message}; the operator sees it`);
      return null;
    });
  }

  return { handle, observe, requestOf, remember, setFullAuto, answered, retime, answering: (id) => answering.has(id) };
}
