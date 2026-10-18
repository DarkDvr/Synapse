// Synapse API — a stable, engine-agnostic surface for the UI.
// Handlers call the engine adapter; nothing here knows about OpenCode.
import { TBD_TITLE } from './titles.js';

export function createApi({ getConfig, applyConfig, engine, logger, getBootError, projects, toolStats, probe, modelCache, inspectModel: inspectRef }) {
  const app = logger.channel('app');

  /** Directory comparison key: case-insensitive, no trailing separator. */
  const dirKey = (d) => String(d ?? '').replace(/[\\/]+$/, '').toLowerCase();

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
        models: list.map((m) => ({ ...m, tools: modelCache?.get(m.ref)?.tools || null })),
      };
    },

    /** The raw per-model knowledge base, for inspection and debugging. */
    modelCache: async () => (modelCache ? modelCache.snapshot() : { version: 1, models: {} }),

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

    sessions: async () => {
      if (!engine.status().ready) return { sessions: [] };
      return { sessions: await engine.listSessions() };
    },

    // ── projects ─────────────────────────────────────────────
    projects: async () => ({ projects: await projectsWithSessions() }),

    createProject: async (body) => {
      const project = projects.create({ name: body?.name, directory: body?.directory });
      return { project: (await projectsWithSessions()).find((p) => p.id === project.id) || project };
    },

    updateProject: async (id, body) => {
      const project = projects.update(id, { name: body?.name });
      return { project };
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
        permissions: body?.permissions,
        directory: project.directory,
      });
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
        await engine.updateSessionPermissions(sessionId, Array.isArray(p) ? p : []);
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
      return { ok: true };
    },

    messages: async (sessionId) => {
      requireReady();
      return { messages: await engine.getMessages(sessionId) };
    },

    sendMessage: async (sessionId, body) => {
      requireReady();
      const text = String(body?.text ?? '').trim();
      if (!text) {
        const err = new Error('message text is required');
        err.status = 400;
        throw err;
      }
      await engine.prompt(sessionId, text);
      return { ok: true };
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
    pending: async () => {
      if (!engine.status().ready) return { permissions: [], forms: [], active: [] };
      const safe = async (fn, fallback) => {
        try { return await fn(); } catch (err) { app.warn(`pending: ${err.message}`); return fallback; }
      };
      const [permissions, forms, active] = await Promise.all([
        safe(() => engine.listPendingPermissions(), []),
        safe(() => engine.listForms(), []),
        safe(() => engine.listActiveSessions(), []),
      ]);
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
        // Which tools this model was given, as it reported them. Shown in the
        // panel so a "not called" verdict is not read as a model failure.
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
