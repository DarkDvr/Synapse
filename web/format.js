// Small, pure formatting helpers: no DOM, no fetch, no state.
//
// They lived in the middle of app.js, which is where everything that used them also
// lived. They are the first thing a new screen needs, so they are their own module
// now: a settings page, a transcript and a card can all import the same `esc` and
// the same clock formatting instead of each growing its own.
//
// Nothing here may read `state` or touch the document — that is what keeps it
// importable from anywhere without a cycle.

/** HTML-escape. Everything drawn into a template string goes through this. */
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** "now", "4m ago", "3h ago", then a date. For ages on a card. */
export const relTime = (ts) => {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return 'now';
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
};

/** 24-hour HH:MM for message timestamps. */
export const hhmm = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** `2.1.0` -> `v2.1.0`; a value that already says v keeps its own. */
export const versionTag = (v) => {
  const s = String(v || '').trim();
  if (!s) return '';
  return /^v/i.test(s) ? s : `v${s}`;
};

/** 10s, 2m, 3h: a unit that never makes you do arithmetic, rounded down. */
export function shortSpan(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Bytes as the operator reads them: 940 B, 12 KB, 1.4 MB. */
export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${Math.round(v / 1024)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

/** A tool call's one-line description: what it is actually running. */
export function toolTarget(part) {
  const i = part?.input;
  const clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  if (i && typeof i === 'object') {
    const named = clean(i.command) || clean(i.path) || clean(i.filePath) || clean(i.pattern)
      || clean(i.query) || clean(i.url) || clean(i.name);
    if (named) return named;
    for (const v of Object.values(i)) {
      const s = clean(v);
      if (s) return s;
    }
  }
  return clean(part?.title);
}
