// Download names and pictures, kept out of the browser so they can be tested alone.
//
// Chromium's `allowAndName` writes the bytes under the download's GUID. That is safe and
// ugly; this is the half that turns it into the name the site suggested, without letting a
// site choose a path, a reserved Windows name or a name that overwrites an earlier file.
import fs from 'node:fs';
import path from 'node:path';

/** A suggested filename as one safe leaf. Never a path, never a Windows device name. */
export function safeDownloadName(name, fallback = 'download') {
  let base = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+/g, '')
    .replace(/[. ]+$/g, '')
    .slice(0, 120)
    .trim();
  if (!base) base = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(base)) base = `_${base}`;
  return base;
}

/** The first free path for this name, with " (1)" before the extension on a collision. */
export function uniqueDownloadPath(dir, name) {
  const safe = safeDownloadName(name);
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  let candidate = path.join(dir, safe);
  for (let n = 1; fs.existsSync(candidate) && n <= 999; n += 1) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
  }
  return candidate;
}

/** "4.2 MB" — one number the operator can read without counting bytes. */
export function formatBytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * The ASCII bar the chat shows. Twenty-four cells: one is about 4%, which is enough to
 * see movement and small enough to sit beside a filename at the chat's narrowest width.
 */
export function progressBar(received, total, width = 24) {
  const cells = Math.max(4, Math.round(Number(width) || 24));
  const bytes = Number(received) || 0;
  const whole = Number(total) || 0;
  if (!whole) return `[${'-'.repeat(cells)}]`;
  const pct = Math.max(0, Math.min(100, (bytes / whole) * 100));
  const filled = Math.max(0, Math.min(cells, Math.round((pct / 100) * cells)));
  return `[${'#'.repeat(filled)}${'-'.repeat(cells - filled)}]`;
}

/** A short label for a CDP download state. */
export function downloadLabel(state) {
  switch (String(state || '')) {
    case 'completed': return 'Saved';
    case 'canceled': return 'Cancelled';
    case 'interrupted': return 'Failed';
    case 'starting': return 'Starting';
    default: return 'Downloading';
  }
}
