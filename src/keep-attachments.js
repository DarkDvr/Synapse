// Kept attachments: the operator's deliberate copy in the project.
//
// An attachment is normally inline in the message and exists only in the
// engine's transcript; after a compaction that transcript may be summarised and,
// for a project compact, deleted. "Keep" writes the bytes into
// `.synapse/attachments/` before the message is sent, so the file survives and a
// later Architect or worker can read it. This is not a temp file: it is a project
// file the operator asked to keep, and deleting the project deletes it.
import fs from 'node:fs';
import path from 'node:path';

/** A filename that cannot escape the folder, keeps the extension, and is short. */
export function safeAttachmentName(name) {
  const raw = String(name || 'attachment');
  const base = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  return (base || 'attachment').slice(-90);
}

/**
 * Write every attachment marked `keep` into `<project>/.synapse/attachments/`.
 *
 * Returns `{ name, path, mime, bytes }` for each file written. The path is the
 * project-relative one (`/` separators) for the Log and the briefs. A failure on
 * one file is skipped, not fatal: the message still goes.
 */
export function keepAttachments(dir, files, { at = Date.now() } = {}) {
  const kept = [];
  if (!dir || !Array.isArray(files) || !files.length) return kept;
  const folder = path.join(dir, '.synapse', 'attachments');
  const stamp = new Date(at).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  for (const file of files) {
    if (!file || file.keep !== true) continue;
    const bytes = Buffer.from(String(file.data || ''), 'base64');
    if (!bytes.length) continue;
    try {
      fs.mkdirSync(folder, { recursive: true });
      const safe = safeAttachmentName(file.name);
      let name = `${stamp}-${safe}`;
      let n = 2;
      while (fs.existsSync(path.join(folder, name))) name = `${stamp}-${n++}-${safe}`;
      fs.writeFileSync(path.join(folder, name), bytes);
      kept.push({
        name,
        path: `.synapse/attachments/${name}`,
        mime: String(file.mime || 'application/octet-stream'),
        bytes: bytes.length,
      });
    } catch {
      // Best effort: a kept file that cannot be written must not lose the message.
    }
  }
  return kept;
}
