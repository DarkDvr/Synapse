// What each worker run thought, step by step.
//
// The panel that shows it is page state: a reload lost it, and a second view never
// had it. The notes are rebuilt from `/api/runs`, so the reasoning is too — the trace
// is the only record of a worker's thinking, and it is worth the few kilobytes while
// the run is on screen (8 Nov).
//
// One file, bounded twice: twelve steps per run (more than anyone reads back) and the
// forty most recent runs. It lives in `data/`, is pruned on boot, and a failed write
// is a warning — never a reason for a run to fail.
import fs from 'node:fs';
import path from 'node:path';

const MAX_PER_RUN = 24;
const MAX_RUNS = 20;
const MAX_TEXT = 20000;

export function createTraceReasons(file, { log } = {}) {
  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && raw.runs && typeof raw.runs === 'object') return raw;
    } catch {
      // A first run, or a file somebody edited: start empty, never throw.
    }
    return { version: 1, runs: {} };
  }

  let store = load();

  const keyOf = ({ dir, task, startedAt } = {}) =>
    `${String(dir || '').toLowerCase()}|${String(task || '')}|${Number(startedAt) || 0}`;

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(store));
      fs.renameSync(tmp, file);
    } catch (err) {
      log?.warn?.(`trace reasons were not saved: ${err.message}`);
    }
  }

  return {
    /** One finished reasoning step. Returns how many the run now holds. */
    add(run, text) {
      const clean = String(text || '').trim();
      if (!clean) return store.runs[keyOf(run)]?.reasons?.length || 0;
      const key = keyOf(run);
      const entry = store.runs[key] || {
        dir: String(run?.dir || ''),
        task: String(run?.task || ''),
        startedAt: Number(run?.startedAt) || 0,
        reasons: [],
      };
      entry.reasons = [...entry.reasons, { text: clean.slice(0, MAX_TEXT), at: Date.now() }].slice(-MAX_PER_RUN);
      entry.at = Date.now();
      store.runs[key] = entry;
      // Newest forty runs, so a year of shifts cannot grow this file without end.
      const keys = Object.keys(store.runs).sort((a, b) => (store.runs[b].at || 0) - (store.runs[a].at || 0));
      for (const old of keys.slice(MAX_RUNS)) delete store.runs[old];
      save();
      return entry.reasons.length;
    },

    /** The steps remembered for a run, or an empty list. */
    get(run) {
      return store.runs[keyOf(run)]?.reasons || [];
    },

    /** Forget runs older than a day. Called once at boot. */
    prune(maxAgeMs = 24 * 60 * 60 * 1000) {
      const now = Date.now();
      let dropped = 0;
      for (const [key, entry] of Object.entries(store.runs)) {
        if (now - (Number(entry.at) || 0) > maxAgeMs) {
          delete store.runs[key];
          dropped += 1;
        }
      }
      if (dropped) save();
      return dropped;
    },

    snapshot: () => store,
  };
}
