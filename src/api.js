// Synapse API — a stable, engine-agnostic surface for the UI.
// Handlers call the engine adapter; nothing here knows about OpenCode.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { TBD_TITLE } from './titles.js';
import { ensurePlan, readPlan, readRuns, briefSession, logPlanState, BRIEF_KEY, appendRequirement } from './plans.js';
import { skillRules, describeSkills } from './skills.js';
import { PROJECTS_ROOT, SKILLS_DIR } from './paths.js';
import { fetchProviderModels } from './providers.js';

export function createApi({ getConfig, applyConfig, engine, logger, getBootError, projects, toolStats, probe, modelCache, inspectModel: inspectRef, probeDir, runs, engineUpdate, notify, guard }) {
  const app = logger.channel('app');

  // The last brief we handed each session, so an unchanged plan does not PUT
  // the same text again on every message.
  const briefed = new Map();

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
    }
    return c;
  };

  // When the UI saves config with an empty password, keep the existing one.
  function reconcile(incoming) {
    const next = structuredClone(incoming || {});
    if (next.engine?.opencode) {
      const provided = next.engine.opencode.password;
      if (provided === undefined || provided === null || provided === '') {
        next.engine.opencode.password = getConfig().engine?.opencode?.password || '';
      }
      delete next.engine.opencode.passwordSet;
    }
    return next;
  }

  const requireReady = () => {
    const st = engine.status();
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
    // operator's click is the only reason this contacts anything — see
    // src/providers.js.
    providerModels: async (body) => fetchProviderModels(body || {}),

    // The engine updates often and the model catalog ships inside it, so this is
    // the one place Synapse will talk to the network for something other than a
    // model — and only because the operator asked. `check` without `online` is
    // free: it reads the engine, the desktop's own version file and the cache.
    engineUpdate: async () => engineUpdate.check({ online: false }),
    checkEngineUpdate: async () => engineUpdate.check({ online: true }),
    updateEngine: async () => engineUpdate.update(),

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

    deleteSession: async (sessionId) => {
      requireReady();
      await engine.deleteSession(sessionId);
      briefed.delete(sessionId);
      // Tell every open UI. Another tab can have it on screen, and a UI left
      // holding a deleted session answers 404 on every control it offers —
      // which is how a mode switch ended up reporting "Session not found".
      notify?.({ kind: 'sessions', type: 'session.deleted', sessionId });
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
      // How long each step has actually taken: the sum of every completed run for
      // that task, which is the only honest source (the pane's own clock only sees
      // the time this browser has been open). A step in flight adds its own
      // elapsed time on top — the UI already has the live run and its start.
      const spent = {};
      if (directory) {
        for (const record of readRuns(directory)) {
          if (record.kind !== 'result' || !record.task) continue;
          const ms = Number(record.ms);
          if (ms > 0) spent[record.task] = (spent[record.task] || 0) + ms;
        }
      }
      return { ...state, used: usedRoles(directory, sessionId), spent };
    },

    sendMessage: async (sessionId, body) => {
      requireReady();
      const text = String(body?.text ?? '').trim();
      if (!text) {
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
      if (directory) appendRequirement(directory, text);
      await engine.prompt(sessionId, text);
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
      app.info(`keep-building ${auto ? 'on' : 'off'} for ${sessionId}`);
      return { ok: true, auto };
    },

    interrupt: async (sessionId) => {
      requireReady();
      await engine.interrupt(sessionId);
      return { ok: true };
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
      const safe = async (fn, fallback) => {
        try { return await fn(); } catch (err) { app.warn(`pending: ${err.message}`); return fallback; }
      };
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

      return {
        permissions: permissions.map((p) => ({
          requestId: p.id || p.requestID || null,
          sessionId: p.sessionID || null,
          action: p.action || p.title || 'tool call',
          resources: Array.isArray(p.resources) ? p.resources : [],
          message: p.message || null,
        })),
        forms: forms.map((f) => ({
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
      await engine.replyForm(sessionId, formId, answer);
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
