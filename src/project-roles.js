// The models a project's roles run on.
//
// Every project has one `.project\roles.json`, and it is the project's own set:
// architect, inventor, designer, QC and both coders. The config's `roles` entries
// remain the template — and still carry the skills, instructions and timings — but
// they are not where a project's model choice lives.
//
// Why a file in the project:
//   - the delegation runner can read it synchronously, beside plan.json and
//     runs.jsonl, without an engine round-trip while it is choosing a worker;
//   - a compaction replaces the chat session, not the project, so the set survives;
//   - a moved or renamed project carries it along; there is no path-keyed config
//     to repair.
//
// The file holds only `ref` and `variant` per role. Everything else about a role
// is still global until a future change says otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { ROLES } from './plans.js';
import { markWritten } from './synapse-writes.js';

export const ROLES_FILE = '.project/roles.json';
const VERSION = 1;

const clean = (value) => String(value ?? '').trim();

/** The absolute path of a project's role file. */
export function rolesPath(dir) {
  return path.join(path.resolve(String(dir || '')), ROLES_FILE);
}

/** One role entry, or null when it has no usable ref. */
function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const ref = clean(entry.ref);
  if (!ref) return null;
  const variant = clean(entry.variant);
  return { ref, variant: variant === 'default' ? '' : variant };
}

/**
 * Read a project's role set.
 *
 * Tolerant by design: a missing file is an empty set (the config is then the
 * template), and a malformed file is an empty set rather than an exception that
 * stops a delegation. Unknown role ids are ignored.
 */
export function readProjectRoles(dir) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(rolesPath(dir), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    // A missing or malformed file is an empty set; the config remains the
    // template and the project keeps working.
    return {};
  }
  const source = raw && typeof raw === 'object' && raw.roles && typeof raw.roles === 'object' ? raw.roles : raw;
  if (!source || typeof source !== 'object') return {};
  const out = {};
  for (const role of ROLES) {
    const entry = normalizeEntry(source[role]);
    if (entry) out[role] = entry;
  }
  return out;
}

/**
 * Write a project's role set. Atomic: the reader sees the old file or the whole
 * new one, never a half-written JSON.
 */
export function writeProjectRoles(dir, roles) {
  const target = rolesPath(dir);
  const payload = { version: VERSION, roles: {} };
  for (const role of ROLES) {
    const entry = normalizeEntry(roles?.[role]);
    if (entry) payload.roles[role] = entry;
  }
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, target);
  } catch {
    // Windows can lose the rename to a reader holding the file. Writing the real
    // path once more is slower and still correct; the temporary goes.
    fs.writeFileSync(target, text, 'utf8');
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
  }
  // The records repo and the tamper check see this as a harness write, not a
  // worker's stray edit: the file is written while a worker's turn may be open.
  markWritten(target);
  return payload.roles;
}

/**
 * The effective role set for a project.
 *
 * The project's saved entries win; every other role comes from the config
 * template. `architect` is the migration case: a project that has not written a
 * role file yet keeps the session model it already runs on, instead of jumping
 * back to whatever the config says.
 */
export function effectiveRoles(config, dir, { architect = null } = {}) {
  const saved = readProjectRoles(dir);
  const out = {};
  for (const role of ROLES) {
    const base = config?.roles?.[role] && typeof config.roles[role] === 'object' ? config.roles[role] : {};
    const chosen = saved[role] || (role === 'architect' ? normalizeEntry(architect) : null);
    out[role] = {
      ...base,
      ref: chosen?.ref || base.ref || '',
      variant: chosen ? chosen.variant || '' : base.variant || '',
    };
  }
  return out;
}

/** The model entry for one role in a role map, or null. */
export function roleModel(roles, role) {
  return normalizeEntry(roles?.[role]);
}

/**
 * Overlay a project/seed set on a full template set.
 *
 * The overlay's ref and variant win; the template's other fields (skills,
 * instructions, timings) survive. A role the overlay does not name keeps the
 * template's entry, which is what a new project needs when it inherits only part
 * of a predecessor's set.
 */
export function mergeRoles(template, overlay) {
  const out = {};
  for (const role of ROLES) {
    const base = template?.[role] && typeof template[role] === 'object' ? template[role] : {};
    const own = normalizeEntry(overlay?.[role]);
    out[role] = own ? { ...base, ...own } : { ...base };
  }
  return out;
}
