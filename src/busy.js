// Is this project busy, and why.
//
// Busy is a property of the work, never of a click: a run in flight, a turn the
// engine reports as active, or a card waiting to be answered. That is what makes
// the guard safe across a crashed tab — there is nothing to expire.
//
// A project is one conversation in one folder, so a project's busy state is its
// own; two projects never block each other.
const norm = (value) =>
  String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();

const projectName = (directory) => {
  const parts = String(directory || '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || '';
};

/**
 * @returns {{busy: boolean, state?: 'running'|'waiting', kind?: string,
 *   project?: string, directory?: string, sessionId?: string|null,
 *   title?: string|null, role?: string|null, driver?: {name: string}|null}}
 */
export function busyInfo({
  directory,
  active = [],
  sessions = [],
  runs = [],
  permissions = [],
  forms = [],
  driver = null,
} = {}) {
  const dir = norm(directory);
  if (!dir) return { busy: false };

  const base = { busy: true, directory, project: projectName(directory), driver: driver || null };
  const sessionIn = (id) => (sessions || []).find((s) => s.id === id) || null;
  const sameDir = (value) => norm(value) === dir;

  const run = (runs || []).find((r) => sameDir(r.dir || r.directory));
  if (run) {
    return {
      ...base,
      state: 'running',
      kind: 'run',
      sessionId: run.architect || null,
      title: run.title || null,
      role: run.role || null,
    };
  }

  const activeHere = (active || [])
    .map((id) => sessionIn(id))
    .filter((s) => s && sameDir(s.directory));
  if (activeHere.length) {
    const s = activeHere[0];
    return { ...base, state: 'running', kind: 'turn', sessionId: s.id, title: s.title || null, role: null };
  }

  const waiting = (permissions || []).find((p) => sameDir(p.directory));
  if (waiting) {
    return {
      ...base,
      state: 'waiting',
      kind: 'permission',
      sessionId: waiting.sessionId || null,
      title: waiting.title || null,
      role: waiting.role || null,
    };
  }

  const form = (forms || []).find((f) => {
    if (sameDir(f.directory)) return true;
    const s = f.sessionId ? sessionIn(f.sessionId) : null;
    return Boolean(s && sameDir(s.directory));
  });
  if (form) {
    return {
      ...base,
      state: 'waiting',
      kind: 'form',
      sessionId: form.sessionId || null,
      title: form.title || null,
      role: form.role || null,
    };
  }

  return { busy: false, directory, project: projectName(directory) };
}

/**
 * The sentence the refused sender reads. It names the project, what is happening
 * and who started it, because "busy" without a who is a mystery.
 */
export function busyMessage(info) {
  if (!info?.busy) return '';
  const project = info.project || 'This project';
  const who = info.driver?.name ? ` (started from ${info.driver.name})` : '';
  if (info.state === 'waiting') {
    return `${project} is waiting for an answer${who}. Answer the card, or stop it, before sending anything else.`;
  }
  const what = info.role ? `the ${info.role} is working` : 'a session is working';
  return `${project} is busy — ${what}${who}. You can answer its question, or stop it, before sending anything else.`;
}
