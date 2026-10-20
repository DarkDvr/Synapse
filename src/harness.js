// Protecting the harness's own files from the models it runs.
//
// Three mechanisms, because they fail differently:
//
//   rules()    prevention. A per-session permission ruleset the engine evaluates
//              before a tool runs: anything the harness owns is denied outright.
//   inspect()  detection, attributed. A write or an edit tool call that names a
//              path inside the harness. It reads the transcript Synapse already
//              fetched, so it costs nothing and cannot slow a turn down.
//   state()    detection, unattributed. `git status --porcelain` before and after
//              a run: whatever the harness shows afterwards that it did not show
//              before happened while nobody was looking, however it happened — a
//              shell redirect, a tool the ruleset does not cover.
//
// None of them can undo a write. The restore points are ordinary git commits in
// the harness repository (`snapshot()` before each delegation), which is the other
// reason a project never lives inside the harness: a `git add -u` here can never
// stage a project's deliverables, because none of them are in this repository.
import { execFile } from 'node:child_process';

const WRITE_TOOLS = /^(write|edit)$/;
const SHELL_TOOLS = /^(shell|bash|execute)$/;

export function createHarnessGuard({ root, logger, notify }) {
  const log = logger.channel('app');
  const asKey = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
  const rootKey = asKey(root);

  /** Is this path (or this command text) inside the harness? */
  const inHarness = (value) => {
    const key = asKey(value);
    return Boolean(key) && (key === rootKey || key.includes(`${rootKey}/`));
  };

  /**
   * The ruleset every session carries: everything allowed, the harness denied.
   *
   * Order matters — the engine takes the LAST matching rule — so the broad allow
   * comes first and the harness deny after it, and the harness rule wins for any
   * path under the harness whatever the action. Appending this to a session's own
   * rules (Single's `subagent` deny, Multi's empty set) rather than replacing them
   * is what keeps the mode switch and this guard independent of each other.
   */
  const rules = () => [
    { action: '*', resource: '*', effect: 'allow' },
    { action: '*', resource: `${root.replace(/\\/g, '/')}/**`, effect: 'deny' },
  ];

  /**
   * What a transcript touched inside the harness. Only write-shaped tools name a
   * path, so those are reported as writes; a shell command that mentions the
   * harness is reported verbatim, because reading it is harmless but it is also
   * how a write would go around a path rule, and the operator should see it.
   */
  function inspect(messages) {
    const writes = new Set();
    const shells = new Set();
    for (const message of messages || []) {
      for (const part of message?.parts || []) {
        if (part?.type !== 'tool') continue;
        const name = String(part.name || '');
        const input = part.input && typeof part.input === 'object' ? part.input : {};
        const target = input.filePath || input.file_path || input.path || '';
        if (WRITE_TOOLS.test(name) && inHarness(target)) writes.add(String(target));
        if (SHELL_TOOLS.test(name) && inHarness(input.command)) {
          shells.add(String(input.command).replace(/\s+/g, ' ').slice(0, 160));
        }
      }
    }
    return { writes: [...writes], shells: [...shells] };
  }

  /** Say it loudly, once, in both places the operator looks: the log and the UI. */
  function alarm({ sessionId, what, paths, note }) {
    const list = (paths || []).join(' | ');
    log.error(`HARNESS ${what}${sessionId ? ` (${sessionId})` : ''}: ${list}${note ? ` — ${note}` : ''}`);
    try {
      notify?.({ kind: 'alarm', type: 'tamper', sessionId, what, paths, note });
    } catch { /* a broken listener must not break a run */ }
  }

  /**
   * Report a turn's own tool calls. Cheap: the caller already has the messages.
   *
   * `trustShell` is for the Architect and the operator's own session, and only
   * for the shell line. The Architect is the one role that is *meant* to reach
   * into the harness: the visual-review skill lives there and the brief tells it
   * to render the build before judging a report. On the clock project eleven of
   * its shells were `shot.mjs` runs, every one of them a red alarm about the
   * feature working as designed. A *write* is still an alarm for everyone — the
   * ruleset denies it as well — and a worker naming the harness is still an
   * alarm, because no worker has business there.
   */
  function checkTurn({ sessionId, messages, label, trustShell = false }) {
    const { writes, shells } = inspect(messages);
    if (writes.length) alarm({ sessionId, what: 'WRITE INSIDE THE HARNESS', paths: writes, note: label });
    if (shells.length) {
      if (trustShell) log.info(`used the harness (${label}): ${shells.join(' | ')}`);
      else alarm({ sessionId, what: 'shell command naming the harness', paths: shells, note: label });
    }
    return { writes, shells };
  }

  const git = (args) =>
    new Promise((resolve, reject) => {
      execFile('git', ['-C', root, ...args], { windowsHide: true, timeout: 30000 }, (err, stdout) =>
        (err ? reject(err) : resolve(String(stdout || ''))),
      );
    });

  /**
   * A restore point, and the baseline for the post-run comparison.
   *
   * `add -u` stages tracked modifications only — never `-A`, so an untracked file
   * of the operator's is never swept into a commit. Nothing to commit is the
   * normal case and is not an error.
   */
  async function snapshot(label) {
    try {
      const staged = async () => (await git(['diff', '--cached', '--name-only'])).trim();
      await git(['add', '-u']);
      const files = await staged();
      if (!files) return { committed: false };
      await git(['commit', '-m', `snapshot: ${label}`]);
      log.info(`harness snapshot committed before ${label} (${files.split('\n').length} file(s))`);
      return { committed: true, files: files.split('\n').length };
    } catch (err) {
      log.warn(`harness snapshot skipped (${label}): ${err.message}`);
      return { committed: false, error: err.message };
    }
  }

  /** The harness's dirty state, for comparing around a run. `null` if git is not
   *  there or this is not a repository — the caller then skips the comparison
   *  rather than inventing one. */
  async function state() {
    try {
      return (await git(['status', '--porcelain'])).trim();
    } catch {
      return null;
    }
  }

  /** Lines that appeared between two states: what changed while nobody looked. */
  const changed = (before, after) => {
    if (before === null || after === null) return [];
    const had = new Set(String(before).split('\n'));
    return String(after).split('\n').filter((line) => line.trim() && !had.has(line));
  };

  return { rules, inspect, checkTurn, alarm, snapshot, state, changed, inHarness };
}
