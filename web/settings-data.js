// The small, pure helpers the Settings pages work with: a dotted path into the
// config object, the provider id slug, a masked key, and the model list as lines.
//
// They lived in the middle of app.js beside the panes that used them. They are
// data-in, data-out — no DOM, no fetch, no state — which is what lets the Settings
// block leave app.js without dragging a copy of each along with it.

/** `readPath(cfg, 'logging.debug.maxFileMb')` -> the value, or ''. */
export function readPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj) ?? '';
}

/** Write it back, creating the objects on the way. */
export function writePath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    o[keys[i]] = o[keys[i]] || {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}

/** `sk-efn1***f7df`: enough to tell two keys apart, never enough to use one. */
export function maskSecret(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return `${k.slice(0, 2)}${'*'.repeat(6)}`;
  return `${k.slice(0, 6)}***${k.slice(-3)}`;
}

/** The same rule as src/providers.js: one id, chosen once, used in model refs. */
export function slugify(name) {
  return (
    String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'provider'
  );
}

/** Models as the editor shows them.
 *
 * A local runtime owns the window, so its lines carry none: Synapse asks the
 * server what it has loaded at every boot, and that is the number the engine and
 * the watchdog both use. A remote provider has nobody to ask, so its window is
 * typed here — `id | name | context | output` — and it is the only number the
 * engine will have. */
export function modelLines(models, withWindow = true) {
  return (models || [])
    .map((m) => {
      const bits = [m.id, m.name && m.name !== m.id ? m.name : ''];
      if (withWindow) bits.push(m.context || '', m.output || '');
      return bits.join(' | ').replace(/(\s*\|\s*)+$/, '');
    })
    .join('\n');
}

/** Lines back into models. A window the line does not mention is kept from the
 *  model that was already there: editing a name used to drop a context with it,
 *  silently, and for a local runtime nothing in the form would ever put it back. */
export function parseModelLines(text, previous = []) {
  const had = new Map((previous || []).map((m) => [m.id, m]));
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id = '', name = '', context = '', output = ''] = line.split('|').map((s) => s.trim());
      if (!id) return null;
      const old = had.get(id) || {};
      const model = { id, name: name || id };
      const ctx = Number.parseInt(context, 10) || Number(old.context) || 0;
      const out = Number.parseInt(output, 10) || Number(old.output) || 0;
      if (ctx > 0) model.context = ctx;
      if (out > 0) model.output = out;
      return model;
    })
    .filter(Boolean);
}
