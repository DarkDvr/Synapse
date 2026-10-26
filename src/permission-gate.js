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
import { decide, resolvePath, refusalNote } from './permissions.js';

export function createPermissionGate({ engine, logger, root, home = os.homedir(), onDecision, memory }) {
  const log = logger.channel('app');
  // sessionId -> { directory, role, task, title }. The directory never changes
  // for a session's life; the role and task make the console line readable.
  const sessions = new Map();

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

  /** Remember one exact request for this session. Only the operator's answer
   *  reaches here; the gate itself never widens what it may do. */
  function remember(sessionId, action, resources) {
    if (!sessionId) return false;
    if (memory) return Boolean(memory.remember(sessionId, action, resources));
    fallback.add(memoryKey(sessionId, action, resources));
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
      // The tool call this request belongs to, for the chip on its card.
      toolCallId: req.source?.id || null,
    };
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
    };
    if (info.directory) sessions.set(sessionId, info);
    return info;
  }

  const shown = (request) => {
    const text = request.resources.map((r) => String(r || '')).join(' ').replace(/\s+/g, ' ').trim();
    return text.length > 160 ? `${text.slice(0, 157)}…` : text;
  };

  async function answer(request, directory) {
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
    const forgiven = verdict.effect === 'ask' && wasRemembered(request.sessionId, request.action, request.resources);
    if (verdict.effect === 'ask' && !forgiven) {
      // Pending: the chip is not drawn yet, but the operator's answer needs the
      // request on record to become one.
      onDecision?.({ ...entry, effect: 'ask', asked: true, decided: false, decidedBy: null });
      log.info(`permission asked${who ? ` (${who})` : ''}: ${request.action || 'tool call'} ${what} — ${verdict.reason}`);
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
        ...(forgiven ? { reason: 'You allowed this exact request earlier in the session.' } : {}),
      });
      log.info(
        `permission ${forgiven ? 'allow' : verdict.effect}${forgiven ? ' (remembered)' : ''}${
          who ? ` (${who})` : ''
        }: ${request.action || 'tool call'} ${what} — ${
          forgiven ? 'you allowed this exact request earlier' : verdict.reason
        }`,
      );
    } catch (err) {
      // The request stays pending when the reply fails, so the operator still
      // sees the card. That is the safe way for this to break.
      onDecision?.({ ...entry, effect: 'ask', asked: true, decided: false, decidedBy: null });
      log.warn(`could not answer a ${request.action || 'tool'} request for ${request.sessionId}: ${err.message}`);
    }
    return verdict;
  }

  /** Handle one engine event. Returns a promise for tests; the caller ignores it. */
  function handle(ev) {
    if (ev?.type !== 'permission.asked') return null;
    const request = requestOf(ev);
    if (!request.requestId || !request.sessionId) {
      log.warn('permission.asked without a request or session id — left to the operator');
      return null;
    }
    return answer(request, ev.directory).catch((err) => {
      // A policy that throws must not take the server down with it; the request
      // stays pending, which puts it in front of the operator.
      log.warn(`permission check failed for ${request.sessionId}: ${err.message}; the operator sees it`);
      return null;
    });
  }

  return { handle, requestOf, remember };
}
