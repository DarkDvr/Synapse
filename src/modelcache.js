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
    // Store the result even when it is empty: the point is that the model was
    // asked once. A failed or silent answer must not cause a second turn later.
    rec.tools = tools;
    rec.toolsAt = Date.now();
    persist();
    return true;
  }

  /** True once the model has been asked about its toolset — whatever it said. */
  function isChecked(ref) {
    const rec = get(ref);
    return Boolean(rec && rec.toolsAt);
  }

  return { record, get, setTools, isChecked, snapshot: () => data };
}
