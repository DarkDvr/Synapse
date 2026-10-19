// Per-model knowledge base.
//
// The engine catalog is the live truth, but free models come and go. This file
// records what we learned about each model the day we saw it: context and
// output limits, the thinking-effort variants with the provider's own labels,
// capabilities, and the toolset a one-off discovery turn reported. Once a model
// is known, the UI and the census never have to ask again — and the record
// survives the model leaving the catalog.
//
// It stores facts we observed, never guesses. A record with no `tools` simply
// means the discovery turn has not run yet.
import fs from 'node:fs';
import path from 'node:path';

// A silent model gets at most this many asks, across selections and restarts.
// Three is enough to ride out a transient failure without burning quota on a
// model that simply will not answer.
export const MAX_TOOL_ASKS = 3;

export function createModelCache({ logger, file }) {
  const log = logger.channel('app');
  const data = { version: 1, models: {} };

  try {
    if (file && fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
      if (saved && typeof saved.models === 'object' && saved.models !== null) {
        data.models = saved.models;
        log.info(`model cache restored: ${Object.keys(data.models).length} model(s)`);
      }
    }
  } catch (err) {
    log.warn(`model cache could not be restored (${err.message})`);
  }

  function persist() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      log.warn(`model cache could not be saved: ${err.message}`);
    }
  }

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /**
   * Merge the engine's live catalog. Existing records keep their discovered
   * tools; metadata is refreshed from what the engine reports now.
   * Returns the number of records that changed (new or updated).
   */
  function record(models) {
    const now = Date.now();
    let changed = 0;
    for (const m of models || []) {
      if (!m?.ref) continue;
      const prev = data.models[m.ref] || {};
      const next = {
        ...prev,
        ref: m.ref,
        provider: m.provider,
        id: m.id,
        name: m.name,
        family: m.raw?.family || prev.family || null,
        context: m.context ?? prev.context ?? null,
        output: m.output ?? prev.output ?? null,
        variants: Array.isArray(m.variants) ? m.variants : prev.variants || [],
        capabilities: m.raw?.capabilities || prev.capabilities || null,
        firstSeen: prev.firstSeen || now,
        lastSeen: now,
        metadataAt: now,
      };
      const isNew = !prev.ref;
      const metadataMoved =
        !same(prev.variants, next.variants) || prev.context !== next.context || prev.output !== next.output;
      if (isNew || metadataMoved) changed += 1;
      // a model that is still in the catalog is not "gone"
      if (!isNew) next.lastSeen = now;
      data.models[m.ref] = next;
    }
    if (models?.length) persist();
    return changed;
  }

  function get(ref) {
    return ref ? data.models[ref] || null : null;
  }

  function setTools(ref, tools) {
    const rec = data.models[ref];
    if (!rec || !Array.isArray(tools)) return false;
    // Every completed ask counts, even an empty answer. `toolsValid` is only
    // set by a real list, so a silent model stays eligible for a retry — but
    // only up to MAX_TOOL_ASKS in total, spread across sessions.
    rec.timesAsked = (rec.timesAsked || 0) + 1;
    rec.toolsAt = Date.now();
    if (tools.length) {
      rec.tools = tools;
      rec.toolsValid = true;
    }
    persist();
    return true;
  }

  /** True once we hold a real, non-empty tool list for this model. */
  function isChecked(ref) {
    const rec = get(ref);
    return Boolean(rec && rec.toolsValid);
  }

  function attempts(ref) {
    return get(ref)?.timesAsked || 0;
  }

  /**
   * Give every model three fresh chances: zero the attempt counters. Valid
   * results are kept — a model that already answered will not be asked again
   * just because its counter was reset.
   */
  function resetAsks() {
    const refs = Object.keys(data.models);
    for (const ref of refs) data.models[ref].timesAsked = 0;
    persist();
    return refs.length;
  }

  /**
   * A complaint about a model, in the provider's own words.
   *
   * Not a verdict — evidence, and the operator's to overrule. A retired model is
   * the case that cost a run: the catalog keeps advertising a model the inference
   * endpoint has already retired, so the picker showed nothing wrong and every
   * delegation died in two seconds. Kept newest-first and de-duplicated by
   * message, because the same outage reported five times is one problem.
   */
  function noteIssue(ref, issue) {
    const rec = ref ? data.models[ref] : null;
    if (!rec || !issue?.message) return false;
    const entry = {
      at: Date.now(),
      kind: String(issue.kind || 'provider'),
      message: String(issue.message).slice(0, 300),
    };
    const prev = Array.isArray(rec.issues) ? rec.issues : [];
    if (prev.some((i) => i.message === entry.message)) return false;
    rec.issues = [entry, ...prev].slice(0, 3);
    persist();
    return true;
  }

  /** The operator checked it and it works: forget the complaints, no questions. */
  function clearIssues(ref) {
    const rec = ref ? data.models[ref] : null;
    if (!rec?.issues?.length) return false;
    delete rec.issues;
    persist();
    return true;
  }

  return { record, get, setTools, isChecked, attempts, resetAsks, noteIssue, clearIssues, snapshot: () => data };
}
