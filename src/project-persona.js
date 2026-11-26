// A project's Single-mode persona.
//
// It is not a role and not a model setting: it is the voice the Architect uses in
// one project while that project is in Single mode. The file lives inside the
// project's own `.project` folder, so a private project's persona is inside the
// same fence as the rest of its records. It is deliberately not in the config
// file, the project document or the project's records history.
import fs from 'node:fs';
import path from 'node:path';

export const PERSONA_NAME = 'persona.json';
export const PERSONA_MAX_NAME = 40;
export const PERSONA_MAX_TEXT = 2000;

/** The persona file inside a project's records folder. */
export function personaPath(dir) {
  return path.join(String(dir || ''), '.project', PERSONA_NAME);
}

const cleanName = (value) =>
  String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PERSONA_MAX_NAME);

const cleanText = (value) =>
  String(value || '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, PERSONA_MAX_TEXT);

/**
 * Read a project's persona, or null when there is none.
 *
 * A malformed file is not an error the chat should carry: it means "no persona",
 * and the operator can overwrite it from the persona editor. This is the same
 * tolerance the plan and the project document use.
 */
export function readPersona(dir) {
  if (!dir) return null;
  try {
    const raw = fs.readFileSync(personaPath(dir), 'utf8');
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const name = cleanName(parsed.name);
    const instructions = cleanText(parsed.instructions);
    if (!name && !instructions) return null;
    return { name, instructions };
  } catch {
    return null;
  }
}

/** Save a persona, or remove it when both fields are empty. */
export function writePersona(dir, body = {}) {
  if (!dir) throw new Error('a project folder is required');
  const name = cleanName(body?.name);
  const instructions = cleanText(body?.instructions);
  const file = personaPath(dir);
  if (!name && !instructions) {
    try { fs.rmSync(file, { force: true }); } catch { /* already gone is the wanted state */ }
    return null;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ name, instructions }, null, 2)}\n`, 'utf8');
  return { name, instructions };
}

/** Drop the persona file without touching anything else in `.project`. */
export function removePersona(dir) {
  return writePersona(dir, {});
}
