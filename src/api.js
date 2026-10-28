// Synapse API — a stable, engine-agnostic surface for the UI.
// Handlers call the engine adapter; nothing here knows about OpenCode.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensurePlan, readPlan, readRuns, runLedger, briefSession, logPlanState, BRIEF_KEY } from './plans.js';
import { ensureProjectDoc, appendRequest as appendProjectRequest, appendChat, appendDecision as appendProjectDecision, appendEntry, setHandover } from './project-doc.js';
import { createFormAuto } from './form-auto.js';
import { skillRules, describeSkills } from './skills.js';
import { rulesFor, decide, resolvePath, refusalNote, SINGLE_RULES } from './permissions.js';
import { stopTargets } from './stop.js';
import { PROJECTS_ROOT, SKILLS_DIR, ROOT, SCRATCH_ROOT, scratchDir } from './paths.js';
import { mayRecycleFolder } from './projects.js';
import { fetchProviderModels } from './providers.js';
import { providerId } from './providers.js';
import { isLocalProvider, providerUp } from './providers.js';
import { providerApiKey } from './config.js';
import { questionSignature, guardDecision, readableAnswer } from './question-loop.js';
import { setProviderKey, providerKeyState, maskKey } from './secrets.js';
import { probeToolchain } from './toolchain.js';
import { busyInfo, busyMessage } from './busy.js';

// What an attachment may be, in bytes before base64. One message carrying eight
// megabytes is already a large prompt; a hundred is a request the provider will
// refuse after we have paid to send it.
const ATTACH_MAX_BYTES = 8 * 1024 * 1024;
const ATTACH_MAX_COUNT = 6;

/**
 * The files on an outgoing message, as the engine wants them.
 *
 * Tolerant by design: a malformed entry is dropped rather than failing the whole
 * send, because the operator's sentence matters more than their attachment. What
 * survives is bounded — count and size — and named, so the transcript can say what
 * arrived.
 */
/** What is in the project's `bin\`, if anything.
 *
 * A project's `bin` is the one folder whose contents are a *deliverable* — the app
 * that was built — rather than working state. Deleting it is a different consent
 * from deleting the sources beside it, so the dialog asks for it separately, and
 * this is what tells the dialog to ask.
 */
export function binContents(dir) {
  const bin = path.join(dir, 'bin');
  const found = { path: bin, exists: false, files: 0, bytes: 0 };
  try {
    if (!fs.statSync(bin).isDirectory()) return found;
  } catch {
    return found;
  }
  found.exists = true;
  const walk = (at) => {
    let entries;
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      found.files += 1;
      try {
        found.bytes += fs.statSync(full).size;
      } catch { /* it went away while we looked */ }
    }
  };
  walk(bin);
  return found;
}

/**
 * Send a folder to the Windows Recycle Bin.
 *
 * `fs.rm` is permanent, and a project's folder is the operator's work, so deleting
 * a project has to be something they can take back. The shell is the only thing
 * that puts a folder in the bin, and .NET's FileSystem is the one API that asks it
 * to; it is called with the path in the *environment*, never spliced into the
 * command text, so a folder name can never become code.
 *
 * Resolves only when the folder is really gone — the exit code alone is not proof.
 */
function recycleFolder(dir) {
  return new Promise((resolve, reject) => {
    // Newlines, never semicolons: the call is one statement spread over six lines,
    // and a `;` after `DeleteDirectory(` ends it mid-call — "MissingEndParenthesis
    // InMethodCall", which is what a join on ';' produced the first time.
    const script = [
      'Add-Type -AssemblyName Microsoft.VisualBasic',
      "$ErrorActionPreference = 'Stop'",
      '[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(',
      '  $env:SYNAPSE_RECYCLE_TARGET,',
      '  [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,',
      '  [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)',
    ].join('\n');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      windowsHide: true,
      env: { ...process.env, SYNAPSE_RECYCLE_TARGET: dir },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let noise = '';
    child.stderr.on('data', (chunk) => { noise += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0 && !fs.existsSync(dir)) return resolve();
      // PowerShell's stderr is a stack trace: the useful line is the one that says
      // what went wrong, not the `+ CategoryInfo` noise around it.
      const lines = String(noise).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const detail =
        lines.find((l) => !l.startsWith('+') && /exception|denied|not found|in use|cannot/i.test(l)) ||
        lines.find((l) => !l.startsWith('+')) ||
        `the Recycle Bin refused it (exit ${code})`;
      reject(new Error(detail));
    });
  });
}

export function normalizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const data = String(item.data || '').replace(/^data:[^;]*;base64,/, '');
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) continue;
    // Base64 length to bytes, minus the padding: len*3/4 alone over-counts by the
    // two '=' of a single-byte tail, which refused a file of exactly the limit.
    const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    if (Math.floor((data.length * 3) / 4) - pad > ATTACH_MAX_BYTES) continue;
    out.push({
      name: String(item.name || 'attachment').slice(0, 120),
      mime: String(item.mime || 'application/octet-stream').slice(0, 120),
      data,
    });
    if (out.length >= ATTACH_MAX_COUNT) break;
  }
  return out;
}

export function createApi({ getConfig, applyConfig, engine, logger, getBootError, projects, toolStats, probe, modelCache, inspectModel: inspectRef, probeDir, runs, engineUpdate, restart, stopSelf, notify, permissionLog, permissionGate, permissionMemory }) {
  const app = logger.channel('app');

  // The last brief we handed each session, so an unchanged plan does not PUT
  // the same text again on every message.
  const briefed = new Map();

  // Conversations with a compact in flight. The operator can only start one from
  // one window, but the route is open to any client, and a second compact while
  // the engine is summarising would create two chats from one.
  const compacting = new Set();

  // Is each local model server answering, and when did we last ask. Four seconds:
  // the sidebar polls, and a dead port must not be retried on every tick.
  const healthCache = new Map();

  // Who started the work in each directory. Used only for the sentence a refused
  // sender reads — "started from laptop" — never to decide anything.
  const drivers = new Map();
  const normDir = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

  /**
   * Is the project this session belongs to busy, and why.
   *
   * The engine's active list is the authority for a turn, the runner's live map
   * for a delegated run, and a pending permission for a card. General sessions
   * have their own directory, so the same comparison locks only themselves.
   */
  async function busyFor(sessionId) {
    let directory = '';
    try {
      directory = (await engine.getSession(sessionId))?.directory || '';
    } catch { return { busy: false }; }
    if (!directory) return { busy: false };

    const [active, sessions, permissions] = await Promise.all([
      safe(() => engine.listActiveSessions(), []),
      safe(() => engine.listSessions(), []),
      safe(() => engine.listPendingPermissions(), []),
    ]);
    const bySession = new Map((sessions || []).map((s) => [s.id, s]));
    const waiting = (permissions || [])
      .map((p) => {
        const session = bySession.get(p.sessionId || p.sessionID);
        return session && normDir(session.directory) === normDir(directory)
          ? { ...p, directory, sessionId: session.id, title: session.title }
          : null;
      })
      .filter(Boolean);
    const forms = await safe(() => engine.listForms(sessionId), []);
    return busyInfo({
      directory,
      active,
      sessions,
      runs: runs?.active?.() || [],
      permissions: waiting,
      forms: (forms || []).map((f) => ({ ...f, directory })),
      driver: drivers.get(sessionId) || drivers.get(normDir(directory)) || null,
    });
  }

  const refuseBusy = (info) => {
    const err = new Error(busyMessage(info));
    err.status = 409;
    err.busy = info;
    return err;
  };

  /**
   * Which roles this *session* has used, ever.
   *
   * The operator's rule: a non-Architect card starts dim and goes solid the first
   * time that role is used for anything in this session, and it stays solid for
   * the rest of the session. A delegation attempt counts even when the model
   * refused it — that is what the ladder does with a dead model — and rewriting
   * the plan does not reset it, because it is the session's history, not the
   * plan's state. A new session starts everyone dim again, which is the point.
   *
   * The run log has it: every delegate line records the architect session and the
   * role the task was written for; the result line records the role that actually
   * ran it. Both count, joined by callId.
   */
  function usedRoles(directory, sessionId) {
    if (!directory || !sessionId) return [];
    const runs = readRuns(directory);
    const mine = new Set(
      runs.filter((r) => r.kind === 'delegate' && r.architect === sessionId).map((r) => r.callId),
    );
    const used = new Set();
    for (const r of runs) {
      if (r.kind === 'delegate' && r.architect === sessionId && r.role) used.add(r.role);
      else if (r.kind === 'result' && r.role && mine.has(r.callId)) used.add(r.role);
    }
    return [...used];
  }

  /**
   * Tell a session where it is and what the project plan says.
   *
   * This goes through the engine's instruction entries rather than the message
   * text: a prefix would join the conversation and read as if the operator had
   * typed it. Failure is logged once and never blocks the turn — an engine
   * without the concept still works, it just gets no brief.
   */
  async function brief(sessionId, directory, role, auto = false, { single: forcedSingle = null } = {}) {
    try {
      // The project's document is created (and the two old files imported) the
      // first time a project is briefed, so the brief can name one file. It is
      // idempotent and cheap; a failure costs the name, not the turn.
      try {
        ensureProjectDoc(directory);
      } catch (err) {
        app.warn(`could not prepare the project document in ${directory}: ${err.message}`);
      }
      // Which mode the session is in decides what the brief says: Single is a chat
      // with tools, Multi is the harness. A send passes the mode it is about to
      // apply, because the engine's own record may be a moment behind it.
      let single;
      if (forcedSingle === null) {
        try {
          single = (await engine.getSession(sessionId))?.single === true;
        } catch {
          single = false; /* the brief still works without it */
        }
      } else {
        single = forcedSingle === true;
      }
      const text = briefSession({
        dir: directory,
        role,
        auto,
        single,
        // Single is a chat, not this harness: its skills line may not say "this
        // role" or "your report", because there is neither.
        skills: describeSkills(getConfig(), role, { chat: single }),
        focus: getConfig()?.roles?.[role]?.focus,
        instructions: getConfig()?.roles?.[role]?.instructions,
      });
      if (briefed.get(sessionId) === text) return;
      await engine.setInstruction(sessionId, BRIEF_KEY, text);
      briefed.set(sessionId, text);
    } catch (err) {
      if (briefed.get(sessionId) !== 'failed') {
        app.warn(`could not brief ${sessionId}: ${err.message}`);
        briefed.set(sessionId, 'failed');
      }
    }
  }

  /**
   * Wait for the engine's handover after asking it to compact.
   *
   * The call is a queue entry, not a blocking one: it runs at the next step
   * boundary, and from an idle chat that is now. The summary lands in the
   * transcript as a `compaction` message with `status: completed` and a
   * `summary`; this polls the newest page until a new one with text appears.
   * Returns null on timeout or on a compaction that failed — the caller must
   * delete nothing in that case.
   */
  async function waitForHandover(sessionId, before, timeoutMs) {
    const seen = new Set((before || []).filter((m) => m.type === 'compaction').map((m) => m.id));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const messages = await engine.getMessages(sessionId).catch(() => null);
      if (messages) {
        const fresh = messages
          .filter((m) => m.type === 'compaction' && !seen.has(m.id) && String(m.raw?.summary || '').trim())
          .filter((m) => m.raw?.status !== 'running')
          .sort((a, b) => (Number(a.created) || 0) - (Number(b.created) || 0));
        if (fresh.length) {
          const last = fresh[fresh.length - 1];
          const counted = messages.filter((m) => m.type === 'user' || m.type === 'assistant').length;
          return { text: String(last.raw.summary).trim(), messages: counted, at: Number(last.created) || Date.now() };
        }
      }
      if (Date.now() >= deadline) return null;
    }
  }

  /** Directory comparison key: case-insensitive, no trailing separator. */
  const dirKey = (d) => String(d ?? '').replace(/[\\/]+$/, '').toLowerCase();

  /** Probe scratch sessions and Synapse's own worker sessions are scaffolding,
   *  never the operator's work: they never appear in the rail. */
  const isScratchSession = (s) => {
    if (s?.internal) return true;
    const key = dirKey(probeDir);
    return Boolean(key) && dirKey(s?.directory) === key;
  };

  /**
   * Projects with their sessions attached. A session belongs to the project
   * whose directory it runs in. A session that matches no project is not shown:
   * there is no built-in project to fall back to, and a row that cannot be
   * opened is noise. (Scaffolding is filtered separately.)
   */
  async function projectsWithSessions() {
    const list = projects.list().map((p) => ({ ...p, sessions: [] }));
    if (!engine.status().ready) return list;

    const byDir = new Map(list.map((p) => [dirKey(p.directory), p]));
    let sessions = [];
    try {
      sessions = await engine.listSessions();
    } catch (err) {
      app.warn(`could not list sessions: ${err.message}`);
    }
    for (const s of sessions) {
      if (isScratchSession(s)) continue; // probe/model-check scaffolding
      const owner = byDir.get(dirKey(s.directory));
      if (!owner) continue;
      owner.sessions.push(s);
    }
    for (const p of list) {
      // Oldest first, so a new session always appears at the bottom of its
      // project and the list never reshuffles under the cursor.
      p.sessions.sort((a, b) => (a.created || 0) - (b.created || 0));
      p.sessionCount = p.sessions.length;
    }
    return list;
  }

  const toClientConfig = (cfg) => {
    const c = structuredClone(cfg);
    if (c.engine?.opencode) {
      const pw = c.engine.opencode.password || '';
      c.engine.opencode.password = '';
      c.engine.opencode.passwordSet = Boolean(pw);
      // A provider's key is never sent to the browser. The screen shows a mask
      // and knows whether one exists; the value itself stays on this side.
      c.engine.opencode.providers = (c.engine.opencode.providers || []).map((p) => {
        const stored = providerKeyState(p.id);
        const literal = String(p.apiKey || '');
        const fromEnv = /^env:/i.test(literal);
        return {
          ...p,
          apiKey: fromEnv ? literal : '',
          apiKeySet: stored.set || Boolean(literal && !fromEnv),
          apiKeyMasked: stored.set ? stored.masked : literal && !fromEnv ? maskKey(literal) : '',
          apiKeyFrom: stored.set ? 'stored' : fromEnv ? literal : literal ? 'config' : '',
        };
      });
    }
    return c;
  };

  // When the UI saves config with an empty password, keep the existing one — and
  // a typed provider key moves to data\provider-keys.json instead of the config
  // file. `null` means the operator removed the key; `''` means they did not
  // touch it (the browser never received the literal, so it cannot send it back).
  function reconcile(incoming) {
    const next = structuredClone(incoming || {});
    if (next.engine?.opencode) {
      const provided = next.engine.opencode.password;
      if (provided === undefined || provided === null || provided === '') {
        next.engine.opencode.password = getConfig().engine?.opencode?.password || '';
      }
      delete next.engine.opencode.passwordSet;
    }
    const list = next.engine?.opencode?.providers;
    if (Array.isArray(list)) {
      // The id is what a key is filed under, and a provider added in Settings has
      // none until its first save — so decide it here, with the same rule
      // config.normalize uses, or the new provider's key would be filed under ''.
      const taken = [];
      for (const p of list) {
        if (!p.id) p.id = providerId(p.name, taken);
        if (p.id) taken.push(p.id);
      }
      for (const p of list) {
        delete p.apiKeySet;
        delete p.apiKeyMasked;
        delete p.apiKeyFrom;
        delete p.apiKeyRemoved;
        const key = p.apiKey;
        if (key === null) {
          if (p.id) setProviderKey(p.id, '');
          p.apiKey = '';
        } else if (typeof key === 'string' && key.trim() && !/^env:/i.test(key.trim())) {
          if (p.id) setProviderKey(p.id, key.trim());
          p.apiKey = '';
        }
      }
    }
    return next;
  }

  /**
   * Question loops.
   *
   * A worker asking a question gets one answer from the operator, which the engine
   * records as the tool's result. If the same question comes back, the worker is
   * not asking for information any more — it is looping, and the operator is being
   * asked to answer the same thing twice. Measured on Shift Test 2: four asks, the
   * same one three times, every answer recorded and every answer ignored.
   *
   * So: the second ask is answered with the operator's own earlier answer, without
   * showing it to them; the third stops the run with a reason the report carries.
   * That is a show stopper on purpose — the operator wants to see it and fix the
   * model, not be asked again.
   */
  const questionHistory = new Map(); // sessionId -> Map(signature -> { answer, asks })
  const autoAnswered = new Set();    // form ids already answered here

  /**
   * A read that is allowed to fail. Listing what waits on the operator must not
   * throw because one engine route is unhappy — and the form lookup after a
   * reply must not throw either, or the reply never gets sent (it lived inside
   * `pending` once, which is exactly how `safe is not defined` stopped a run).
   */
  const safe = async (fn, fallback) => {
    try { return await fn(); } catch (err) { app.warn(`pending: ${err.message}`); return fallback; }
  };

  const formSignature = questionSignature;
  const readableAnswerOf = readableAnswer;

  /** Returns the forms that should still be shown; answers or stops the rest. */
  async function guardQuestions(forms) {
    const open = [];
    for (const form of forms || []) {
      const sessionId = form?.sessionID;
      const signature = formSignature(form);
      if (!sessionId || !form.id || !signature) { open.push(form); continue; }
      const per = questionHistory.get(sessionId);
      const decision = guardDecision(per, form.id, signature);
      if (decision.action === 'show') { open.push(form); continue; }
      if (autoAnswered.has(form.id)) continue;

      if (decision.action === 'stop') {
        const seen = per.get(signature);
        seen.asks = decision.asks;
        seen.stopped = true;
        autoAnswered.add(form.id);
        const reason =
          `Stopped: the worker asked the same question ${decision.asks} times and had the answer. ` +
          `Question: "${signature}". The operator answered: "${readableAnswerOf(decision.answer)}". ` +
          `Do not re-delegate this task as it is: split it, or make the decision yourself and say what you chose.`;
        app.error(`question loop in ${sessionId} (${decision.asks} asks) - stopping the run`);
        const stopped = runs?.stopWithReason?.(sessionId, reason);
        if (!stopped) {
          // No run to stop (an Architect turn, or the worker is already gone):
          // interrupt the session so it cannot ask a fourth time.
          try { await engine.interrupt(sessionId); } catch { /* already gone */ }
        }
        continue; // never shown again
      }

      // Second ask: answer it for them, with the answer they already gave.
      autoAnswered.add(form.id);
      per.get(signature).asks = decision.asks;
      try {
        await engine.replyForm(sessionId, form.id, decision.answer);
        app.warn(
          `question loop in ${sessionId}: answered "${signature.slice(0, 80)}" again with the operator's earlier answer ` +
            `(ask ${decision.asks}); the next repeat stops the run`,
        );
      } catch (err) {
        app.warn(`could not answer the repeated question in ${sessionId}: ${err.message}`);
        open.push(form);
      }
    }
    return open;
  }

  // Full auto for questions. The permission gate handles permission cards; this
  // handles forms, on the same switch and the same minute. It records the answer
  // exactly as an operator reply would: the question-loop history, the form
  // broadcast, and the project document.
  const formAuto = createFormAuto({
    engine,
    logger,
    onAnswered: async ({ form, sessionId, answer }) => {
      const signature = formSignature(form);
      if (signature) {
        const per = questionHistory.get(sessionId) || new Map();
        per.set(signature, { answer, asks: 1 });
        questionHistory.set(sessionId, per);
      }
      notify?.({ kind: 'form', type: 'form.answered', formId: form.id, sessionId, by: 'Full auto' });
      try {
        const session = await safe(() => engine.getSession(sessionId), null);
        if (session?.directory && Array.isArray(form.fields) && form.fields.length) {
          const written = appendProjectDecision(session.directory, { fields: form.fields, answer });
          if (written && written.ok === false) app.warn(`could not write the full-auto answer: ${written.error}`);
        }
      } catch (err) {
        app.warn(`could not write the full-auto answer to the project document: ${err.message}`);
      }
      app.info(`full auto answered a question in ${sessionId}`);
    },
  });

  const requireReady = () => {    const st = engine.status();    if (!st.ready) {
      const err = new Error(getBootError() || `${st.kind} engine is not ready`);
      err.status = 503;
      throw err;
    }
  };

  return {
    status: async () => ({
      engine: engine.status(),
      bootError: getBootError(),
      config: toClientConfig(getConfig()),
    }),

    getConfig: async () => toClientConfig(getConfig()),

    // "Refresh List" in Settings > Providers: ask a server what it serves. The
    // operator's click is the only reason this contacts anything - see
    // src/providers.js.
    //
    // The key is resolved on this side: the browser is never given one, so the
    // only thing it can send is a key typed into the field and not yet saved. A
    // stored key (or `env:...` in the config) is what an unsaved row's call has
    // to use, or every provider with a key answers 401 here and works nowhere.
    /**
     * Which local model servers are answering right now, and their names.
     *
     * The sidebar's Local LLM row answers one question — "is the thing I turned on
     * actually there" — so it needs a *now* answer, not the config. Each probe is
     * one short GET, and the result is held for a few seconds: the row is polled,
     * and a dead port must not be re-tried on every tick.
     */
    providerHealth: async () => {
      const providers = Array.isArray(getConfig()?.engine?.opencode?.providers)
        ? getConfig().engine.opencode.providers
        : [];
      const local = providers.filter(isLocalProvider);
      const now = Date.now();
      const stale = local.some((p) => !healthCache.has(p.id) || now - healthCache.get(p.id).at > 4000);
      if (stale) {
        await Promise.all(
          local.map(async (p) => {
            const up = await providerUp(p);
            healthCache.set(p.id, { at: Date.now(), up });
          }),
        );
      }
      return {
        servers: local.map((p) => ({
          id: p.id,
          name: p.name || p.id,
          up: healthCache.get(p.id)?.up ?? false,
        })),
      };
    },

    providerModels: async (body) => {
      const id = String(body?.id || '').trim();
      const key = id ? providerApiKey({ id, apiKey: body?.apiKey }, process.env).key : String(body?.apiKey || '').trim();
      return fetchProviderModels({ ...(body || {}), apiKey: key });
    },

    // Settings > Save Changes asks whether to restart. The engine and the server
    // read their settings at start, so this is the honest answer to "apply now".
    restart: async () => {
      if (!restart) return { ok: false, error: 'This build cannot restart itself.' };
      return restart();
    },

    // Tray > Stop Server. Graceful, like the restart: the engine is stopped by the
    // same shutdown path rather than being killed with its parent.
    shutdown: async () => {
      if (!stopSelf) return { ok: false, error: 'This build cannot stop itself.' };
      return stopSelf();
    },

    // The engine updates often and the model catalog ships inside it, so this is
    // the one place Synapse will talk to the network for something other than a
    // model — and only because the operator asked. `check` without `online` is
    // free: it reads the engine, the desktop's own version file and the cache.
    engineUpdate: async () => engineUpdate.check({ online: false }),
    checkEngineUpdate: async () => engineUpdate.check({ online: true }),
    updateEngine: async () => engineUpdate.update(),

    // What this machine can build with, for Settings → Windows. Cheap and cached:
    // one PowerShell call, no builds, so the tab opens instantly.
    toolchain: async ({ force = false } = {}) => probeToolchain({ force }),

    saveConfig: async (body) => {
      const saved = applyConfig(reconcile(body));
      app.info('config saved via UI');
      const shown = toClientConfig(saved);
      // The other view must not keep showing the old file until somebody
      // refreshes. The switcher above is the same rule for the LAN toggle.
      notify?.({ kind: 'config', type: 'config.saved', config: shown });
      return shown;
    },

    models: async () => {
      requireReady();
      const list = await engine.listModels();
      // The catalog is the live truth; record it so a model that later leaves
      // the list still has its context, variants and tools on file.
      if (modelCache) {
        try { modelCache.record(list); } catch (err) { app.warn(`model cache update failed: ${err.message}`); }
      }
      return {
        models: list.map((m) => {
          const known = modelCache?.get(m.ref);
          return { ...m, tools: known?.tools || null, issues: known?.issues || null };
        }),
      };
    },

    /** The raw per-model knowledge base, for inspection and debugging. */
    modelCache: async () => (modelCache ? modelCache.snapshot() : { version: 1, models: {} }),

    /**
     * Clear a model's issues. The operator's own call, from the picker: they
     * checked it and it works, so the badge goes and nothing is asked of anyone.
     */
    clearModelIssues: async (body) => {
      const ref = String(body?.ref || '').trim();
      if (!ref) {
        const err = new Error('a provider/model ref is required');
        err.status = 400;
        throw err;
      }
      const cleared = modelCache ? modelCache.clearIssues(ref) : false;
      app.info(`model issues cleared: ${ref}${cleared ? '' : ' (there were none)'}`);
      return { ok: true, ref, cleared };
    },

    /** Zero every model's ask counter (keeps valid results). */
    resetModelAsks: async () => ({
      ok: true,
      models: modelCache ? modelCache.resetAsks() : 0,
    }),

    /**
     * Kick off a background toolset discovery for one model. Idempotent: a model
     * already checked returns its cached tools, and one already running reports
     * `running` instead of stacking a second turn.
     */
    inspectModel: async (body) => {
      requireReady();
      if (!inspectRef) return { started: false, reason: 'model checks are unavailable' };
      const ref = String(body?.ref || '').trim();
      if (!ref.includes('/')) {
        const err = new Error('a provider/model ref is required');
        err.status = 400;
        throw err;
      }
      return inspectRef(ref);
    },

    agents: async () => {
      requireReady();
      return { agents: await engine.listAgents() };
    },

    /**
     * What the engine can actually load, and what the role settings expect.
     *
     * A config that travelled from another machine can name skills that are not
     * here, and a missing name does not fail — the rule allows it and nothing
     * loads, which is the quietest way for a capability to disappear. So the gap
     * is reported as data: the UI says it once at boot, and the role picker shows
     * the name it cannot offer rather than dropping it in silence.
     */
    skills: async () => {
      const config = getConfig() || {};
      // A shipped skill also present in a *configured* folder is worth naming:
      // the configured copy wins (measured), so an edit to the shipped one would
      // not be the one loaded. The engine's default `~/.agents/skills` scan is not
      // a problem — it loses to the configured copy, which is the point.
      let shipped = new Set();
      try {
        shipped = new Set(
          fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name),
        );
      } catch { /* no shipped folder: nothing can collide */ }
      const paths = (config.engine?.opencode?.skillPaths || []).map((p) => {
        const entry = { path: String(p), exists: fs.existsSync(String(p)), duplicates: [] };
        if (!entry.exists || !shipped.size) return entry;
        try {
          entry.duplicates = fs
            .readdirSync(String(p), { withFileTypes: true })
            .filter((e) => e.isDirectory() && shipped.has(e.name))
            .map((e) => e.name)
            .sort();
        } catch { /* an unreadable folder is reported by `exists` */ }
        return entry;
      });
      if (!engine.status().ready) return { skills: [], missing: [], paths, bundled: SKILLS_DIR };
      const skills = await engine.listSkills();
      const names = new Set(skills.map((s) => s.name));
      const missing = [];
      for (const [role, entry] of Object.entries(config.roles || {})) {
        for (const name of entry?.skills || []) {
          if (names.has(name)) continue;
          let record = missing.find((m) => m.name === name);
          if (!record) {
            record = { name, roles: [] };
            missing.push(record);
          }
          record.roles.push(role);
        }
      }
      return { skills, missing, paths, bundled: SKILLS_DIR };
    },

    /** Delegated work in flight, one entry per project. The live path and the
     *  role cards are drawn from this; the SSE events are the fast path and
     *  this is what a page opened mid-run starts from. */
    runs: async () => ({ runs: runs?.active() || [] }),

    // POST /api/runs/cancel - stop the delegated run in a project. The UI's Stop
    // button uses this when the open session is idle and a worker is not: the
    // worker is the thing that needs stopping, and a run waiting out a five-minute
    // backoff has to stop immediately.
    cancelRun: async ({ dir } = {}) => {
      const directory = String(dir || '').trim();
      if (!directory) {
        const err = new Error('a directory is needed to stop a run');
        err.status = 400;
        throw err;
      }
      return { ok: Boolean(runs?.cancel?.(directory)) };
    },

    /**
     * POST /api/runs/resume — the operator has acted, so a stopped project may run
     * again. The message path already does this, and so does turning keep-building
     * on; a model change is the third kind of "I fixed it": the thing that was
     * refused has been replaced, and the hold has no reason to outlive it.
     */
    resumeRuns: async ({ dir } = {}) => {
      const directory = String(dir || '').trim();
      if (!directory) return { ok: false, resumed: false };
      return { ok: true, resumed: Boolean(runs?.resume?.(directory)) };
    },

    // ── projects ─────────────────────────────────────────────
    projects: async () => ({ projects: await projectsWithSessions() }),

    createProject: async (body) => {
      // Does this folder already carry a plan? Adding a project only registers a
      // directory, so a folder the operator deleted the *project* for is still on
      // disk with everything in it — including the plan the Architect left there.
      // That is the right behaviour for re-adding a real project, and a trap when
      // the name is reused for a fresh start: the pane opened onto a finished
      // 4/4 plan and the Architect card said DONE before anyone had typed
      // anything. So it is reported, never wiped.
      let existingPlan = null;
      const dir = String(body?.directory || '').trim();
      if (dir) {
        try {
          const before = readPlan(dir);
          if (before.exists && before.plan?.tasks?.length) {
            existingPlan = {
              tasks: before.plan.tasks.length,
              done: before.plan.tasks.filter((t) => t.status === 'done').length,
              goal: (before.plan.goal || '').slice(0, 120),
            };
          }
        } catch { /* a directory we cannot read is the project's problem, not this call's */ }
      }
      const project = projects.create({ name: body?.name, directory: body?.directory });
      // A project starts with an empty, valid plan file, so the first session in
      // it has something concrete to fill in rather than a blank page. This never
      // touches an existing plan.
      ensurePlan(project.directory);
      // The scratch folder the brief names: give it now, so a model does not have
      // to create its own on the first turn.
      try { fs.mkdirSync(scratchDir(project.directory), { recursive: true }); } catch { /* the model can make it */ }
      return {
        project: (await projectsWithSessions()).find((p) => p.id === project.id) || project,
        existingPlan,
      };
    },

    /**
     * Open a project in Explorer, or a command prompt at it. Both are detached
     * GUI processes: Synapse does not track them and never kills them.
     */
    openProject: async (id, what) => {
      const project = projects.find(id);
      if (!project) {
        const err = new Error('project not found');
        err.status = 404;
        throw err;
      }
      if (!fs.existsSync(project.directory)) {
        const err = new Error(`the folder does not exist: ${project.directory}`);
        err.status = 400;
        throw err;
      }
      // Array args, never a shell string: the directory is the operator's, and
      // it must not be able to turn into a command.
      //
      // A command prompt goes through `start`, because a `cmd.exe` spawned
      // directly by this process has no console of its own and exits instantly
      // (verified: exit 0 within a second, no window). `start` asks the shell to
      // create the window, and it survives.
      const cmd = what === 'cmd';
      const args = cmd
        ? ['/c', 'start', '', 'cmd.exe', '/K', `cd /d ${project.directory}`]
        : [project.directory];
      const child = spawn(cmd ? 'cmd.exe' : 'explorer.exe', args, { detached: true, stdio: 'ignore' });
      child.unref();
      app.info(`opened ${cmd ? 'a command prompt' : 'Explorer'} at ${project.directory}`);
      return { ok: true };
    },

    updateProject: async (id, body) => {
      const project = projects.update(id, { name: body?.name });
      return { project };
    },

    /**
     * Look at a folder *before* a project is registered there.
     *
     * Deleting a project only unregisters it, so a reused name lands on the old
     * folder with everything still in it — plan included. The UI asks this first and
     * shows a three-way choice; nothing is created or deleted by this call.
     */
    inspectProjectDir: async (body) => {
      const dir = String(body?.directory || '').trim();
      if (!dir) {
        const err = new Error('a directory is required');
        err.status = 400;
        throw err;
      }
      const state = readPlan(dir);
      let files = 0;
      try {
        files = fs.readdirSync(dir, { recursive: true }).length;
      } catch { /* not there, or not readable: both mean "nothing to lose" */ }
      return {
        directory: dir,
        exists: fs.existsSync(dir),
        files,
        plan: state.exists && state.plan?.tasks?.length
          ? {
              tasks: state.plan.tasks.length,
              done: state.plan.tasks.filter((t) => t.status === 'done').length,
              goal: state.plan.goal || '',
              mtime: state.mtime,
            }
          : null,
      };
    },

    /**
     * Wipe a project folder so a fresh project can start in it.
     *
     * Deliberately narrow: only a directory *inside* the projects root, never the
     * root itself, never General's folder. The engine is told to release the
     * location first — that handle is the only reason a folder could not be
     * deleted while Synapse runs.
     */
    wipeProjectDir: async (body) => {
      const dir = String(body?.directory || '').trim();
      if (!dir) {
        const err = new Error('a directory is required');
        err.status = 400;
        throw err;
      }
      const rel = path.relative(PROJECTS_ROOT, path.resolve(dir));
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        const err = new Error(`refusing to wipe ${dir}: it is not inside ${PROJECTS_ROOT}`);
        err.status = 400;
        throw err;
      }
      try {
        await engine.evictLocation?.(dir);
      } catch (err) {
        app.warn(`could not release ${dir} before wiping it: ${err.message}`);
      }
      // Even a confirmed release can leave the filesystem a tick behind, so the
      // delete is retried briefly rather than failing on the first EBUSY.
      let lastError = null;
      for (let i = 0; i < 10; i += 1) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      if (lastError) {
        const e = new Error(`could not delete ${dir}: ${lastError.message}`);
        e.status = 423; // locked
        throw e;
      }
      app.info(`wiped project folder: ${dir}`);
      return { ok: true, removed: !fs.existsSync(dir) };
    },

    /**
     * What deleting this project would do, before anything is deleted.
     *
     * The dialog needs two facts the project list does not carry: whether the
     * folder is still on disk, and whether there are deliverables in `bin\` — the
     * one thing in a project that has to be agreed to separately.
     */
    projectDeleteInfo: async (id) => {
      const current = projects.find(id);
      if (!current) {
        const err = new Error('project not found');
        err.status = 404;
        throw err;
      }
      const withSessions = (await projectsWithSessions()).find((p) => p.id === id);
      return {
        id,
        name: current.name,
        directory: current.directory,
        exists: fs.existsSync(current.directory),
        general: Boolean(current.general),
        sessions: withSessions?.sessions?.length || 0,
        bin: binContents(current.directory),
      };
    },

    /**
     * Delete a project — its conversation, its folder and its memory.
     *
     * The project is one chat, so deleting the project ends that chat too; there
     * is no separate "delete the session first" step any more. The folder goes to
     * the Recycle Bin (the undo), and `bin\` — the built app, a deliverable rather
     * than working state — has to be agreed to on its own. A project that is
     * working, or waiting on a card, is refused: stopping the work is the
     * operator's call, not a side effect of a menu item.
     */
    deleteProject: async (id, body) => {
      const current = projects.find(id);
      if (!current) {
        const err = new Error('project not found');
        err.status = 404;
        throw err;
      }
      const withSessions = (await projectsWithSessions()).find((p) => p.id === id);
      const sessions = withSessions?.sessions || [];
      if (sessions.length) {
        const busy = await busyFor(sessions[sessions.length - 1].id);
        if (busy.busy) throw refuseBusy(busy);
      }
      const bin = binContents(current.directory);
      // Enforced here as well as in the dialog: the checkbox is the operator's
      // consent, and a request may not assert one it was never asked for.
      if (bin.files > 0 && body?.binConfirmed !== true) {
        const err = new Error(
          `"${current.name}" has ${bin.files} file${bin.files === 1 ? '' : 's'} in bin\\. Confirm that the deliverables there are to be deleted with the project.`,
        );
        err.status = 409;
        throw err;
      }
      let recycled = false;
      if (fs.existsSync(current.directory)) {
        // The engine holds a location "loaded" once it has served a turn there,
        // and that handle is what made a finished project's folder undeletable
        // until Synapse was stopped. Release it before the folder moves.
        try {
          await engine.evictLocation?.(current.directory);
        } catch (err) {
          app.warn(`could not release ${current.directory} from the engine: ${err.message}`);
        }
        const allowed = mayRecycleFolder(current.directory, { projectsRoot: PROJECTS_ROOT, harness: ROOT });
        if (!allowed.ok) {
          const err = new Error(`refusing to delete the folder: ${allowed.reason}`);
          err.status = 400;
          throw err;
        }
        try {
          await recycleFolder(current.directory);
          recycled = true;
        } catch (err) {
          // The project stays registered. A folder still on disk with its registry
          // entry gone is the worse half of a failed delete: the operator can see the
          // folder but Synapse no longer knows it is there.
          const e = new Error(`could not move ${current.directory} to the Recycle Bin: ${err.message}`);
          e.status = 423; // locked
          throw e;
        }
        app.info(`deleted project folder to the Recycle Bin: ${current.directory}`);
      }
      // The folder is gone first, so a failed conversation delete cannot leave a
      // working project pointing at nothing; a session that fails to delete here
      // is invisible anyway (its directory is not a project any more).
      for (const s of sessions) {
        try {
          await engine.deleteSession(s.id);
          briefed.delete(s.id);
          permissionMemory?.forgetSession?.(s.id);
        } catch (err) {
          app.warn(`could not delete the conversation ${s.id} of a deleted project: ${err.message}`);
        }
      }
      projects.remove(id);
      return { ok: true, recycled, directory: current.directory, binFiles: bin.files };
    },

    createSession: async (body) => {
      requireReady();
      // A conversation is the project's. There is no built-in project to open a
      // chat in, so a create without one is a caller bug, not a default.
      const project = body?.projectId ? projects.find(body.projectId) : null;
      if (!project) {
        const err = new Error('choose a project first');
        err.status = 400;
        throw err;
      }
      const location = project.directory;
      const session = await engine.createSession({
        // The engine's own title is never shown: the rail names the project. It is
        // set to the project's name so the engine's list is readable in an audit.
        title: project.name,
        model: body?.model,
        agent: body?.agent,
        // The permission ladder comes first: every write, shell, read and code
        // call asks the engine, and the gate answers from the policy. The
        // caller's own rules (Single's `subagent` deny) come after, so a mode
        // rule still wins by being last, and the role's skill list comes last of
        // all for the same reason.
        permissions: [
          ...rulesFor(),
          ...(Array.isArray(body?.permissions) ? body.permissions : []),
          ...skillRules(getConfig(), 'architect'),
        ],
        directory: location,
      });
      // From the first turn, the Architect knows where it is and that the plan
      // file is its own to keep.
      await brief(session.id, location, 'architect', false);
      // A new session is a new piece of work, and the census is a picture of what
      // the models are doing *now*: left to accumulate it describes a machine that
      // no longer exists. The operator opens the popup to answer "what is being
      // called", not "what has ever been called".
      if (toolStats) toolStats.clear();
      return { session, projectId: project.id };
    },

    /** Switch the model and/or thinking effort used by an existing session. */
    switchModel: async (sessionId, body) => {
      requireReady();
      const model = body?.model;
      if (!model || (typeof model === 'string' && !model.includes('/'))) {
        const err = new Error('a model reference is required');
        err.status = 400;
        throw err;
      }
      await engine.switchModel(sessionId, model);
      return { ok: true };
    },

    messages: async (sessionId) => {
      requireReady();
      return { messages: await engine.getMessages(sessionId) };
    },

    /**
     * The open session's project plan, read straight from `.synapse\plan.json`
     * in its directory. The file is the source of truth — there is no store to
     * keep in sync, and a plan written by hand reads the same as one the
     * Architect wrote.
     */
    plan: async (sessionId) => {
      let directory = null;
      try {
        const session = await engine.getSession(sessionId);
        directory = session?.directory || null;
      } catch { /* session gone; report no plan rather than an error */ }
      const state = directory ? readPlan(directory) : readPlan('');
      // The pane polls this, so the logger is told once per distinct problem
      // rather than once per poll (see logPlanState).
      logPlanState(state, app);
      // How long each step has actually taken, and which steps this session's
      // workers have handed back. Both are read from the project's run log, so
      // both survive a reload — but scoped to *this* session: a task id means
      // nothing across sessions, and an old run under the same id was showing its
      // time and its "waiting for review" on a plan it never touched.
      const { spent, reported } = directory
        ? runLedger(readRuns(directory), sessionId)
        : { spent: {}, reported: [] };
      return { ...state, used: usedRoles(directory, sessionId), spent, reported };
    },

    sendMessage: async (sessionId, body, actor = null) => {
      requireReady();
      const text = String(body?.text ?? '').trim();
      // An attachment on its own is a message: "look at this" with the file in
      // hand is a request, and refusing it because there was no sentence would be
      // the harness being pedantic about the shape of a sentence.
      const attachments = normalizeAttachments(body?.files);
      if (!text && !attachments.length) {
        const err = new Error('message text is required');
        err.status = 400;
        throw err;
      }
      // One project, one conversation. The rule is the same for both views — a
      // second prompt into a working project would interleave with a plan that is
      // already in flight, whoever sends it. Cards and Stop stay open.
      const busy = await busyFor(sessionId);
      if (busy.busy) throw refuseBusy(busy);
      if (actor?.name) {
        drivers.set(sessionId, { name: actor.name, id: actor.id || null, at: Date.now() });
        if (busy.directory) drivers.set(normDir(busy.directory), { name: actor.name, id: actor.id || null, at: Date.now() });
      }
      // The mode is a choice about *this message*. It is applied here, once, so a
      // toggle clicked ten times and then sent applies exactly one — and the mode
      // the engine enforces is always the one this turn was briefed with.
      const asked = body?.mode === 'single' ? 'single' : body?.mode === 'multi' ? 'multi' : null;
      let directory = '';
      let single = false;
      try {
        const session = await engine.getSession(sessionId);
        directory = session?.directory || '';
        const applied = session?.single === true ? 'single' : 'multi';
        single = asked ? asked === 'single' : applied === 'single';
        if (asked && asked !== applied) {
          // Single denies the delegation tool; Multi clears the ruleset. Applied to
          // later turns of this session, which is exactly this one.
          await engine.updateSessionPermissions(sessionId, single ? SINGLE_RULES : []);
          app.info(`mode ${applied} -> ${asked} for ${sessionId} (applied at send)`);
          notify?.({ kind: 'sessions', type: 'session.mode', sessionId, mode: asked });
        }
        // A send into a finished plan starts a new round. Close it before the
        // brief, so the brief's QC allowance is this round's — and so the finished
        // plan keeps its row times until this moment. Closing at the end of the
        // plan (in the wake) hid them: the marker is the ledger's boundary, and a
        // just-closed plan's own results sit before it ("not run", 28 Oct).
        if (directory) {
          try {
            if (runs?.closeRound?.(directory)) app.info(`round closed: ${directory} - caps reset`);
          } catch (err) {
            app.warn(`could not close the round: ${err.message}`);
          }
        }
        await brief(sessionId, directory, 'architect', session?.auto === true, { single });
      } catch (err) {
        app.warn(`brief skipped for ${sessionId}: ${err.message}`);
      }
      // The operator's own words, written down before any model can restate them.
      // A Multi message is the project's request; a Single one is a side ask, so it
      // is logged as a chat and never becomes the head's Request. Both are in the
      // same file, so nothing the operator said is lost when a conversation ends.
      if (directory) {
        const body = text || `(attached ${attachments.length} file(s))`;
        const written = single ? appendChat(directory, body) : appendProjectRequest(directory, body);
        if (written && written.ok === false) app.warn(`could not write to the project document: ${written.error}`);
      }
      // Speaking is the answer to "what now" after a stop: whatever they stopped
      // may run again from here.
      if (directory) runs?.resume?.(directory);
      await engine.prompt(sessionId, text, { files: attachments });
      return { ok: true };
    },

    /**
     * Compact: the engine writes a handover, the conversation is discarded, a
     * fresh one starts in the same folder.
     *
     * This is the only reset. It is refused while anything is running (a chapter
     * cannot close mid-turn) and while another compact on the same chat is in
     * flight. Nothing is deleted until the handover is safely in the project
     * document: a compaction that fails leaves the conversation exactly as it was.
     *
     * The new session keeps what belongs to the project rather than the chat —
     * folder, mode, Keep Building, model — and carries the "Always Allow" grants,
     * because compaction is about context, not consent. Its metadata carries the
     * post the chat shows (`synapse.compacted`), and the project document's
     * `## Handover` carries the brief.
     */
    compactSession: async (sessionId, { timeoutMs = 180000 } = {}) => {
      requireReady();
      if (compacting.has(sessionId)) {
        const err = new Error('this conversation is already being compacted');
        err.status = 409;
        throw err;
      }
      const busy = await busyFor(sessionId);
      if (busy.busy) throw refuseBusy(busy);
      const session = await engine.getSession(sessionId);
      if (!session?.directory) {
        const err = new Error('this conversation is not in a project folder');
        err.status = 400;
        throw err;
      }
      const before = await engine.getMessages(sessionId).catch(() => []);
      if (!before.length) {
        const err = new Error('there is nothing to compact yet');
        err.status = 400;
        throw err;
      }
      compacting.add(sessionId);
      try {
        try {
          await engine.compact(sessionId);
        } catch (err) {
          const wrapped = new Error(`the engine could not compact: ${err.message}`);
          wrapped.status = 502;
          throw wrapped;
        }
        const handover = await waitForHandover(sessionId, before, timeoutMs);
        if (!handover) {
          const err = new Error('the engine did not write a handover in time; nothing was deleted');
          err.status = 504;
          throw err;
        }
        const at = handover.at || Date.now();
        if (!setHandover(session.directory, handover.text, { at })) {
          const err = new Error('the handover could not be written to the project document; nothing was deleted');
          err.status = 500;
          throw err;
        }
        const marker = appendEntry(
          session.directory,
          'compact',
          `The conversation was discarded after ${handover.messages} messages; the handover is in this document.`,
          { at },
        );
        if (marker && marker.ok === false) app.warn(`could not mark the compact in the project document: ${marker.error}`);

        const meta = session.metadata && typeof session.metadata === 'object' ? { ...session.metadata } : {};
        const synapse = { ...(meta.synapse && typeof meta.synapse === 'object' ? meta.synapse : {}) };
        synapse.auto = session.auto === true;
        synapse.compacted = { at, summary: handover.text, messages: handover.messages };
        const created = await engine.createSession({
          title: path.basename(session.directory) || 'chat',
          model: session.model ? { ref: session.model, variant: session.variant || undefined } : undefined,
          directory: session.directory,
          permissions: session.single ? SINGLE_RULES : [],
          metadata: { ...meta, synapse },
        });
        if (!created?.id) {
          const err = new Error('the engine did not return a new conversation; nothing was deleted');
          err.status = 502;
          throw err;
        }
        try {
          permissionMemory?.carry?.(sessionId, created.id);
        } catch (err) {
          app.warn(`the Always Allow grants could not be carried to the new conversation: ${err.message}`);
        }
        try {
          await engine.deleteSession(sessionId);
        } catch (err) {
          // The new chat is live and the old one is now an orphan; the app shows
          // the new one, and the failure is in the log for a later sweep.
          app.warn(`the old conversation could not be deleted after a compact: ${err.message}`);
        }
        briefed.delete(sessionId);
        await brief(created.id, session.directory, 'architect', session.auto === true, {
          single: session.single === true,
        });
        app.info(
          `compacted ${sessionId} -> ${created.id}: ${handover.messages} messages, handover ${handover.text.length} chars`,
        );
        notify?.({
          kind: 'project',
          type: 'project.compacted',
          oldSessionId: sessionId,
          sessionId: created.id,
          directory: session.directory,
          at,
        });
        return {
          ok: true,
          sessionId: created.id,
          oldSessionId: sessionId,
          at,
          messages: handover.messages,
          summary: handover.text,
        };
      } finally {
        compacting.delete(sessionId);
      }
    },

    /**
     * The "keep building" switch: when on, the Architect is expected to keep
     * delegating the next ready task until the plan is done or a task is
     * blocked. It lives in the session metadata, so it is per session and it
     * survives a restart.
     */
    setAuto: async (sessionId, body) => {
      requireReady();
      const session = await engine.getSession(sessionId);
      const meta = session?.metadata && typeof session.metadata === 'object' ? session.metadata : {};
      const synapse = meta.synapse && typeof meta.synapse === 'object' ? meta.synapse : {};
      const auto = body?.auto === true;
      await engine.updateSessionMetadata(sessionId, { ...meta, synapse: { ...synapse, auto } });
      // The brief carries the mode, so the Architect hears about it on the very
      // next message rather than discovering it mid-run.
      await brief(sessionId, session?.directory, 'architect', auto);
      // Turning keep-building on is the operator saying "carry on", so a project
      // they stopped may run again.
      if (auto && session?.directory) runs?.resume?.(session.directory);
      app.info(`keep-building ${auto ? 'on' : 'off'} for ${sessionId}`);
      return { ok: true, auto };
    },

    /**
     * "Permission timeout": while it is on, a permission request left to the
     * operator is allowed once if nobody answers within a minute. It only ever
     * answers `ask` verdicts — a harness write or a credential store is denied by
     * the policy before a card exists, so the timeout cannot widen those.
     */
    /**
     * "Full auto": while it is on, a request left to the operator takes the
     * default after a minute — a permission card is allowed once, a question gets
     * the Recommended option (or the top one). It only ever answers `ask`
     * verdicts: a harness write or a credential store is denied before a card
     * exists, so it cannot widen those walls.
     */
    setFullAuto: async (sessionId, body) => {
      requireReady();
      const session = await engine.getSession(sessionId);
      const meta = session?.metadata && typeof session.metadata === 'object' ? session.metadata : {};
      const synapse = meta.synapse && typeof meta.synapse === 'object' ? meta.synapse : {};
      const enabled = body?.enabled === true;
      // One name from now on. The old key is dropped so a stale `permissionTimeout`
      // cannot disagree with `fullAuto` after a rename.
      const next = { ...synapse, fullAuto: enabled };
      delete next.permissionTimeout;
      await engine.updateSessionMetadata(sessionId, { ...meta, synapse: next });
      // Open cards and forms follow the switch at once.
      permissionGate?.setFullAuto?.(sessionId, enabled);
      formAuto.setFullAuto(sessionId, enabled);
      app.info(`full auto ${enabled ? 'on' : 'off'} for ${sessionId}`);
      notify?.({ kind: 'sessions', type: 'session.fullAuto', sessionId, enabled });
      return { ok: true, enabled };
    },

    /** One form sweep, called on a timer by the server. Exposed for tests. */
    autoAnswerTick: async () => formAuto.tick(),

    interrupt: async (sessionId) => {
      requireReady();
      // Stop means stop, for the whole project. A delegated task runs in its own
      // hidden session, and the session on screen (the Architect) is usually idle
      // while a worker works — interrupting it did nothing, and the run's report
      // woke the Architect to start the next task. Worse, a worker can outlive a
      // run record that has already reported or been cancelled, which is the
      // in-between state where Stop looked broken. The engine's active list is the
      // authority, not the run record.
      let directory = null;
      try {
        const session = await engine.getSession(sessionId);
        directory = session?.directory || null;
      } catch (err) {
        app.warn(`could not look up the session before stopping it: ${err.message}`);
      }

      let stoppedRun = false;
      if (directory) {
        try {
          stoppedRun = Boolean(runs?.cancel?.(directory));
        } catch (err) {
          app.warn(`could not cancel the run before stopping: ${err.message}`);
        }
        // No run in flight (the Architect was thinking): hold the project anyway,
        // or the next turn delegates the work that was just stopped.
        if (!stoppedRun) runs?.hold?.(directory);
      }

      let active = [];
      try {
        active = await engine.listActiveSessions();
      } catch { /* an engine without the list gets the asked session only */ }
      let sessions = [];
      try {
        sessions = await engine.listSessions();
      } catch { /* the target itself is still stopped */ }

      const targets = stopTargets({ sessionId, directory, active, sessions });
      const stopped = [];
      for (const id of targets) {
        try {
          await engine.interrupt(id);
          stopped.push(id);
        } catch (err) {
          app.warn(`could not interrupt ${id}: ${err.message}`);
        }
      }
      app.info(
        `stop: ${stopped.length} session(s) interrupted${stoppedRun ? ', run cancelled' : ''} in ${
          directory || 'an unknown directory'
        }`,
      );
      return { ok: true, stoppedRun, stopped };
    },

    permission: async (sessionId, body, actor = null) => {
      requireReady();
      const wanted = body?.decision || 'once';
      // The operator's own sentence, when a rejection carried one. Bounded and
      // flattened: it travels in a message to a model, and a 3,000-word essay
      // would become the next turn's prompt.
      const reason = String(body?.reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      // "Always" is ours, not the engine's. The engine's `always` saves the
      // request's `save` patterns for the whole project; for an edit those are
      // `*`, so one click would let the AI edit anything, including Synapse. We
      // answer once and remember this exact action + resource for the session.
      const decision = wanted === 'always' ? 'once' : wanted;
      const entry = permissionLog?.get?.(body?.requestId);
      // Two views can see the same card. The first answer is the answer; the
      // second is not an error, it is a page that was a moment late — it still
      // needs the decision broadcast so its panel closes.
      let already = false;
      try {
        await engine.replyPermission(sessionId, body?.requestId, decision);
      } catch (err) {
        if (/not found|already|gone|404|409/i.test(String(err?.message || ''))) {
          already = true;
        } else {
          throw err;
        }
      }
      // Answered here (or by another view): a pending permission-timeout must not
      // fire on a card that is already settled.
      permissionGate?.answered?.(body?.requestId);
      if (!already && decision === 'reject') {        // The reply's `message` is dropped on this route (measured), so the note
        // is a synthetic message: the only channel that reaches a worker. Not to
        // the Architect: the operator is in its chat, and the extra turn ended
        // with an empty message instead of its closing report (26 Oct).
        if (entry?.role && entry.role !== 'architect') {
          Promise.resolve(
            engine.synthetic?.(sessionId, refusalNote({ role: entry.role, scope: entry.scope, reason }), {
              description: 'permission refused',
            }),
          ).catch((err) => app.warn(`could not explain the refusal to ${sessionId}: ${err.message}`));
        }
      }
      if (!already && wanted === 'always' && entry) {
        permissionGate?.remember?.(entry.sessionId || sessionId, entry.action, entry.resources);
      }
      // The chip on the tool call: this is the moment an ask becomes a decision,
      // and the only one the policy did not already record. The operator's reason
      // rides it, so the transcript can say what they told the role.
      const answered = permissionLog?.answer?.(
        body?.requestId,
        decision,
        actor?.name || null,
        decision === 'reject' ? reason || null : null,
      );
      const by = actor?.name || null;
      if (answered) {
        notify?.({
          kind: 'permission',
          type: 'permission.decided',
          decision: { ...answered, by },
          requestId: body?.requestId,
          sessionId,
        });
      } else {
        notify?.({
          kind: 'permission',
          type: 'permission.decided',
          decision: { requestId: body?.requestId, sessionId, decision, effect: decision === 'reject' ? 'deny' : 'allow', by },
          requestId: body?.requestId,
          sessionId,
        });
      }
      return { ok: true, already };
    },

    /** Is this session's project busy, and why — what the composer shows. */
    busy: async (sessionId) => busyFor(sessionId),

    /** Decisions recorded for a session, for the chips on a transcript that was
     *  loaded after they happened. */
    permissionDecisions: async (sessionId) => ({
      decisions: sessionId ? permissionLog?.list?.(sessionId) || [] : [],
    }),

    /**
     * Everything currently waiting on the operator. A session blocked on a
     * permission or a form makes no progress and emits nothing, so this is the
     * only way to notice it after a reload.
     */
    pending: async (focusSessionId = null) => {
      if (!engine.status().ready) return { permissions: [], forms: [], active: [] };
      const [permissions, active] = await Promise.all([
        safe(() => engine.listPendingPermissions(), []),
        safe(() => engine.listActiveSessions(), []),
      ]);

      // Can Stop do anything for the session on screen? A hidden worker in the
      // same project counts, and it is the case the operator cannot see: the
      // Architect is idle, the run record may be gone, and the worker is still
      // working. Without this the button sat disabled while the project ran.
      let canStop = false;
      let activeHere = 0;
      if (focusSessionId && active.length) {
        try {
          const focus = await engine.getSession(focusSessionId);
          const directory = focus?.directory || null;
          if (directory) {
            const known = await engine.listSessions();
            const targets = stopTargets({ sessionId: focusSessionId, directory, active, sessions: known });
            activeHere = targets.filter((id) => active.includes(id)).length;
            canStop = activeHere > 0;
          }
        } catch { /* the button stays off rather than guessing */ }
      }

      // Forms have to be asked for per session. The engine's global list is
      // scoped to its *own* location (the workspace), so a form raised by a
      // session running in a project subfolder is not in it — which is why a
      // question from a project session used to be invisible while the session
      // sat there blocked. A session waiting on a form is exactly a session the
      // engine reports as active, and the session the operator has open is asked
      // for by name as well, so the panel is never wrong about what is on screen.
      const ask = [...new Set([...active, focusSessionId].filter(Boolean))];
      // Permissions have the same location scope as forms: the engine's global
      // list only covers its own directory, and every project session runs in a
      // subfolder of it. Without this, an ask raised inside a project never
      // reached the UI — measured 26 Oct: the global list was empty while the
      // session was blocked on a request it held. Ask the active sessions and the
      // open one directly, and merge by request id.
      const permissionLists = await Promise.all([
        Promise.resolve(permissions),
        ...ask.map((id) => safe(() => engine.listSessionPermissions(id), [])),
      ]);
      const allPermissions = [];
      const seenRequests = new Set();
      for (const list of permissionLists) {
        for (const p of list || []) {
          const id = p?.id || p?.requestID;
          if (!id || seenRequests.has(id)) continue;
          seenRequests.add(id);
          allPermissions.push(p);
        }
      }

      const lists = await Promise.all([
        safe(() => engine.listForms(), []),
        ...ask.map((id) => safe(() => engine.listForms(id), [])),
      ]);
      const forms = [];
      const seen = new Set();
      for (const list of lists) {
        for (const f of list || []) {
          if (!f?.id || seen.has(f.id)) continue;
          seen.add(f.id);
          forms.push(f);
        }
      }

      // A worker that asks the same question again is looping, not gathering
      // information. See guardQuestions: the second ask is answered for it, the
      // third stops the run and says so.
      const open = await guardQuestions(forms);

      // A permission request carries an action and a path, not a name. The card
      // has to say who is asking — a hidden worker's request is as real as the
      // open session's, and "coder-2, t4: write ..\..\Windows\x" is a different
      // decision from "something wants to write". The session is where the role,
      // the task and the directory live, so they are read here, once per request.
      const sessionIds = [...new Set(allPermissions.map((p) => p.sessionID).filter(Boolean))];
      const sessionInfo = new Map();
      await Promise.all(
        sessionIds.map(async (id) => {
          try {
            const s = await engine.getSession(id);
            if (s) sessionInfo.set(id, s);
          } catch { /* gone between the two calls */ }
        }),
      );

      return {
        permissions: allPermissions.map((p) => {
          const s = sessionInfo.get(p.sessionID);
          const meta = s?.metadata?.synapse || {};
          const directory = s?.directory || null;
          const action = p.action || p.title || 'tool call';
          const resources = Array.isArray(p.resources) ? p.resources : [];
          const isPath = /^(edit|write|read|patch|create)$/i.test(String(p.action || ''));
          const resolved =
            isPath && directory ? resources.map((r) => resolvePath(r, directory)?.path || String(r)) : [];
          const verdict = directory
            ? decide({ action, resources, cwd: directory, projectRoot: directory, harnessRoot: ROOT, scratchRoot: SCRATCH_ROOT })
            : null;
          return {
            requestId: p.id || p.requestID || null,
            sessionId: p.sessionID || null,
            action,
            resources,
            resolved,
            message: p.message || null,
            title: s?.title || null,
            role: meta.role || null,
            task: meta.task || null,
            directory,
            reason: verdict?.reason || '',
            scope: verdict?.scope || '',
            // A write request carries the diff the model is about to apply. That
            // is the difference between "a file" and "this exact change", and it
            // is the operator's best evidence when the card asks them to decide.
            files: Array.isArray(p.metadata?.files)
              ? p.metadata.files.map((f) => ({
                  file: f.file || '',
                  status: f.status || '',
                  patch: f.patch || '',
                  additions: Number(f.additions) || 0,
                  deletions: Number(f.deletions) || 0,
                }))
              : [],
          };
        }),
        forms: open.map((f) => ({
          id: f.id,
          sessionId: f.sessionID,
          title: f.title || 'Input needed',
          fields: Array.isArray(f.fields) ? f.fields : [],
        })),
        active,
        canStop,
        activeHere,
      };
    },

    replyForm: async (sessionId, formId, body, actor = null) => {
      requireReady();
      const answer = body?.answer && typeof body.answer === 'object' ? body.answer : {};
      // The form goes away once answered, so remember what it asked first.
      const form = await safe(() => engine.listForms(sessionId), []).then((list) => (list || []).find((f) => f.id === formId));
      await engine.replyForm(sessionId, formId, answer);
      // The other view's panel has to close: an answered question is a form that
      // no longer exists, and a page still showing it is a page waiting for a
      // reply nobody will send.
      notify?.({
        kind: 'form',
        type: 'form.answered',
        formId,
        sessionId,
        by: actor?.name || null,
      });
      const signature = formSignature(form);
      if (signature) {
        const per = questionHistory.get(sessionId) || new Map();
        per.set(signature, { answer, asks: 1 });
        questionHistory.set(sessionId, per);
      }
      // Written where the model can find it after a compact, which is the one
      // thing a deleted conversation cannot survive. Best-effort: a session
      // outside a project has no .synapse, and an answer already given is not
      // worth failing the reply over.
      try {
        const session = await safe(() => engine.getSession(sessionId), null);
        if (session?.directory && Array.isArray(form?.fields) && form.fields.length) {
          const written = appendProjectDecision(session.directory, { fields: form.fields, answer });
          if (written && written.ok === false) app.warn(`could not write the operator's answer: ${written.error}`);
        }
      } catch (err) {
        app.warn(`could not write the operator's answer to the project document: ${err.message}`);
      }
      return { ok: true };
    },

    toolStats: async () => (toolStats ? toolStats.snapshot() : { total: 0, failed: 0, tools: [], models: [] }),

    /** Clear the tool census. */
    clearToolStats: async () => {
      if (toolStats) toolStats.clear();
      app.info('tool census cleared');
      return { ok: true };
    },

    /** The probe's case list plus the state of the last run. */
    probe: async () => {
      const s = probe ? probe.state() : { running: false, results: [] };
      return {
        running: s.running,
        current: s.current,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        results: s.results,
        // Which model these results are for — the toolset is per model.
        model: s.model || null,
        // Which tools this model was given, as it reported them. Used to label
        // a "not called" verdict honestly; the panel lists only the cases.
        toolset: s.toolset || [],
        cases: probe ? probe.cases.map((c) => ({ id: c.id, tool: c.tool })) : [],
      };
    },

    /**
     * Kick off a probe run. It takes minutes, so this returns immediately and
     * the run reports progress over the event stream. The run itself must NOT
     * be awaited here or the request would hang until every case finished.
     */
    runProbe: async () => {
      requireReady();
      if (!probe) return { started: false, reason: 'No probe available.' };
      if (probe.state().running) return { started: false, reason: 'A probe is already running.' };
      probe.run().catch((err) => app.error(`probe crashed: ${err.message}`));
      return { started: true };
    },
  };
}
