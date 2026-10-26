// The engine contract. Every engine (OpenCode today; LM Studio / Bionic /
// anything later) implements this interface, so the rest of Synapse never
// knows which backend is in use.
import { EventEmitter } from 'node:events';

export class Engine extends EventEmitter {
  constructor(config = {}, ctx = {}) {
    super();
    this.config = config;
    this.ctx = ctx;
    this.kind = 'unknown';
  }

  // ── lifecycle ────────────────────────────────────────────────
  // start(): bring the engine up and resolve once it is usable.
  async start() { throw new Error(`${this.kind}: start() not implemented`); }
  async stop() {}
  // status(): { kind, ready, version, endpoint, pid, detail }
  status() { return { kind: this.kind, ready: false, version: null, endpoint: null, pid: null }; }

  // ── capabilities ─────────────────────────────────────────────
  async listModels() { return []; }
  // The model the engine uses when a session has no explicit selection.
  async getDefaultModel() { return null; }
  async listAgents() { return []; }
  async listSkills() { return []; }

  // ── sessions ─────────────────────────────────────────────────
  async listSessions() { return []; }
  async getSession() { return null; }
  async createSession() { throw new Error(`${this.kind}: createSession() not implemented`); }
  // Switch the model (and optionally its thinking-effort variant) of an
  // existing session; subsequent turns use it.
  async switchModel() { throw new Error(`${this.kind}: switchModel() not implemented`); }
  // Replace a session's permission ruleset. This is how Single↔Multi is
  // applied to an open session: deny `subagent`, or clear the deny.
  async updateSessionPermissions() { throw new Error(`${this.kind}: updateSessionPermissions() not implemented`); }
  async getMessages() { return []; }
  async prompt() { throw new Error(`${this.kind}: prompt() not implemented`); }
  async interrupt() {}
  async replyPermission() {}
  // Ask the session to summarise itself and carry on. The engine queues it for
  // its next step boundary, so it is safe to ask mid-turn. Returns false when the
  // engine has no such operation; the caller then leaves the session alone.
  async compact() { return false; }
  async updateSessionTitle() { throw new Error(`${this.kind}: updateSessionTitle() not implemented`); }
  async deleteSession() { throw new Error(`${this.kind}: deleteSession() not implemented`); }

  /** Release whatever the engine holds for a directory (cached services, file
   *  watchers, a working-directory handle). Engines that hold nothing need not
   *  implement it — the folder is then deletable by definition. */
  async evictLocation() { return false; }
  // One-shot completion in a session's context that does NOT join the
  // transcript — used for naming sessions.
  async generateText() { return ''; }
  // Inject a message that is the harness speaking, not the operator.
  async synthetic() { throw new Error(`${this.kind}: synthetic() not implemented`); }
  // Replace a session's free-form metadata (Synapse stores its own switches here).
  async updateSessionMetadata() { throw new Error(`${this.kind}: updateSessionMetadata() not implemented`); }

  // ── standing context ─────────────────────────────────────────
  // Durable, per-session instructions. Synapse briefs a role with these rather
  // than prefixing its message: a prefix would be part of the conversation.
  // An engine without the concept may implement these as no-ops.
  async setInstruction() { return false; }
  async listInstructions() { return []; }
  async clearInstruction() { return false; }

  // ── things that can block a session ──────────────────────────
  /** Sessions the engine still considers running. */
  async listActiveSessions() { return []; }
  /** Pending permission requests (a tool waiting for a yes/no). */
  async listPendingPermissions() { return []; }
  /** Pending permission requests for one session. The engine's global list is
   *  scoped to its own location, so a session in a project subfolder is not in
   *  it — the same reason forms are asked for per session. */
  async listSessionPermissions() { return []; }
  /** Pending forms (an agent waiting for structured input). */
  async listForms() { return []; }
  async replyForm() { throw new Error(`${this.kind}: replyForm() not implemented`); }

  // ── events ───────────────────────────────────────────────────
  // Emits: 'event' (normalized { ts, type, kind, sessionId, directory, raw }),
  //        'exit'  ({ code, signal })
}

// ── shared normalization helpers ───────────────────────────────

export function modelRef(raw) {
  const provider = raw?.providerID || raw?.provider || 'unknown';
  const id = raw?.id || raw?.modelID || '';
  return `${provider}/${id}`;
}

/**
 * A model selection is either a bare "provider/id" string or an object:
 *   { ref: "provider/id", variant? }  or  { providerID, id, variant? }
 * `variant` is the engine's thinking-effort selector (it maps to the provider's
 * `reasoningEffort`). Omitting it lets the engine use the model's own default;
 * the engine records that as `variant: "default"`.
 */
export function parseModelRef(model) {
  if (typeof model === 'string') {
    const i = model.indexOf('/');
    if (i <= 0) return null;
    const providerID = model.slice(0, i).trim();
    const id = model.slice(i + 1).trim();
    return providerID && id ? { providerID, id } : null;
  }
  if (!model || typeof model !== 'object') return null;

  let providerID = model.providerID;
  let id = model.id || model.modelID;
  if ((!providerID || !id) && typeof model.ref === 'string') {
    const parsed = parseModelRef(model.ref);
    if (!parsed) return null;
    providerID = providerID || parsed.providerID;
    id = id || parsed.id;
  }
  providerID = String(providerID || '').trim();
  id = String(id || '').trim();
  if (!providerID || !id) return null;

  const variant = String(model.variant || '').trim();
  return variant ? { providerID, id, variant } : { providerID, id };
}

export function normalizeModel(raw) {
  const provider = raw?.providerID || raw?.provider || 'unknown';
  const id = raw?.id || raw?.modelID || '';
  const cost = Array.isArray(raw?.cost) ? raw.cost : [];
  const free = cost.length > 0 ? cost.every((c) => Number(c?.input) === 0) : Boolean(raw?.free);
  // Thinking-effort variants in ascending order. `id` is what the engine's
  // Model.Ref takes; `label` is the provider's own knob value (reasoningEffort),
  // which is what the UI should show when it differs from the id. An empty list
  // means the model exposes no effort control at all.
  const variants = (Array.isArray(raw?.variants) ? raw.variants : [])
    .map((v) => {
      if (typeof v === 'string') return { id: v, label: v };
      const vid = v?.id ? String(v.id) : '';
      if (!vid) return null;
      const label = v?.settings?.reasoningEffort ? String(v.settings.reasoningEffort) : vid;
      return { id: vid, label };
    })
    .filter(Boolean);
  return {
    ref: `${provider}/${id}`,
    provider,
    id,
    name: raw?.name || raw?.label || id,
    free,
    cost,
    // What the engine budgets locally. Not every provider-enforced ceiling
    // matches it: the engine's catalog can be conservative (see modelLimits in
    // the engine config), so treat these as the engine's numbers.
    context: Number(raw?.limit?.context) || null,
    output: Number(raw?.limit?.output) || null,
    variants,
    raw,
  };
}

/**
 * True when a session denies the delegation tool — that is how "Single" mode is
 * expressed. Single keeps every tool but stops the Architect handing work to a
 * worker, so it answers everything itself in one chat.
 *
 * A dedicated agent for this is the obvious design and it does not work: the
 * free tier rejected every request from a custom agent with a provider auth
 * error (measured side by side — a custom-agent session failed at 20:45:37
 * while a default-agent session succeeded at 20:45:40). A permission ruleset on
 * an ordinary session behaves correctly instead.
 */
export function isSingleSession(raw) {
  const p = raw?.permissions;
  const rules = Array.isArray(p) ? p : p ? [p] : [];
  return rules.some((r) => r?.action === 'subagent' && r?.effect === 'deny');
}

export function normalizeSession(raw) {
  return {
    id: raw?.id || '',
    title: raw?.title || null,
    directory: raw?.location?.directory || null,
    model: raw?.model ? `${raw.model.providerID}/${raw.model.id}` : null,
    // The engine stores `variant: "default"` when a session was created
    // without an explicit thinking effort — that is not one of the model's
    // advertised variants, so keep it as-is rather than inventing a level.
    variant: raw?.model?.variant || null,
    agent: raw?.agent || null,
    single: isSingleSession(raw),
    // Synapse's own per-session switch: "keep building until done". It lives in
    // the session metadata so it survives a restart and travels with the session.
    auto: raw?.metadata?.synapse?.auto === true,
    // Synapse marks its own scaffolding sessions here (worker sessions, which
    // run in the project directory but must not appear as the operator's work).
    internal: raw?.metadata?.synapse?.internal === true,
    metadata: raw?.metadata || null,
    created: raw?.time?.created || null,
    updated: raw?.time?.updated || null,
    raw,
  };
}

export function normalizeMessage(raw) {
  const type = raw?.type || 'unknown';
  const msg = {
    id: raw?.id || '',
    type,
    created: raw?.time?.created || null,
    completed: raw?.time?.completed || null,
    error: raw?.error?.message || null,
    raw,
  };

  if (type === 'user') {
    msg.text = raw?.text || '';
    // The engine keeps the attachments on the operator's own message, so the chat
    // can say what was sent — after a reload as well as when it was sent. The bytes
    // are dropped here: they are in the raw message if anything needs them, and
    // carrying a base64 copy through every render is a lot of string for a name.
    const files = Array.isArray(raw?.files) ? raw.files : [];
    msg.files = files.map((f) => ({
      name: String(f?.name || 'attachment'),
      mime: String(f?.mime || ''),
    }));
    return msg;
  }

  // A synthetic message is the harness speaking, not the operator. The engine
  // keeps it as its own message type, so it never appears as something the
  // operator typed — which is exactly why the Architect is woken with one.
  if (type === 'synthetic') {
    msg.text = raw?.text || '';
    msg.description = raw?.description || null;
    return msg;
  }

  if (type === 'assistant') {
    msg.text = '';
    msg.parts = [];
    const content = Array.isArray(raw?.content) ? raw.content : [];
    for (const part of content) {
      if (part?.type === 'text') {
        msg.parts.push({ type: 'text', text: part.text || '' });
        msg.text += part.text || '';
      } else if (part?.type === 'reasoning') {
        msg.parts.push({ type: 'reasoning', text: part.text || '' });
      } else if (part?.type === 'tool') {
        const st = part.state || {};
        const content = Array.isArray(st.content) ? st.content : [];
        const output = content
          .map((c) =>
            c?.type === 'text'
              ? c.text
              : c?.type === 'file'
                ? `[file: ${c.path || c.name || ''}]`
                : typeof c === 'string'
                  ? c
                  : JSON.stringify(c),
          )
          .filter(Boolean)
          .join('\n');
        const rawStatus = st.status || 'unknown';
        const error = st.error?.message || (st.error ? JSON.stringify(st.error) : null);

        // A shell command that exits non-zero is reported by the engine as
        // "completed" — the process did finish. Without this the UI shows a
        // green tick on a command that failed outright.
        const exit = /Exited with code\s+(-?\d+)/i.exec(output);
        const exitCode = exit ? Number(exit[1]) : null;
        const looksBroken = /ParserError|ParseException|is not recognized|command not found|Missing expression|Unexpected token|SyntaxError/i.test(
          output,
        );
        const ok =
          !error && !/error|fail/i.test(rawStatus) && !(exitCode !== null && exitCode !== 0) && !looksBroken;

        msg.parts.push({
          type: 'tool',
          id: part.id || null,
          name: part.name || 'tool',
          status: rawStatus,
          title: st.metadata?.title || st.metadata?.name || null,
          input: st.input ?? null,
          output: output || null,
          error,
          ok,
          exitCode,
          failed: !ok,
          // The engine stamps every tool part; this is what makes the census
          // able to say how *fast* a tool is, not just whether it worked.
          startedAt: part.time?.created ?? null,
          endedAt: part.time?.completed ?? null,
          ms:
            typeof part.time?.created === 'number' && typeof part.time?.completed === 'number'
              ? part.time.completed - part.time.created
              : null,
        });
      }
    }
    return msg;
  }

  msg.text = raw?.text || raw?.title || '';
  return msg;
}

export function classifyEvent(type = '') {
  if (type === 'server.connected') return 'hello';
  if (type.includes('tool') || type.startsWith('shell.') || type.startsWith('file.')) return 'tool';
  if (type.includes('permission') || type.includes('form')) return 'permission';
  if (type.startsWith('session.execution') || type === 'session.idle' || type === 'session.status') return 'status';
  if (
    type.startsWith('session.text') ||
    type.startsWith('session.reasoning') ||
    type.startsWith('session.step') ||
    type.includes('message')
  ) {
    return 'message';
  }
  return 'other';
}
