// Synapse API — a stable, engine-agnostic surface for the UI.
// Handlers call the engine adapter; nothing here knows about OpenCode.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { TBD_TITLE } from './titles.js';
import { ensurePlan, readPlan, readRuns, briefSession, logPlanState, BRIEF_KEY, appendRequirement, appendAnswers } from './plans.js';
import { skillRules, describeSkills } from './skills.js';
import { PROJECTS_ROOT, SKILLS_DIR } from './paths.js';
import { fetchProviderModels } from './providers.js';
import { providerId } from './providers.js';
import { isLocalProvider, providerUp } from './providers.js';
import { providerApiKey } from './config.js';
import { questionSignature, guardDecision, readableAnswer } from './question-loop.js';
import { setProviderKey, providerKeyState, maskKey } from './secrets.js';
import { probeToolchain } from './toolchain.js';

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

export function createApi({ getConfig, applyConfig, engine, logger, getBootError, projects, toolStats, probe, modelCache, inspectModel: inspectRef, probeDir, runs, engineUpdate, restart, notify, guard }) {
  const app = logger.channel('app');

  // The last brief we handed each session, so an unchanged plan does not PUT
  // the same text again on every message.
  const briefed = new Map();

  // Is each local model server answering, and when did we last ask. Four seconds:
  // the sidebar polls, and a dead port must not be retried on every tick.
  const healthCache = new Map();

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
  async function brief(sessionId, directory, role, auto = false) {
    try {
      const text = briefSession({
        dir: directory,
        role,
        auto,
        skills: describeSkills(getConfig(), role),
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
   * whose directory it runs in; anything unrecognised lands in General, which
   * is always first.
   */
  async function projectsWithSessions() {
    const list = projects.list().map((p) => ({ ...p, sessions: [] }));
    if (!engine.status().ready) return list;

    const byDir = new Map(list.map((p) => [dirKey(p.directory), p]));
    const general = list[0];
    let sessions = [];
    try {
      sessions = await engine.listSessions();
    } catch (err) {
      app.warn(`could not list sessions: ${err.message}`);
    }
    for (const s of sessions) {
      if (isScratchSession(s)) continue; // probe/model-check scaffolding
      const owner = byDir.get(dirKey(s.directory)) || general;
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

  /**
   * Remove a project's `.synapse` — its plan, requirement, answers, ideas, design,
   * findings and run log.
   *
   * It is the *project's* memory, not a session's, which is why deleting a session
   * never touched it: a new session in the same folder opens the same plan, and
   * after the last session was deleted that looks exactly like a fresh session
   * inheriting a dead one. The operator may ask for it to go, and the asking is
   * guarded: only inside the projects root, only when no other session uses the
   * folder, and never while a run is in flight there.
   */
  async function forgetProjectPlan(directory) {
    const dir = path.resolve(String(directory || ''));
    const rel = path.relative(PROJECTS_ROOT, dir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, reason: `${dir} is not inside the projects root` };
    }
    const target = path.join(dir, '.synapse');
    if (!fs.existsSync(target)) return { ok: false, reason: 'this project has no .synapse to forget' };
    if ((runs?.active?.() || []).some((r) => path.resolve(r.dir || '') === dir)) {
      return { ok: false, reason: 'a run is still working in this project' };
    }
    let others = [];
    try {
      others = (await engine.listSessions()).filter(
        (s) => !s.internal && path.resolve(s.directory || '') === dir,
      );
    } catch {
      return { ok: false, reason: 'could not list the sessions in this project' };
    }
    // The session being deleted is still in the list, so more than one means the
    // plan belongs to somebody else too.
    if (others.length > 1) {
      return { ok: false, reason: `${others.length} sessions still use this project` };
    }
    try {
      fs.rmSync(target, { recursive: true, force: true });
      app.info(`forgot the plan and scratch of ${dir}`);
      return { ok: true, directory: dir };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

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

  const requireReady = () => {    const st = engine.status();
    if (!st.ready) {
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
      return toClientConfig(saved);
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

    sessions: async () => {
      if (!engine.status().ready) return { sessions: [] };
      const sessions = await engine.listSessions();
      return { sessions: sessions.filter((s) => !isScratchSession(s)) };
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

    deleteProject: async (id) => {
      const current = projects.find(id);
      if (!current) {
        const err = new Error('project not found');
        err.status = 404;
        throw err;
      }
      if (current.general) {
        const err = new Error('General is always present and cannot be removed.');
        err.status = 400;
        throw err;
      }
      // A project owns its sessions; refuse to orphan them.
      const withSessions = (await projectsWithSessions()).find((p) => p.id === id);
      if (withSessions?.sessions?.length) {
        const n = withSessions.sessions.length;
        const err = new Error(
          `"${current.name}" still has ${n} session${n === 1 ? '' : 's'}. Delete ${n === 1 ? 'it' : 'them'} first — Synapse will not leave sessions without a project.`,
        );
        err.status = 409;
        throw err;
      }
      projects.remove(id);
      // And let the engine go of the directory. It keeps a location "loaded" once
      // it has served a turn there, and that handle is what made a finished
      // project's folder undeletable until Synapse was stopped. `DELETE
      // /api/debug/location` disposes a location's cached services; the folder is
      // then the operator's to delete, which is the whole point.
      try {
        await engine.evictLocation?.(current.directory);
      } catch (err) {
        app.warn(`could not release ${current.directory} from the engine: ${err.message}`);
      }
      return { ok: true };
    },

    createSession: async (body) => {
      requireReady();
      const project = body?.projectId ? projects.find(body.projectId) : projects.general();
      if (!project) {
        const err = new Error('project not found');
        err.status = 404;
        throw err;
      }
      const session = await engine.createSession({
        title: TBD_TITLE,
        model: body?.model,
        agent: body?.agent,
        // The harness guard rides along with whatever rules the caller asked for:
        // a session may be Single (deny `subagent`) or Multi (no rules), and the
        // harness is denied in both. The role's skill list comes last, because
        // the engine takes the last matching rule and its allow must win.
        permissions: [
          ...(Array.isArray(body?.permissions) ? body.permissions : []),
          ...(guard?.rules?.() || []),
          ...skillRules(getConfig(), 'architect'),
        ],
        directory: project.directory,
      });
      // From the first turn, the Architect knows where it is and that the plan
      // file is its own to keep.
      await brief(session.id, project.directory, 'architect', false);
      // A new session is a new piece of work, and the census is a picture of what
      // the models are doing *now*: left to accumulate it describes a machine that
      // no longer exists. The operator opens the popup to answer "what is being
      // called", not "what has ever been called".
      if (toolStats) toolStats.clear();
      return { session, projectId: project.id };
    },

    /**
     * PATCH a session. `title` renames it; `permissions` replaces its ruleset —
     * which is how Single↔Multi flips an open session without recreating it.
     */
    updateSession: async (sessionId, body) => {
      requireReady();
      const hasPermissions = body !== null && typeof body === 'object' && 'permissions' in body;
      const hasTitle = body !== null && typeof body === 'object' && body.title !== undefined;
      if (!hasPermissions && !hasTitle) {
        const err = new Error('nothing to update');
        err.status = 400;
        throw err;
      }
      if (hasPermissions) {
        const p = body.permissions;
        if (p !== null && !Array.isArray(p)) {
          const err = new Error('permissions must be an array or null');
          err.status = 400;
          throw err;
        }
        await engine.updateSessionPermissions(sessionId, [
          ...(Array.isArray(p) ? p : []),
          ...(guard?.rules?.() || []),
          ...skillRules(getConfig(), 'architect'),
        ]);
      }
      if (hasTitle) {
        const title = String(body.title ?? '').trim();
        if (!title) {
          const err = new Error('a session needs a title');
          err.status = 400;
          throw err;
        }
        await engine.updateSessionTitle(sessionId, title);
      }
      return { ok: true };
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

    deleteSession: async (sessionId, { forget = false } = {}) => {
      requireReady();
      // A run that still holds this session stops first. A worker finishing into a
      // deleted session, or a wake aimed at one, used to surface as "404 Session
      // not found" on the Architect card and was retried as if the server were
      // busy. Deleting the session is the operator ending that run, so it ends
      // here, as stopped.
      try { runs?.stopWithReason?.(sessionId, 'the session was deleted'); } catch { /* nothing running */ }
      // Where it lived, and whether anything else lives there, read before the
      // session goes: a plan is the project's, not the session's, and it is only
      // the operator's to throw away when no other session can lose it.
      let forgetResult = null;
      if (forget) {
        let directory = null;
        try { directory = (await engine.getSession(sessionId))?.directory || null; } catch { /* gone already */ }
        forgetResult = directory ? await forgetProjectPlan(directory) : { ok: false, reason: 'the session has no directory' };
      }
      await engine.deleteSession(sessionId);
      briefed.delete(sessionId);
      // Tell every open UI. Another tab can have it on screen, and a UI left
      // holding a deleted session answers 404 on every control it offers —
      // which is how a mode switch ended up reporting "Session not found".
      notify?.({ kind: 'sessions', type: 'session.deleted', sessionId });
      return { ok: true, forgotten: forgetResult };
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
      // How long each step has actually taken: the sum of every completed run for
      // that task, which is the only honest source (the pane's own clock only sees
      // the time this browser has been open). A step in flight adds its own
      // elapsed time on top — the UI already has the live run and its start.
      const spent = {};
      const reported = new Set();
      if (directory) {
        for (const record of readRuns(directory)) {
          if (record.kind !== 'result' || !record.task) continue;
          const ms = Number(record.ms);
          if (ms > 0) spent[record.task] = (spent[record.task] || 0) + ms;
          if (record.outcome === 'completed') reported.add(record.task);
        }
      }
      // `reported` is the middle state: the worker has handed its result back and
      // the Architect has not judged it yet, so the plan file still says `todo`.
      // Without it the step loses its highlight the moment the run ends and looks
      // like it was never done - the operator read that as a revert.
      return { ...state, used: usedRoles(directory, sessionId), spent, reported: [...reported] };
    },

    sendMessage: async (sessionId, body) => {
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
      // Re-brief before the turn: the plan may have changed since the last one,
      // and an unchanged plan is not sent twice.
      let directory = '';
      try {
        const session = await engine.getSession(sessionId);
        directory = session?.directory || '';
        await brief(sessionId, directory, 'architect', session?.auto === true);
      } catch (err) {
        app.warn(`brief skipped for ${sessionId}: ${err.message}`);
      }
      // The operator's own words, written down before any model can restate
      // them. This file is the requirement every role is judged against.
      if (directory) appendRequirement(directory, text || `(attached ${attachments.length} file(s))`);
      // Speaking is the answer to "what now" after a stop: whatever they stopped
      // may run again from here.
      if (directory) runs?.resume?.(directory);
      await engine.prompt(sessionId, text, { files: attachments });
      return { ok: true };
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

    interrupt: async (sessionId) => {
      requireReady();
      // Stop means stop. A delegated task runs in its own worker session, so
      // interrupting the session on screen did nothing to it: the worker carried
      // on to the end, the Architect was woken by the report and started the next
      // task. The operator saw a run that would not stop. Stop the run first — it
      // is the thing that is actually working — then the session.
      let stoppedRun = false;
      try {
        const session = await engine.getSession(sessionId);
        if (session?.directory) {
          stoppedRun = Boolean(runs?.cancel?.(session.directory));
          // No run in flight (the Architect was thinking): hold the project anyway,
          // or the next turn delegates the work that was just stopped.
          if (!stoppedRun) runs?.hold?.(session.directory);
        }
      } catch (err) {
        app.warn(`could not look up the session before stopping it: ${err.message}`);
      }
      await engine.interrupt(sessionId);
      return { ok: true, stoppedRun };
    },

    permission: async (sessionId, body) => {
      requireReady();
      await engine.replyPermission(sessionId, body?.requestId, body?.decision || 'once');
      return { ok: true };
    },

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

      // Forms have to be asked for per session. The engine's global list is
      // scoped to its *own* location (the workspace), so a form raised by a
      // session running in a project subfolder is not in it — which is why a
      // question from a project session used to be invisible while the session
      // sat there blocked. A session waiting on a form is exactly a session the
      // engine reports as active, and the session the operator has open is asked
      // for by name as well, so the panel is never wrong about what is on screen.
      const ask = [...new Set([...active, focusSessionId].filter(Boolean))];
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

      return {
        permissions: permissions.map((p) => ({
          requestId: p.id || p.requestID || null,
          sessionId: p.sessionID || null,
          action: p.action || p.title || 'tool call',
          resources: Array.isArray(p.resources) ? p.resources : [],
          message: p.message || null,
        })),
        forms: open.map((f) => ({
          id: f.id,
          sessionId: f.sessionID,
          title: f.title || 'Input needed',
          fields: Array.isArray(f.fields) ? f.fields : [],
        })),
        active,
      };
    },

    replyForm: async (sessionId, formId, body) => {
      requireReady();
      const answer = body?.answer && typeof body.answer === 'object' ? body.answer : {};
      // The form goes away once answered, so remember what it asked first.
      const form = await safe(() => engine.listForms(sessionId), []).then((list) => (list || []).find((f) => f.id === formId));
      await engine.replyForm(sessionId, formId, answer);
      const signature = formSignature(form);
      if (signature) {
        const per = questionHistory.get(sessionId) || new Map();
        per.set(signature, { answer, asks: 1 });
        questionHistory.set(sessionId, per);
      }
      // Written where the model can find it after a compaction, which is the one
      // thing the transcript cannot survive. Best-effort: a session outside a
      // project has no .synapse, and an answer already given is not worth failing
      // the reply over.
      try {
        const session = await safe(() => engine.getSession(sessionId), null);
        if (session?.directory && Array.isArray(form?.fields) && form.fields.length) {
          appendAnswers(session.directory, { signature, fields: form.fields, answer });
        }
      } catch (err) {
        app.warn(`could not write the operator's answer to decisions.md: ${err.message}`);
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
