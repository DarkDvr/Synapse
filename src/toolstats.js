// Tool-call census.
//
// The point is to know, from evidence rather than guesswork, which tools these
// models actually reach for, how often those calls fail, and which failures
// repeat. Every completed turn is scanned once; tool parts are keyed by id so
// re-reading a transcript never double-counts.
//
// Aggregates live in data/tool-stats.json and are readable over the API.
import fs from 'node:fs';
import path from 'node:path';

const MAX_RECENT_ERRORS = 40;

export function createToolStats({ file, logger }) {
  const log = logger.channel('tools');
  const seen = new Set();
  const state = {
    since: Date.now(),
    total: 0,
    failed: 0,
    tools: {},   // name -> { calls, failed, ms }
    models: {},  // model -> { calls, failed }
    exits: {},   // exit code -> count
    recentErrors: [],
  };

  // The census outlives the process: reload what we already know.
  try {
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
      if (saved && typeof saved === 'object') {
        Object.assign(state, {
          since: saved.since || state.since,
          total: Number(saved.total) || 0,
          failed: Number(saved.failed) || 0,
          tools: saved.tools || {},
          models: saved.models || {},
          exits: saved.exits || {},
          recentErrors: Array.isArray(saved.recentErrors) ? saved.recentErrors : [],
        });
        log.info(`census restored: ${state.total} calls, ${state.failed} failed`);
      }
    }
  } catch (err) {
    log.warn(`census could not be restored (${err.message}); starting fresh`);
  }

  let writeTimer = null;
  const flush = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      log.warn(`could not persist tool stats: ${err.message}`);
    }
  };
  const scheduleFlush = () => {
    if (writeTimer) return;
    writeTimer = setTimeout(() => { writeTimer = null; flush(); }, 2000);
    writeTimer.unref?.();
  };

  const bump = (bucket, key, failed, ms) => {
    const k = key || '(unknown)';
    bucket[k] = bucket[k] || { calls: 0, failed: 0, ms: 0 };
    bucket[k].calls += 1;
    if (failed) bucket[k].failed += 1;
    if (typeof ms === 'number' && ms > 0) bucket[k].ms += ms;
  };

  /** Record one normalized tool part. Returns false when already counted. */
  function record({ id, name, failed, exitCode, model, agent, sessionId, message, ms }) {
    if (id && seen.has(id)) return false;
    if (id) {
      seen.add(id);
      if (seen.size > 20000) seen.clear();
    }
    state.total += 1;
    if (failed) state.failed += 1;
    bump(state.tools, name, failed, ms);
    bump(state.models, model, failed, ms);
    if (typeof exitCode === 'number') {
      state.exits[String(exitCode)] = (state.exits[String(exitCode)] || 0) + 1;
    }
    if (failed) {
      state.recentErrors.unshift({
        at: Date.now(),
        tool: name || 'tool',
        model: model || null,
        agent: agent || null,
        sessionId: sessionId || null,
        exitCode: typeof exitCode === 'number' ? exitCode : null,
        detail: String(message || '').replace(/\s+/g, ' ').slice(0, 400),
      });
      state.recentErrors.length = Math.min(state.recentErrors.length, MAX_RECENT_ERRORS);
    }
    scheduleFlush();
    return true;
  }

  /** Scan a session's transcript; safe to call repeatedly. */
  function recordMessages(messages, { model, agent, sessionId } = {}) {    let added = 0;
    for (const m of messages || []) {
      for (const part of m.parts || []) {
        if (part?.type !== 'tool') continue;
        const detail = part.error || part.output || '';
        if (record({
          id: part.id,
          name: part.name,
          failed: Boolean(part.failed),
          exitCode: part.exitCode,
          model,
          agent,
          sessionId,
          message: detail,
          ms: part.ms,
        })) added += 1;
      }
    }
    return added;
  }

  /**
   * Wipe the census. `seen` goes with it: those ids are only there to stop the
   * same tool part being counted twice inside one census, so keeping them would
   * make the next scan silently count nothing.
   */
  function clear() {
    state.since = Date.now();
    state.total = 0;
    state.failed = 0;
    state.tools = {};
    state.models = {};
    state.exits = {};
    state.recentErrors = [];
    seen.clear();
    flush();
  }

  function snapshot() {    const rank = (bucket) =>
      Object.entries(bucket)
        .map(([key, v]) => ({
          key,
          ...v,
          failRate: v.calls ? v.failed / v.calls : 0,
          avgMs: v.calls ? Math.round(v.ms / v.calls) : 0,
        }))
        .sort((a, b) => b.calls - a.calls);
    return {
      since: state.since,
      total: state.total,
      failed: state.failed,
      failRate: state.total ? state.failed / state.total : 0,
      tools: rank(state.tools),
      models: rank(state.models),
      exits: state.exits,
      recentErrors: state.recentErrors.slice(0, 20),
    };
  }

  return { record, recordMessages, snapshot, clear, flush };
}
