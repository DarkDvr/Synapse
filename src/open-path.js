// Opening a file the chat named, without turning the chat into a command line.
//
// The model writes paths, and a path in a card is a thing the operator can act on.
// The action is always the same two: open the file, or open its folder with the file
// selected. What it is never allowed to be is arbitrary: the path has to resolve
// inside the project the chat belongs to, so a card cannot make Synapse launch
// something from another project, the harness or the operator's profile.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Is `child` the same as, or under, `parent`? Case-insensitive on Windows. */
export function inside(child, parent) {
  const c = process.platform === 'win32' ? String(child).toLowerCase() : String(child);
  const p = process.platform === 'win32' ? String(parent).toLowerCase() : String(parent);
  // A drive root (`C:\`) already ends in a separator; appending another would make
  // the prefix `C:\\`, which no child starts with.
  const prefix = p.endsWith(path.sep) ? p : p + path.sep;
  return c === p || c.startsWith(prefix) || c.startsWith(`${p}/`);
}

/**
 * Resolve what a card named against its project folder.
 *
 * Returns `{ path, exists, isDir, parent }` for a path that may be opened, or
 * `{ error }` for one that may not: `empty`, `outside` or `missing`. A missing path
 * still carries `parent` when that folder exists, because "Open Folder" on a file
 * that has been deleted should land somewhere useful rather than say nothing.
 */
export function resolveProjectPath(base, rel) {
  const raw = String(rel || '').trim();
  if (!raw) return { error: 'empty' };
  const root = path.resolve(String(base || ''));
  // A card can carry a `file:///` URI; the rest of the engine speaks plain paths.
  const plain = raw.replace(/^file:\/\/\/?/i, '');
  const target = path.resolve(root, plain);
  if (!inside(target, root)) return { error: 'outside' };

  let exists = false;
  try {
    exists = fs.existsSync(target);
  } catch {
    // An unreadable path is not openable; the same answer as a missing one.
    exists = false;
  }
  if (!exists) {
    const parent = path.dirname(target);
    if (!inside(parent, root)) return { error: 'outside' };
    let parentExists = false;
    try {
      parentExists = fs.existsSync(parent);
    } catch {
      // The same rule one level up: a parent we cannot inspect cannot be opened.
      parentExists = false;
    }
    return parentExists ? { error: 'missing', path: target, parent } : { error: 'missing' };
  }

  let real;
  try {
    real = fs.realpathSync(target);
  } catch {
    // The file vanished between the check and the resolve; treat it as gone.
    return { error: 'missing', path: target, parent: path.dirname(target) };
  }
  // A junction or symlink can point out of the project even though the spelling
  // looked inside it. The real path is the one that decides.
  if (!inside(real, root)) return { error: 'outside' };
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    // The target changed under us; it is not a file that can be opened now.
    return { error: 'missing', path: real, parent: path.dirname(real) };
  }
  return {
    path: real,
    exists: true,
    isDir: stat.isDirectory(),
    parent: path.dirname(real),
  };
}

/**
 * The argument Explorer needs: a folder opens as itself, a file opens with its
 * associated app, and `select` reveals the file in its folder instead.
 *
 * `/select,<path>` is one argument on purpose. Explorer's own parser wants the
 * comma and the path together; handing it `/select,` and the path as two arguments
 * makes it open the folder without selecting anything.
 */
export function explorerArgs(resolved, { select = false } = {}) {
  return select && !resolved.isDir ? [`/select,${resolved.path}`] : [resolved.path];
}

/**
 * Open a resolved path in Explorer.
 *
 * Explorer is spawned directly with an argument array — never a shell string — so
 * a file name cannot become a command.
 */
export function openInExplorer(resolved, { select = false } = {}) {
  const args = explorerArgs(resolved, { select });
  const child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore' });
  child.unref();
  return args;
}
