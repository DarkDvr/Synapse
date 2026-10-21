// OpenCode engine adapter.
// Talks to the genuine `opencode serve` HTTP API + event stream over Basic auth.
// Nothing here is OpenCode-specific outside this file — swap this module to
// replace the engine.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  Engine,
  classifyEvent,
  normalizeMessage,
  normalizeModel,
  normalizeSession,
  parseModelRef,
} from './base.js';
import { SEARCH_SERVER, DELEGATE_SERVER, ENGINE_PID_FILE, SKILLS_DIR } from '../paths.js';
import { providerApiKey } from '../config.js';

const ENGINE_USERNAME = 'opencode';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class OpenCodeEngine extends Engine {
  constructor(config = {}, ctx = {}) {
    super(config, ctx);
    this.kind = 'opencode';
    this.cfg = config;
    this.log = ctx.logger.channel('engine');
    this.sessionLog = ctx.logger.channel('session');
    this.toolLog = ctx.logger.channel('tools');
    this.workspaceDir = ctx.workspaceDir;
    this.dataDir = ctx.dataDir;
    this.proc = null;
    this.password = '';
    this.base = '';
    this.ready = false;
    this.version = null;
    this._streamAbort = null;
    this._stopping = false;
  }

  // ── discovery ────────────────────────────────────────────────

  resolveBinary() {
    const explicit = (this.cfg.binary || '').trim();
    if (explicit) return explicit;
    const candidates = [];
    if (process.env.APPDATA) {
      candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'));
    }
    if (process.env.USERPROFILE) {
      candidates.push(path.join(process.env.USERPROFILE, '.opencode', 'bin', 'opencode.exe'));
    }
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', '@opencode', 'bin', 'opencode.exe'));
    }
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
    }
    return process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  }

  resolveHome() {
    const base = (this.cfg.home && this.cfg.home.trim()) || path.join(this.dataDir, 'engine', 'opencode');
    return {
      base,
      config: path.join(base, 'config'),
      data: path.join(base, 'data'),
      state: path.join(base, 'state'),
      tmp: path.join(base, 'tmp'),
      passwordFile: path.join(base, 'password.txt'),
    };
  }

  resolvePassword(home) {
    if (this.cfg.password) return this.cfg.password;
    try {
      const existing = fs.readFileSync(home.passwordFile, 'utf8').trim();
      if (existing) return existing;
    } catch { /* not created yet */ }
    const pw = randomBytes(24).toString('base64url');
    fs.mkdirSync(home.base, { recursive: true });
    fs.writeFileSync(home.passwordFile, pw, 'utf8');
    return pw;
  }

  /**
   * Register Synapse's own MCP servers in the engine's isolated config. The
   * engine reads <XDG_CONFIG_HOME>/opencode/opencode.json, which is inside our
   * home, so this is self-contained and never touches the machine-wide config.
   *
   * This is how the local search reaches the models: the engine's built-in
   * `websearch` needs a provider key and answers HTTP 403 here, so we hand it a
   * working one instead. Any other config already in that file is preserved.
   */
  ensureEngineConfig(home) {
    const cfgFile = path.join(home.config, 'opencode', 'opencode.json');
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8') || '{}'); } catch { cfg = {}; }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};

    // Rebuild the parts we own, so an older shape written by a previous version
    // cannot linger alongside the new one.
    const servers = { ...((cfg.mcp || {}).servers || {}) };
    delete servers.synapse;
    delete servers['synapse-search'];
    delete servers['synapse-delegate'];
    // A server that no longer exists: the plan became a file the Architect owns
    // (src/plans.js), so the entry must not linger pointing at a deleted file.
    delete servers['synapse-plan'];

    // Our search, unless the operator switched it off. This used to return early
    // from the whole function, which also cost them the model limit overrides
    // below — so the guard wraps the server, not the config write.
    if (this.cfg.localSearch !== false) {
      servers['synapse-search'] = {
        type: 'local',
        command: [process.execPath, SEARCH_SERVER],
        // Without this the engine exposes MCP tools through its code-mode tool as
        // `tools["synapse-search"].websearch`, and the model tries to call that
        // literal string as a tool name. Off, it is a normal tool.
        codemode: false,
      };
    }

    // How the Architect hands a plan task to the role that owns it. The request
    // is read back out of the transcript by the harness (see src/runs.js).
    servers['synapse-delegate'] = {
      type: 'local',
      command: [process.execPath, DELEGATE_SERVER],
      codemode: false,
    };

    const legacyMcp = { ...(cfg.mcp || {}) };
    delete legacyMcp['synapse-search'];
    delete legacyMcp['synapse-delegate'];
    delete legacyMcp['synapse-plan'];
    delete legacyMcp.synapse;

    const next = {
      ...cfg,
      $schema: cfg.$schema || 'https://opencode.ai/config.json',
      // The engine's built-in search needs a provider key and answers HTTP 403
      // on this machine. Switching it off leaves exactly one search tool — ours
      // — so the model cannot pick the broken one by accident.
      websearch: false,
      mcp: { ...legacyMcp, servers },
    };

    // Per-model limit overrides. The engine's catalog is conservative for some
    // free models: DeepSeek V4.1 Flash Free advertises 200k context, but the
    // backend serves the full 1,048,576 (boundary-tested — see AGENTS.md). The
    // override only changes the engine's local budgeting/compaction ceiling;
    // whatever the provider enforces still applies.
    const limits = this.cfg.modelLimits || {};
    const limitIds = Object.keys(limits);
    if (limitIds.length) {
      const providers = { ...(cfg.providers || {}) };
      const opencode = { ...(providers.opencode || {}) };
      const models = { ...(opencode.models || {}) };
      for (const id of limitIds) {
        const existing = models[id] || {};
        models[id] = { ...existing, limit: { ...(existing.limit || {}), ...limits[id] } };
      }
      opencode.models = models;
      providers.opencode = opencode;
      next.providers = providers;
    }

    // Other model servers — a local LLM, a second vendor — declared in Synapse's
    // config and handed to the engine as OpenAI-compatible providers. The engine
    // reads `provider` (singular) for definitions and `providers` (plural) for
    // per-provider overrides; getting those two names the wrong way round is
    // silent, so both are written deliberately and only these keys are ours.
    const providers = Array.isArray(this.cfg.providers) ? this.cfg.providers : [];
    const registrable = providers.filter((p) => (p.models || []).length);
    if (registrable.length) {
      const defs = { ...(cfg.provider || {}) };
      for (const p of registrable) {
        const models = {};
        for (const m of p.models) {
          models[m.id] = {
            name: m.name,
            ...(m.context || m.output
              ? { limit: { ...(m.context ? { context: m.context } : {}), ...(m.output ? { output: m.output } : {}) } }
              : {}),
          };
        }
        // The key travels as the engine's `apiKey`, resolved here rather than in
        // the engine: a missing variable is then a sentence in our log instead of
        // an unexplained 401 on the first turn. The value is never logged.
        const key = providerApiKey(p);
        if (key.missing) {
          this.log.warn(
            `${p.name || p.id}: ${key.source} is not set - its models will be refused until you set it and restart Synapse`,
          );
        }
        defs[p.id] = {
          npm: p.npm || '@ai-sdk/openai-compatible',
          name: p.name || p.id,
          options: { baseURL: p.baseURL, ...(key.key ? { apiKey: key.key } : {}) },
          models,
        };
      }
      next.provider = defs;
    }

    // Skills Synapse ships, plus any folder the operator adds.
    //
    // The engine also reads `~/.agents/skills` by default — that is where the
    // operator's own library lives, and it keeps working for every other app.
    // When a name exists in both, the *configured* copy is the one loaded
    // (measured on 2.0.30 with a distinct description in each copy, after a
    // restart), so Synapse uses what it ships while the global library stays put.
    const configured = Array.isArray(this.cfg.skillPaths) ? this.cfg.skillPaths.filter(Boolean) : [];
    const skillPaths = [SKILLS_DIR, ...configured.filter((p) => path.resolve(String(p)) !== SKILLS_DIR)];
    if (skillPaths.length) next.skills = { paths: skillPaths };
    else delete next.skills;

    // "Chat" mode is a deny-all permission ruleset on an ordinary session, not a
    // custom agent — see isChatSession() in base.js for why.
    delete next.agents;

    try {
      fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
      const body = `${JSON.stringify(next, null, 2)}\n`;
      const current = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : '';
      if (current !== body) {
        fs.writeFileSync(cfgFile, body, 'utf8');
        this.log.info(
          `engine config: ${this.cfg.localSearch === false ? 'search disabled' : 'local search registered'}` +
            `, built-in websearch disabled` +
            (skillPaths.length ? `, ${skillPaths.length} skill path(s)` : '') +
            (limitIds.length ? `, ${limitIds.length} model limit override(s)` : ''),
        );
      }
    } catch (err) {
      this.log.warn(`could not write the engine config: ${err.message}`);
    }
  }

  /**
   * Record the engine's PID so a restart can stop exactly this process.
   * Never match on process name — see ENGINE_PID_FILE in paths.js.
   */
  writeEnginePid() {
    try {
      if (this.proc?.pid) fs.writeFileSync(ENGINE_PID_FILE, String(this.proc.pid), 'utf8');
    } catch (err) {
      this.log.warn(`could not write the engine pid: ${err.message}`);
    }
  }

  clearEnginePid() {
    try { fs.rmSync(ENGINE_PID_FILE, { force: true }); } catch { /* ignore */ }
  }

  // ── lifecycle ────────────────────────────────────────────────

  async start() {
    this._stopping = false;
    const binary = this.resolveBinary();
    const home = this.resolveHome();
    for (const d of ['config', 'data', 'state', 'tmp']) fs.mkdirSync(path.join(home.base, d), { recursive: true });
    fs.mkdirSync(this.workspaceDir, { recursive: true });

    this.password = this.resolvePassword(home);
    this.base = `http://${this.cfg.host}:${this.cfg.port}`;
    this.ensureEngineConfig(home);

    const args = ['serve', '--port', String(this.cfg.port), '--hostname', this.cfg.host, ...(this.cfg.args || [])];
    const env = {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: this.password,
      XDG_CONFIG_HOME: home.config,
      XDG_DATA_HOME: home.data,
      XDG_STATE_HOME: home.state,
      TMPDIR: home.tmp,
    };

    this.log.info(`engine binary: ${binary}`);
    this.log.info(`engine home:   ${home.base}`);
    this.log.info(`workspace:     ${this.workspaceDir}`);

    this.proc = spawn(binary, args, {
      cwd: this.workspaceDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.writeEnginePid();
    this.proc.stdout?.on('data', (d) => this.log.debug('stdout: ' + String(d).trim()));
    this.proc.stderr?.on('data', (d) => this.log.debug('stderr: ' + String(d).trim()));
    this.proc.on('error', (err) => this.log.error(`failed to launch engine: ${err.message}`));
    this.proc.on('exit', (code, signal) => {
      this.ready = false;
      this.clearEnginePid();
      if (!this._stopping) this.log.error(`engine exited unexpectedly (code=${code} signal=${signal})`);
      this.emit('exit', { code, signal });
    });

    await this.waitReady(this.cfg.startTimeoutMs);
    this.connectStream();
    return this.status();
  }

  async waitReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;
    while (Date.now() < deadline) {
      if (this.proc && this.proc.exitCode !== null) {
        throw new Error(`engine exited during startup (code ${this.proc.exitCode})`);
      }
      try {
        const info = await this.request('GET', '/api/info');
        this.version = info?.version || info?.data?.version || null;
        this.ready = true;
        this.log.info(`engine ready${this.version ? ' (v' + this.version + ')' : ''} at ${this.base}`);
        return;
      } catch (err) {
        lastErr = err;
        await sleep(400);
      }
    }
    throw new Error(`engine did not become ready within ${timeoutMs}ms${lastErr ? ': ' + lastErr.message : ''}`);
  }

  async stop() {
    this._stopping = true;
    try { this._streamAbort?.abort(); } catch { /* ignore */ }
    this._streamAbort = null;
    const proc = this.proc;
    this.proc = null;
    this.ready = false;
    this.clearEnginePid();
    if (!proc || proc.exitCode !== null) return;
    this.log.info('stopping engine...');
    if (process.platform === 'win32' && proc.pid) {
      await new Promise((resolve) => execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], () => resolve()));
    } else {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 4000);
      proc.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }

  status() {
    return {
      kind: 'opencode',
      ready: this.ready,
      version: this.version,
      endpoint: this.base || null,
      pid: this.proc?.pid ?? null,
      binary: this.resolveBinary(),
      home: this.resolveHome().base,
      workspace: this.workspaceDir,
    };
  }

  // ── transport ────────────────────────────────────────────────

  authHeader() {
    return 'Basic ' + Buffer.from(`${ENGINE_USERNAME}:${this.password}`).toString('base64');
  }

  async request(method, apiPath, body, { directory } = {}) {
    const headers = { authorization: this.authHeader() };
    const dir = directory || this.workspaceDir;
    if (dir) headers['x-opencode-directory'] = encodeURIComponent(dir);
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(this.base + apiPath, { method, headers, body: payload });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) {
      const detail = json?.error?.message || json?.message || (json?.error ? JSON.stringify(json.error) : text.slice(0, 300));
      throw new Error(`${method} ${apiPath} -> ${res.status}${detail ? ' ' + detail : ''}`);
    }
    return json;
  }

  // ── capabilities ─────────────────────────────────────────────

  async listModels() {
    const r = await this.request('GET', '/api/model');
    const data = Array.isArray(r?.data) ? r.data : [];
    return data.map(normalizeModel);
  }

  /** The model a session gets when it has no explicit selection. */
  async getDefaultModel() {
    const r = await this.request('GET', '/api/model/default');
    return r?.data ? normalizeModel(r.data) : null;
  }

  /** The skills the engine can see. Name and description only — the per-role
   *  picker needs nothing else, and a skill's folder is not the UI's business. */
  async listSkills() {
    const r = await this.request('GET', '/api/skill');
    const data = Array.isArray(r?.data) ? r.data : Array.isArray(r) ? r : [];
    return data
      .map((s) => ({
        name: String(s?.name || s?.id || '').trim(),
        description: String(s?.description || '').trim(),
      }))
      .filter((s) => s.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listAgents() {
    const r = await this.request('GET', '/api/agent');
    const data = Array.isArray(r?.data) ? r.data : [];
    return data
      .filter((a) => !a.hidden)
      .map((a) => ({
        id: a.id || a.name || '',
        name: a.name || a.id || '',
        description: a.description || '',
        mode: a.mode || null,
        primary: a.mode === 'primary',
        raw: a,
      }));
  }

  // ── sessions ─────────────────────────────────────────────────

  async listSessions() {
    const r = await this.request('GET', '/api/session');
    const data = Array.isArray(r?.data) ? r.data : [];
    return data.map(normalizeSession);
  }

  async getSession(sessionId) {
    const r = await this.request('GET', `/api/session/${encodeURIComponent(sessionId)}`);
    return normalizeSession(r?.data || {});
  }

  /**
   * Attach or replace one durable instruction entry on a session.
   *
   * This is the engine's own channel for standing context: per session, kept
   * across turns, and announced as an update at the next step boundary. Synapse
   * uses it to brief a role (which project, where the plan lives, what to do
   * with it) without prefixing text onto the operator's message — a prefix would
   * be part of the conversation and would show up in the transcript as if the
   * operator had typed it.
   *
   * The route is namespaced `experimental` upstream; it is the one place in
   * Synapse that knows that, which is exactly what the adapter is for.
   */
  async setInstruction(sessionId, key, value) {
    await this.request(
      'PUT',
      `/api/experimental/session/${encodeURIComponent(sessionId)}/instructions/entries/${encodeURIComponent(key)}`,
      { value },
    );
    return true;
  }

  async listInstructions(sessionId) {
    const r = await this.request(
      'GET',
      `/api/experimental/session/${encodeURIComponent(sessionId)}/instructions/entries`,
    );
    return Array.isArray(r?.data) ? r.data : [];
  }

  async clearInstruction(sessionId, key) {
    await this.request(
      'DELETE',
      `/api/experimental/session/${encodeURIComponent(sessionId)}/instructions/entries/${encodeURIComponent(key)}`,
    );
    return true;
  }

  async createSession({ title, model, agent, directory, permissions, metadata } = {}) {
    const target = directory || this.workspaceDir;
    const body = { location: { directory: target } };
    if (title) body.title = title;
    if (agent) body.agent = agent;
    // Free-form session metadata. Synapse uses it to mark its own scaffolding —
    // a worker session must be hidden from the rail even though it runs in the
    // project's directory, which is how real sessions are recognised.
    if (metadata && typeof metadata === 'object') body.metadata = metadata;
    // A session may be created with its own tool ruleset — that is how chat
    // mode (every tool denied) is expressed.
    if (Array.isArray(permissions) && permissions.length) body.permissions = permissions;
    const ref = parseModelRef(model);
    if (ref) body.model = ref;

    const r = await this.request('POST', '/api/session', body, { directory: target });
    const s = normalizeSession(r?.data || {});
    this.sessionLog.info(
      `session created id=${s.id} model=${ref ? `${ref.providerID}/${ref.id}` : '(default)'} ` +
        `variant=${ref?.variant || 'default'} agent=${agent || '(default)'} ` +
        `mode=${s.chat ? 'chat' : 'agents'} dir=${target}`,
    );
    return s;
  }

  /**
   * Switch the model and/or thinking effort of an existing session. The engine
   * accepts a Model.Ref — provider, model id and an optional variant — and
   * applies it to subsequent provider turns. Returns 204 with no body.
   */
  async switchModel(sessionId, model) {
    const ref = parseModelRef(model);
    if (!ref) throw new Error('a model reference is required');
    await this.request('POST', `/api/session/${encodeURIComponent(sessionId)}/model`, { model: ref });
    this.sessionLog.info(
      `model switched id=${sessionId} model=${ref.providerID}/${ref.id} variant=${ref.variant || 'default'}`,
    );
  }

  /**
   * Replace the session's permission ruleset. An empty array clears all rules
   * (delegation allowed — Multi); the Single ruleset denies the `subagent`
   * tool. The engine applies this to later turns of the same session, so the
   * mode can be flipped while it is open. Returns 204 with no body.
   */
  async updateSessionPermissions(sessionId, permissions) {
    const rules = Array.isArray(permissions) ? permissions : [];
    await this.request('PATCH', `/api/session/${encodeURIComponent(sessionId)}`, { permissions: rules });
    this.sessionLog.info(
      `permissions set id=${sessionId} mode=${rules.length ? 'single' : 'multi'} rules=${rules.length}`,
    );
  }

  /**
   * Replace the session's metadata. The engine keeps it as free-form JSON, which
   * is where Synapse stores its own per-session switches (`synapse.auto`,
   * `synapse.internal`) — durable, and they travel with the session. Returns 204
   * with no body.
   */
  async updateSessionMetadata(sessionId, metadata) {
    await this.request('PATCH', `/api/session/${encodeURIComponent(sessionId)}`, {
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
    });
  }

  /**
   * Ask the engine to compact a session.
   *
   * "Durably admit a session compaction request. Steers by default: it runs at the
   * next step boundary instead of waiting behind queued prompts." — so this is a
   * queue entry, not a blocking call, which is what makes it safe to send from
   * inside a run. The summary replaces the transcript the model is sent; the
   * transcript itself is kept.
   */
  async compact(sessionId) {
    await this.request('POST', `/api/session/${encodeURIComponent(sessionId)}/compact`, {});
    this.sessionLog.info(`compact -> ${sessionId}`);
    return true;
  }

  async getMessages(sessionId) {
    const r = await this.request(
      'GET',
      `/api/session/${encodeURIComponent(sessionId)}/message?limit=200&order=asc`,
    );
    const data = Array.isArray(r?.data) ? r.data : [];
    const messages = data.map(normalizeMessage);
    messages.sort((a, b) => (a.created || 0) - (b.created || 0));
    return messages;
  }

  async prompt(sessionId, text) {
    this.sessionLog.info(`prompt -> ${sessionId}: ${String(text).replace(/\s+/g, ' ').slice(0, 300)}`);
    return this.request('POST', `/api/session/${encodeURIComponent(sessionId)}/prompt`, { text });
  }

  /**
   * Inject a synthetic message into a session. The engine describes it as
   * "durably admit synthetic session input and schedule execution", so unlike a
   * prompt it is not the operator speaking — it is the harness, and the
   * transcript keeps it as its own message type. This is how the Architect is
   * woken after a worker reports back, with nobody typing anything.
   */
  async synthetic(sessionId, text, { description } = {}) {
    const body = { text };
    if (description) body.description = description;
    this.sessionLog.info(`synthetic -> ${sessionId}: ${String(description || text).slice(0, 200)}`);
    return this.request('POST', `/api/session/${encodeURIComponent(sessionId)}/synthetic`, body);
  }

  async interrupt(sessionId) {
    this.sessionLog.info(`interrupt -> ${sessionId}`);
    return this.request('POST', `/api/session/${encodeURIComponent(sessionId)}/interrupt`, {});
  }

  async replyPermission(sessionId, requestId, decision) {
    this.sessionLog.info(`permission ${sessionId}/${requestId} -> ${decision}`);
    return this.request(
      'POST',
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      { decision },
    );
  }

  async listPendingPermissions() {
    const r = await this.request('GET', '/api/permission/request');
    return Array.isArray(r?.data) ? r.data : [];
  }

  /** Sessions the engine currently considers running — survives a Synapse restart. */
  async listActiveSessions() {
    const r = await this.request('GET', '/api/session/active');
    const data = r?.data && typeof r.data === 'object' ? r.data : {};
    return Object.keys(data);
  }

  /**
   * Forms: an agent can ask the operator for structured input, and the session
   * blocks until it is answered. Missing one stalls the session forever.
   */
  async listForms(sessionId) {
    const path = sessionId
      ? `/api/session/${encodeURIComponent(sessionId)}/form`
      : '/api/form';
    const r = await this.request('GET', path);
    return Array.isArray(r?.data) ? r.data : [];
  }

  async replyForm(sessionId, formId, answer) {
    this.sessionLog.info(`form reply ${sessionId}/${formId}`);
    return this.request(
      'POST',
      `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/reply`,
      { answer },
    );
  }

  // PATCH returns 204 with an empty body.
  async updateSessionTitle(sessionId, title) {
    await this.request('PATCH', `/api/session/${encodeURIComponent(sessionId)}`, { title: String(title) });
    this.sessionLog.info(`session renamed ${sessionId} -> ${title}`);
    return true;
  }

  async deleteSession(sessionId) {
    await this.request('DELETE', `/api/session/${encodeURIComponent(sessionId)}`);
    this.sessionLog.info(`session deleted ${sessionId}`);
    return true;
  }

  /**
   * Dispose the engine's cached services for a directory.
   *
   * The engine keeps a location loaded once it has served a turn there, and that
   * handle keeps the folder undeletable until the engine restarts. This is the
   * release: `DELETE /api/debug/location`, whose `location` parameter is a
   * deepObject (`location[directory]=…`). Verified: after this call the folder
   * deletes normally with the engine still running.
   */
  async evictLocation(directory) {
    const dir = String(directory || '');
    if (!dir) return false;
    const query = `location%5Bdirectory%5D=${encodeURIComponent(dir)}`;
    await this.request('DELETE', `/api/debug/location?${query}`);
    // The engine disposes the location's services asynchronously: the directory
    // handle drops a moment later, not by the time the call returns. Measured — an
    // immediate delete right after the evict still failed, and the same delete a
    // second later worked. So confirm the release against the engine's own list
    // rather than sleeping and hoping.
    const key = (p) =>
      String(p || '')
        .replace(/[\\/]+/g, '/')
        .toLowerCase()
        .replace(/\/+$/, '');
    const want = key(dir);
    for (let i = 0; i < 30; i += 1) {
      try {
        const list = await this.request('GET', '/api/debug/location');
        const dirs = (Array.isArray(list) ? list : list?.data || []).map((l) => key(l?.directory));
        if (!dirs.includes(want)) {
          this.log.info(`engine released location: ${dir}`);
          return true;
        }
      } catch { /* keep waiting */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    this.log.warn(`engine still lists ${dir} after eviction; the folder may stay locked`);
    return false;
  }

  /** One-shot completion inside a session's context; adds nothing to the transcript. */
  async generateText(sessionId, prompt) {
    const r = await this.request('POST', `/api/session/${encodeURIComponent(sessionId)}/generate`, { prompt: String(prompt) });
    return r?.data?.text || '';
  }

  // ── event stream ─────────────────────────────────────────────

  connectStream() {
    try { this._streamAbort?.abort(); } catch { /* ignore */ }
    const ac = new AbortController();
    this._streamAbort = ac;

    const run = async () => {
      let backoff = 1000;
      while (!this._stopping && !ac.signal.aborted) {
        try {
          const res = await fetch(this.base + '/api/event', {
            headers: { authorization: this.authHeader() },
            signal: ac.signal,
          });
          if (!res.ok || !res.body) throw new Error(`event stream HTTP ${res.status}`);
          this.log.info('event stream connected');
          backoff = 1000;

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, idx).trim();
              buf = buf.slice(idx + 1);
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (!payload) continue;
              let ev;
              try { ev = JSON.parse(payload); } catch { continue; }
              this.handleEvent(ev);
            }
          }
        } catch (err) {
          if (ac.signal.aborted || this._stopping) return;
          this.log.warn(`event stream error: ${err.message}; retrying in ${backoff}ms`);
        }
        if (ac.signal.aborted || this._stopping) return;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 15000);
      }
    };

    run().catch((err) => this.log.error('event stream loop crashed: ' + err.message));
  }

  handleEvent(ev) {
    const type = ev?.type || 'unknown';
    const sessionId =
      ev?.sessionID ||
      ev?.data?.sessionID ||
      ev?.data?.info?.sessionID ||
      ev?.data?.message?.sessionID ||
      null;
    const directory = ev?.location?.directory || ev?.data?.location?.directory || null;
    const kind = classifyEvent(type);

    if (type.startsWith('session.')) this.sessionLog.info(`event ${type}${sessionId ? ' ' + sessionId : ''}`);
    if (kind === 'tool') this.toolLog.info(`event ${type}${sessionId ? ' ' + sessionId : ''} :: ${JSON.stringify(ev).slice(0, 900)}`);
    if (type === 'permission.asked') this.toolLog.info(`permission.asked ${sessionId ? sessionId + ' ' : ''}:: ${JSON.stringify(ev).slice(0, 600)}`);

    this.emit('event', { ts: Date.now(), type, kind, sessionId, directory, raw: ev });
  }
}
