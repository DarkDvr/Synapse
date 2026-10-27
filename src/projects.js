// Projects are directories.
//
// The engine scopes every session to a working directory, so a project is
// simply a directory that owns sessions — there is no parallel concept to keep
// in sync. This store only remembers the ones the operator has added, in
// data/projects.json. There is no built-in project: an empty registry is an
// empty app, and the projects root is created when it is missing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const idFor = (dir) => crypto.createHash('sha1').update(dir.toLowerCase()).digest('hex').slice(0, 12);

export function normalizeDir(dir) {
  const resolved = path.resolve(String(dir ?? '').trim());
  // strip a trailing separator so comparisons are stable on Windows
  return resolved.replace(/[\\/]+$/, '');
}

const key = (dir) => normalizeDir(dir).toLowerCase();

/** One spelling for comparing two paths on this machine: folded case, one
 *  separator, no trailing slash. */
const fold = (dir) => normalizeDir(dir).replace(/\//g, '\\').toLowerCase();

/**
 * May this folder be sent to the Recycle Bin as a deleted project?
 *
 * Deleting a project removes its folder whole, and the folder is the operator's,
 * so the refusals are explicit and provable rather than "it will be fine". The
 * three that must never happen: a drive root, the projects root itself, and the
 * harness — or anything that contains it, because `F:\dev` is somebody's project
 * folder and `F:\dev\Synapse` is this program.
 *
 * Everything else is allowed. The bin is the undo, which is what makes that safe.
 */
export function mayRecycleFolder(dir, { projectsRoot = '', harness = '' } = {}) {
  const absolute = path.resolve(String(dir ?? '').trim());
  const target = normalizeDir(absolute);
  if (!target) return { ok: false, reason: 'there is no folder to delete' };
  // A root is the one path whose parent is itself — `F:\`, `\\server\share`. Tested
  // before the normalised form, because stripping the trailing separator turns `F:\`
  // into `F:`, which is a drive-relative path and not a root at all.
  if (path.dirname(absolute) === absolute) return { ok: false, reason: `${absolute} is a drive root` };
  if (projectsRoot && fold(target) === fold(projectsRoot)) {
    return { ok: false, reason: `${target} is the projects root, which holds every project` };
  }
  if (harness) {
    if (fold(target) === fold(harness)) return { ok: false, reason: `${target} is Synapse itself` };
    if (fold(harness).startsWith(`${fold(target)}\\`)) {
      return { ok: false, reason: `${target} contains Synapse` };
    }
  }
  return { ok: true, reason: '' };
}

export function createProjectStore({ file, rootDir, legacyGeneralDir = null, logger }) {
  const log = logger.channel('app');

  // The projects root is ours and lives inside the harness's sibling folder; a
  // first run has no projects and no folder, and creating it here means "New
  // Project" works before anything else has.
  try {
    if (rootDir) fs.mkdirSync(rootDir, { recursive: true });
  } catch (err) {
    log.warn(`could not create the projects folder (${err.message})`);
  }

  const readRaw = () => {
    try {
      if (!fs.existsSync(file)) return [];
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
      const list = Array.isArray(parsed?.projects) ? parsed.projects : [];
      return list.filter((p) => p && typeof p.directory === 'string' && p.directory.trim());
    } catch (err) {
      log.warn(`projects.json unreadable (${err.message}); treating the registry as empty`);
      return [];
    }
  };

  const writeRaw = (projects) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ projects }, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  };

  const shape = (p) => ({
    id: p.id || idFor(p.directory),
    name: p.name || path.basename(p.directory) || p.directory,
    directory: normalizeDir(p.directory),
    created: p.created ?? null,
    exists: fs.existsSync(normalizeDir(p.directory)),
  });

  /**
   * The old built-in "General" folder becomes an ordinary project, once.
   *
   * It used to be synthesised at boot and could not be deleted. Removing the
   * concept must not remove the work that lives in that folder, so the first
   * boot after the change adopts it: same name, same directory, now deletable
   * like any other project. A registry that already names it is left alone.
   */
  function adoptLegacyGeneral() {
    if (!legacyGeneralDir) return;
    const dir = normalizeDir(legacyGeneralDir);
    if (!fs.existsSync(dir)) return;
    const raw = readRaw();
    if (raw.some((p) => key(p.directory) === key(dir))) return;
    writeRaw([...raw, { id: idFor(dir), name: 'General', directory: dir, created: Date.now() }]);
    log.info(`adopted the old General folder as an ordinary project: ${dir}`);
  }
  try {
    adoptLegacyGeneral();
  } catch (err) {
    log.warn(`could not adopt the old General folder (${err.message})`);
  }

  /**
   * All projects, in the order they were added. No synthetic entry: an empty
   * registry is an empty rail.
   *
   * No sort: the registry file is a ledger, and the operator reads it as one - a new
   * project appears at the bottom, where they just added it, instead of jumping into
   * the middle of an alphabetical list. Sorting by name also moved every row when a
   * project was renamed, which is the one moment you are looking for it. */
  function list() {
    const seen = new Set();
    const out = [];
    for (const p of readRaw()) {
      const k = key(p.directory);
      if (seen.has(k)) continue;
      seen.add(k);
      const shaped = shape(p);
      // A project whose folder is gone is not shown. On a copied folder the registry
      // still names the machine it came from, and a row nobody can open is noise —
      // the operator's rule is that a missing folder fails silently.
      if (!shaped.exists) continue;
      out.push(shaped);
    }
    return out;
  }

  /**
   * Forget registry entries whose folder no longer exists. Run once at boot.
   *
   * A project *is* its directory: with the directory gone there is nothing to open,
   * rename or plan, and leaving the entry to explain itself every session is worse than
   * removing it. Nothing is lost that cannot be recovered — adding the folder again
   * adopts it, sessions and plan included. The cost is that a project on a drive that
   * is temporarily unplugged is forgotten; that was the operator's explicit choice.
   */
  function pruneMissing() {
    const kept = [];
    const gone = [];
    for (const p of readRaw()) {
      const dir = normalizeDir(p.directory);
      if (fs.existsSync(dir)) kept.push(p);
      else gone.push(p.name || dir);
    }
    if (!gone.length) return gone;
    try { writeRaw(kept); } catch (err) { log.warn(`could not drop projects that are no longer on this machine (${err.message})`); }
    log.info(`no longer on this machine, so no longer listed: ${gone.join(', ')}`);
    return gone;
  }

  const find = (id) => list().find((p) => p.id === id) || null;

  /**
   * Add a project. The directory is created when missing: the engine refuses to
   * run a session in a directory that does not exist.
   */
  function create({ name, directory } = {}) {
    // No directory means "make me one" — and it belongs beside the other
    // projects, never in the process's working directory. `path.resolve('')` is
    // the cwd, which is the harness itself: a name-only create used to register
    // F:\dev\Synapse as a project.
    const asked = String(directory || '').trim();
    const slug =
      String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '') || `project-${Date.now()}`;
    const dir = asked ? normalizeDir(asked) : path.join(rootDir, slug);
    if (!dir) {
      const err = new Error('a project needs a directory');
      err.status = 400;
      throw err;
    }
    const all = list();
    if (all.some((p) => key(p.directory) === key(dir))) {
      const err = new Error(`"${dir}" is already a project`);
      err.status = 409;
      throw err;
    }

    let created = false;
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        created = true;
      } catch (err) {
        const e = new Error(`could not create ${dir}: ${err.message}`);
        e.status = 400;
        throw e;
      }
    }

    const project = {
      id: idFor(dir),
      name: String(name || '').trim() || path.basename(dir) || dir,
      directory: dir,
      created: Date.now(),
    };
    writeRaw([...readRaw(), project]);
    log.info(`project added: ${project.name} -> ${dir}${created ? ' (directory created)' : ''}`);
    return shape(project);
  }

  function update(id, { name } = {}) {
    const raw = readRaw();
    const current = raw.find((p) => (p.id || idFor(p.directory)) === id);
    if (!current) {
      const err = new Error('project not found');
      err.status = 404;
      throw err;
    }
    const next = String(name ?? '').trim();
    if (next) current.name = next;
    writeRaw(raw);
    return shape(current);
  }

  function remove(id) {
    const raw = readRaw();
    const next = raw.filter((p) => (p.id || idFor(p.directory)) !== id);
    if (next.length === raw.length) {
      const err = new Error('project not found');
      err.status = 404;
      throw err;
    }
    // Nothing on disk is touched: the registry only decides what Synapse shows.
    writeRaw(next);
    log.info(`project removed from registry: ${id}`);
    return true;
  }

  return { list, find, create, update, remove, idFor, normalizeDir, pruneMissing };
}
