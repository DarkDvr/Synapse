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

/** HH:MM:SS, hours not padded — a stopwatch, read at a glance. */
export function hhmmss(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

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

/** Forward slashes, no trailing separator, lower case: one spelling per path.
 *  The same rule as `normDir` in src/paths.js, and for the same reason - a path
 *  that arrives with a different separator is the same folder, and comparing the
 *  raw strings says it is not. */
export const normDir = (value) =>
  String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Are these the same folder, however each was spelled? */
export const samePath = (a, b) => normDir(a) === normDir(b);

/** The tag a chip carries: the file's extension, not a generic word. PNG says
 *  more than IMG about what the operator is about to open. */
export function fileTag(name, mime) {
  const clean = String(name || '').split(/[?#]/)[0];
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 ? clean.slice(dot + 1).toLowerCase() : '';
  if (ext) return ext === 'jpg' || ext === 'jpeg' ? 'JPEG' : ext.toUpperCase();
  const sub = String(mime || '').split('/')[1] || '';
  if (sub) return sub === 'jpeg' ? 'JPEG' : sub.toUpperCase();
  return 'FILE';
}

/** A file name that fits a chip: the last 14 characters, with an ellipsis. */
export function shortName(name) {
  const s = String(name || '');
  return s.length <= 14 ? s : `${s.slice(0, 13)}…`;
}

/**
 * One attachment, drawn the one way Synapse draws attachments.
 *
 * This is the chat's chip — the tag, the short name, the picture on hover — and it
 * is here so that every place an attachment can appear uses the same one: a
 * message, a model's answer, and the operator's steer to a worker (7 Nov). A
 * picture is a chip only when there is something behind it: `msgId` reads the
 * bytes off a message's own record, `src` a file in the project.
 */
export function fileChip(file, { src = '', msgId = '', index = 0 } = {}) {
  const f = file || {};
  const tag = fileTag(f.name, f.mime);
  const name = esc(shortName(f.name));
  const alt = esc(f.name || '');
  const inner =
    `<span class="chat-image-tag" aria-hidden="true">${esc(tag)}</span>` +
    `<span class="chat-image-name">${name}</span>`;
  const image = /^image\//i.test(f.mime || '') || /\.(png|jpe?g|webp|gif)$/i.test(f.name || '');
  if (image && msgId) {
    // The bytes are on the message's own record: the chip carries the message and
    // the file's index, not a second copy of the base64.
    return `<span class="chat-image" data-msg="${esc(msgId)}" data-file="${Number(index) || 0}" data-alt="${alt}" title="${name}">${inner}</span>`;
  }
  if (image && src) {
    // The bytes are a file in the project — a kept attachment, a steer's picture —
    // and `/api/image` reads it. Same chip, different place to look.
    return `<span class="chat-image" data-src="${esc(src)}" data-alt="${alt}" title="${name}">${inner}</span>`;
  }
  return `<span class="chat-image is-file" title="${alt}">${inner}</span>`;
}

/** "3m ago", "just now": how long ago something happened, in the operator's words.
 *  Shared by the plan pane, the updates card and the status line. */
export function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/**
 * The one-line gist of a reasoning block: its first sentence, whole.
 *
 * A fold that says only "Reasoning" makes the operator open it to learn whether it
 * was worth opening. The first sentence is what the model was about to do, so it is
 * the honest label — flattened to one line because the summary is one line.
 *
 * It used to be cut at 110 characters, which was a guess at the chat's narrowest
 * column: on the operator's screen that left two thirds of the line empty and the
 * sentence ended mid-word (13 Nov). The summary is already `nowrap` with an
 * ellipsis, so the browser cuts it where the pane really ends and the cut moves
 * with the window. Nothing is decided here but the sentence.
 */
export function reasoningGist(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return 'Reasoning';
  const end = flat.search(/[.!?](?:\s|$)/);
  return `Reasoning • ${end > 0 ? flat.slice(0, end + 1) : flat}`;
}
