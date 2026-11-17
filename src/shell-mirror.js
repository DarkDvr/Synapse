// A backgrounded shell's output, copied into the project so a model can read it.
//
// The engine answers a long command with "moved to the background" and a path under its
// own data folder. That folder is closed to models on purpose (AGENTS.md rule 8: the
// harness is read-only), so the one handle a model is given is a file it may not open.
// On 17 Nov a QC run waited on a suite it could not read, ended its turn "waiting", and
// the run completed without its report.
//
// The fix is not a permission exception: the harness copies the file into the project,
// where the model can read it and the operator keeps it — the same rule as the browser
// writing screenshots into `.project/browser/shots/`. The caller mirrors on each poll so
// the copy grows with the command; the brief names the path.
import fs from 'node:fs';
import path from 'node:path';

/** "Command moved to the background (shell ID: sh_x). Output is streaming to: <path>" */
const MOVED = /Command moved to the background \(shell ID:\s*([\w-]+)\)\.?\s*Output is streaming to:\s*(.+?)(?:\s|$)/i;

/** The text a tool part carries, whatever shape the engine gave it. */
const textOf = (part) => {
  const bits = [];
  if (typeof part?.output === 'string') bits.push(part.output);
  if (typeof part?.title === 'string') bits.push(part.title);
  for (const c of Array.isArray(part?.content) ? part.content : []) {
    if (typeof c?.text === 'string') bits.push(c.text);
  }
  return bits.join('\n');
};

/** Every backgrounded shell named in these messages: `[{ id, source }]`. */
export function backgroundShells(messages) {
  const out = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const part of Array.isArray(message?.parts) ? message.parts : []) {
      if (part?.type !== 'tool') continue;
      const match = MOVED.exec(textOf(part));
      if (!match) continue;
      const id = String(match[1]).trim();
      const source = String(match[2]).trim().replace(/^["']|["']$/g, '');
      if (id && source && !out.has(id)) out.set(id, { id, source });
    }
  }
  return [...out.values()];
}

/** Where a mirrored copy lives: inside the project, beside the other evidence. */
export const mirrorPath = (dir, id) => path.join(String(dir || ''), '.project', 'logs', `shell-${id}.out`);

/**
 * Copy each shell's output into the project. Returns the ids whose copy moved.
 *
 * Called on every poll, so the copy grows with the command. A file the engine is still
 * writing can be locked for a moment on Windows; that is a retry next poll, not a
 * failure, so it is a warning and not a throw.
 */
export function mirrorShells(dir, shells, { log = null } = {}) {
  const copied = [];
  if (!dir || !Array.isArray(shells) || !shells.length) return copied;
  for (const { id, source } of shells) {
    try {
      if (!fs.existsSync(source)) continue;
      const target = mirrorPath(dir, id);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      copied.push(id);
    } catch (err) {
      log?.warn?.(`could not mirror the output of ${id}: ${err.message}`);
    }
  }
  return copied;
}

/** What the brief tells a model about the copy. Short on purpose: it is re-read every step. */
export const MIRROR_RULE =
  'If the engine moves a command to the background, its output is copied to ' +
  '`.project/logs/shell-<id>.out` — read that file, and do not end the turn waiting.';

/** The same news, for a turn that was not briefed with the rule (a chat): a steer. */
export const mirrorSteer = (id) =>
  `The engine moved that command to the background. Its output is being copied to ` +
  `.project/logs/shell-${id}.out — read that file, and read it again while the command ` +
  `runs; do not end the turn waiting.`;

/** The engine's own copy of a backgrounded command: …\data\opencode\shell\<hash>\sh_<id>.out */
const ENGINE_COPY = /((?:[A-Za-z]:)?[\\/][^\s"']*?data[\\/]engine[\\/]opencode[\\/]data[\\/]opencode[\\/]shell[\\/][^\s"']*?[\\/](sh_[\w-]+)\.out)/i;

/**
 * A refused read of the engine's own shell copy: mirror it into the project and return
 * the path, so the refusal can tell the model where to look instead.
 *
 * This is the reactive half of the same rule. The proactive half is the runner's mirror;
 * this one catches the moment a model actually reaches for the engine path, which is when
 * it most needs to be told the copy exists.
 */
export function adoptEngineCopy(paths, dir, { log = null } = {}) {
  if (!dir) return null;
  for (const value of Array.isArray(paths) ? paths : [paths]) {
    const match = ENGINE_COPY.exec(String(value || ''));
    if (!match) continue;
    const source = match[1];
    const id = match[2];
    try {
      if (!fs.existsSync(source)) continue;
      const target = mirrorPath(dir, id);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      return { id, path: target };
    } catch (err) {
      log?.warn?.(`could not mirror ${id}: ${err.message}`);
    }
  }
  return null;
}

