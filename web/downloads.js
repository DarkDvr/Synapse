// A browser download, drawn in the chat.
//
// The browser process owns the bytes and reports progress over SSE; the page needs one
// chip per file. It is deliberately ASCII: a monospace bar survives the chat's text-size
// setting and reads at a glance, where a styled progress element would be another control
// to keep in step with the theme.
import { state } from './state.js';
import { currentProject, dirKey } from './run-view.js';
import { esc } from './format.js';

const MAX_AGE_MS = 10 * 60 * 1000;

export function formatBytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function progressBar(received, total, width = 24) {
  const cells = Math.max(4, Math.round(Number(width) || 24));
  const bytes = Number(received) || 0;
  const whole = Number(total) || 0;
  if (!whole) return `[${'-'.repeat(cells)}]`;
  const pct = Math.max(0, Math.min(100, (bytes / whole) * 100));
  const filled = Math.max(0, Math.min(cells, Math.round((pct / 100) * cells)));
  return `[${'#'.repeat(filled)}${'-'.repeat(cells - filled)}]`;
}

export function downloadLabel(state) {
  switch (String(state || '')) {
    case 'completed': return 'Saved';
    case 'canceled': return 'Cancelled';
    case 'interrupted': return 'Failed';
    case 'starting': return 'Starting';
    default: return 'Downloading';
  }
}

/** The current project's downloads, active first and then recent completions. */
export function downloadsForProject(dir = currentProject()?.directory) {
  const key = dirKey(dir);
  if (!key || !(state.downloads instanceof Map)) return [];
  const now = Date.now();
  return [...state.downloads.values()]
    .filter((d) => dirKey(d.dir) === key)
    .filter((d) => !d.endedAt || now - Number(d.endedAt) < MAX_AGE_MS)
    .sort((a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0))
    .slice(-4);
}

/** The inside of one download card; replaced in place while the bytes arrive. */
export function downloadBody(d) {
  const stateName = String(d.state || 'inProgress');
  const done = stateName === 'completed';
  const bad = stateName === 'canceled' || stateName === 'interrupted';
  const pct = Number(d.total) > 0 ? Math.round((Number(d.received) / Number(d.total)) * 100) : null;
  const size = Number(d.total) > 0
    ? `${formatBytes(d.received)} / ${formatBytes(d.total)}`
    : formatBytes(d.received);
  const foot = done
    ? `Saved to ${d.path || `.project/downloads/${d.name}`}`
    : bad
      ? (d.error || 'The browser stopped it.')
      : 'Saving to .project/downloads';
  return `<div class="tool-head">
      <span class="status-dot ${done ? 'ok' : bad ? 'err' : 'warn'}" role="img" aria-label="${esc(downloadLabel(stateName))}"></span>
      <span class="tool-name">SynaBrowse · Download</span>
      <span class="tool-target" title="${esc(d.name)}">${esc(d.name)}</span>
      <span class="tool-state state-pill ${done ? 'ok' : bad ? 'err' : 'warn'}">${esc(downloadLabel(stateName))}${pct !== null ? ` ${pct}%` : ''}</span>
    </div>
    <div class="download-body">
      <div class="download-name">${esc(d.name)}</div>
      <code class="download-bar">${progressBar(d.received, d.total)}</code>
      <div class="download-meta">${esc(size)}</div>
      <div class="download-foot" title="${esc(foot)}">${esc(foot)}</div>
    </div>`;
}

export function downloadCard(d) {
  const stateName = String(d.state || 'inProgress');
  const cls = stateName === 'completed' ? ' is-done' : stateName === 'canceled' || stateName === 'interrupted' ? ' is-error' : '';
  return `<div class="tool-card tool-download${cls}" data-download-card="${esc(d.id)}">${downloadBody(d)}</div>`;
}

/**
 * Where a card sits in the conversation.
 *
 * It belongs to the **action that started it** — the click or the download call — not to
 * the moment the bytes finished. A finish can land after the report has begun, which put
 * the card under the report instead of among the tool calls that earned it (22 Nov).
 * A record with no start time (an old one) falls to the end of the conversation.
 */
export const downloadAt = (d) => {
  const started = Number(d?.startedAt) || 0;
  if (started > 0) return started;
  const ended = Number(d?.endedAt) || 0;
  return ended > 0 ? ended : Number.MAX_SAFE_INTEGER;
};

/**
 * The downloads that belong to one post: from its start up to the next post's start.
 *
 * A card inside a message's body sits within the role's green rule, where the operator
 * expects it, and scrolls with that post instead of waiting at the bottom of the page
 * (18 Nov). It is anchored by `startedAt`, so a file that finishes after the report was
 * written still sits with the click that began it (22 Nov).
 */
export function downloadsInWindow(downloads, from, until = Number.POSITIVE_INFINITY) {
  return (Array.isArray(downloads) ? downloads : []).filter((d) => {
    const at = downloadAt(d);
    return at >= from && at < until;
  });
}
