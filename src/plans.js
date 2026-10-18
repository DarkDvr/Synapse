// The development plan for a session.
//
// The Architect publishes it by calling the `synapse-plan` MCP tool, and reports
// progress on its tasks with a second tool. Neither call needs its own
// transport: the engine already records **every tool call, with its full input**,
// in the session transcript, and Synapse reads that transcript on every finished
// turn anyway (that is how the tool census works). The MCP server's only job is
// to tell the model what it accepted; the durable record is the turn itself.
//
// Two consequences worth knowing before touching this:
//
//   - Applying a transcript is **idempotent and ordered**. The whole transcript
//     is replayed on each turn, so replaying it after a restart lands on exactly
//     the same state. Every timestamp comes from the tool part, never from the
//     clock, or a replay would invent new ones.
//   - A re-publish keeps the status of any task whose title it repeats, so the
//     Architect can restate its plan without losing progress.
import fs from 'node:fs';
import path from 'node:path';

// The roles the topology has cards for. The tool schema offers exactly these.
export const ROLES = ['architect', 'critic', 'coder-1', 'designer', 'coder-2', 'auditor', 'coder-3'];

// `blocked` is the one that matters: it means the work cannot proceed without
// the operator, and it is painted red for that reason. `failed` is red too —
// the work ran and did not hold.
export const STATUSES = ['todo', 'doing', 'done', 'blocked', 'failed'];

const PUBLISH = 'plan_publish';
const STATUS = 'task_status';

// MCP tools arrive namespaced (`synapse-plan_plan_publish`). Match by suffix,
// never by equality — the namespace belongs to the engine.
const matches = (name, base) => name === base || name.endsWith(`_${base}`);

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** The tool input may arrive as an object or as a JSON string. */
function parseInput(input) {
  if (input && typeof input === 'object') return input;
  if (typeof input !== 'string') return null;
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function createPlans({ file, logger }) {
  const log = logger.channel('app');
  let state = { version: 1, plans: {} };

  try {
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
      if (saved && typeof saved === 'object' && saved.plans && typeof saved.plans === 'object') {
        state = { version: 1, plans: saved.plans };
      }
    }
  } catch (err) {
    log.warn(`could not read the plan store: ${err.message}`);
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      log.warn(`could not write the plan store: ${err.message}`);
    }
  }

  /**
   * Replace the plan. Task ids are positional (`t1`…`tn`) because that is what
   * the tool reply hands the model; status and results carry over to any task
   * whose title repeats.
   */
  function publish(plan, input, at) {
    const raw = Array.isArray(input?.tasks) ? input.tasks : null;
    if (!raw || !raw.length) return false;
    const goal = String(input?.goal || plan.goal || '').trim();
    const previous = new Map((plan.tasks || []).map((t) => [norm(t.title), t]));

    const tasks = raw.slice(0, 24).map((t, i) => {
      const title = String(t?.title || '').trim() || `Task ${i + 1}`;
      const prev = previous.get(norm(title)) || {};
      return {
        id: `t${i + 1}`,
        title,
        role: String(t?.role || prev.role || 'architect').trim(),
        detail: String(t?.detail || prev.detail || '').trim() || null,
        dependsOn: Array.isArray(t?.dependsOn) ? t.dependsOn.map(String) : prev.dependsOn || [],
        status: prev.status || 'todo',
        result: prev.result ?? null,
        note: prev.note ?? null,
        started: prev.started ?? null,
        ended: prev.ended ?? null,
        at: prev.at ?? at ?? null,
      };
    });

    const same =
      plan.goal === goal &&
      (plan.tasks || []).length === tasks.length &&
      tasks.every((t, i) => {
        const p = plan.tasks[i];
        return p.id === t.id && p.title === t.title && p.role === t.role && p.detail === t.detail;
      });
    if (same) return false;

    plan.goal = goal;
    plan.tasks = tasks;
    plan.published = plan.published ?? at ?? null;
    plan.updated = at ?? plan.updated ?? null;
    return true;
  }

  function setStatus(plan, input, at, endedAt) {
    const id = String(input?.id || '').trim();
    const status = String(input?.status || '').toLowerCase();
    if (!id || !STATUSES.includes(status)) return false;
    const task = (plan.tasks || []).find((t) => t.id === id);
    if (!task) return false;

    const result = input?.result != null ? String(input.result).trim() || null : task.result;
    const note = input?.note != null ? String(input.note).trim() || null : task.note;
    if (task.status === status && task.result === result && task.note === note) return false;

    task.status = status;
    task.result = result;
    task.note = note;
    if (status === 'doing') {
      task.started = task.started ?? at ?? null;
      task.ended = null;
    } else if (status === 'done' || status === 'failed' || status === 'blocked') {
      task.started = task.started ?? at ?? null;
      task.ended = endedAt ?? at ?? null;
    } else {
      task.started = null;
      task.ended = null;
    }
    task.at = at ?? task.at ?? null;
    plan.updated = at ?? plan.updated ?? null;
    return true;
  }

  /**
   * Read a session's transcript and fold its plan calls into the store.
   * Safe to call with the whole transcript every turn.
   */
  function applyMessages(sessionId, messages) {
    const plan = state.plans[sessionId] || (state.plans[sessionId] = blank(sessionId));
    let changed = false;
    for (const message of messages || []) {
      for (const part of message?.parts || []) {
        if (part?.type !== 'tool') continue;
        const name = String(part.name || '');
        if (!matches(name, PUBLISH) && !matches(name, STATUS)) continue;
        const input = parseInput(part.input);
        if (!input) continue;
        const at = part.startedAt ?? part.endedAt ?? null;
        changed = (matches(name, PUBLISH)
          ? publish(plan, input, at)
          : setStatus(plan, input, at, part.endedAt ?? null)) || changed;
      }
    }
    if (changed) {
      save();
      log.info(`plan: ${sessionId} -> ${(plan.tasks || []).length} task(s), ${summary(plan)}`);
    }
    return changed;
  }

  function blank(sessionId) {
    return {
      sessionId,
      goal: '',
      tasks: [],
      published: null,
      updated: null,
    };
  }

  function summary(plan) {
    const counts = {};
    for (const t of plan.tasks || []) counts[t.status] = (counts[t.status] || 0) + 1;
    return Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'empty';
  }

  /** Drop a plan whose session is gone; nothing else refers to it. */
  function clear(sessionId) {
    if (!state.plans[sessionId]) return false;
    delete state.plans[sessionId];
    save();
    return true;
  }

  return {
    get: (sessionId) => state.plans[sessionId] || null,
    applyMessages,
    clear,
    snapshot: () => ({ version: state.version, plans: state.plans }),
  };
}
