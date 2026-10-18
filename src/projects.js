// Projects are directories.
//
// The engine scopes every session to a working directory, so a project is
// simply a directory that owns sessions — there is no parallel concept to keep
// in sync. This store only remembers the ones the operator has added, in
// data/projects.json. "General" is its own folder (GENERAL_DIR), synthesised at
// boot, and is always present, first, and undeletable.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const idFor = (dir) => crypto.createHash('sha1').update(dir.toLowerCase()).digest('hex').slice(0, 12);

export const GENERAL_ID = 'general';

export function normalizeDir(dir) {
  const resolved = path.resolve(String(dir ?? '').trim());
  // strip a trailing separator so comparisons are stable on Windows
  return resolved.replace(/[\\/]+$/, '');
}

const key = (dir) => normalizeDir(dir).toLowerCase();

export function createProjectStore({ file, generalDir, logger }) {
  const log = logger.channel('app');

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

  const shape = (p, general = false) => ({
    id: p.id || idFor(p.directory),
    name: p.name || path.basename(p.directory) || p.directory,
    directory: normalizeDir(p.directory),
    general,
    created: p.created ?? null,
    exists: fs.existsSync(normalizeDir(p.directory)),
  });

  const general = () => shape({ id: GENERAL_ID, name: 'General', directory: generalDir, created: null }, true);

  /** All projects, General first. Stored duplicates of the General directory are hidden. */
  function list() {
    const g = general();
    const seen = new Set([key(g.directory)]);
    const rest = [];
    for (const p of readRaw()) {
      const k = key(p.directory);
      if (seen.has(k)) continue;
      seen.add(k);
      rest.push(shape(p));
    }
    rest.sort((a, b) => a.name.localeCompare(b.name));
    return [g, ...rest];
  }

  const find = (id) => list().find((p) => p.id === id) || null;

  /**
   * Add a project. The directory is created when missing: the engine refuses to
   * run a session in a directory that does not exist.
   */
  function create({ name, directory } = {}) {
    const dir = normalizeDir(directory);
    if (!dir) {
      const err = new Error('a project needs a directory');
      err.status = 400;
      throw err;
    }
    if (key(dir) === key(general().directory)) {
      const err = new Error('that directory is the General project');
      err.status = 409;
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
    if (id === GENERAL_ID) {
      const err = new Error('General cannot be renamed');
      err.status = 400;
      throw err;
    }
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
    if (id === GENERAL_ID) {
      const err = new Error('General cannot be removed');
      err.status = 400;
      throw err;
    }
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

  return { list, find, create, update, remove, general, idFor, normalizeDir };
}
