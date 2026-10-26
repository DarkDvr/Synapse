// Watching the harness's own files while models run.
//
// The permission ruleset (src/permissions.js) is the prevention: every write
// asks, and a write inside the harness is refused. This file is the detection
// behind it, because prevention has holes a path rule cannot see. Two:
//
//   inspect()  detection, attributed. A write or an edit tool call that names a
//              path inside the harness. It reads the transcript Synapse already
//              fetched, so it costs nothing and cannot slow a turn down.
//   state()    detection, unattributed. `git status --porcelain` before and after
//              a run: whatever the harness shows afterwards that it did not show
//              before happened while nobody was looking, however it happened — a
//              shell redirect, a tool the ruleset does not cover.
//
// Neither can undo a write. The restore points are ordinary git commits in
// the harness repository (`snapshot()` before each delegation), which is the other
// reason a project never lives inside the harness: a `git add -u` here can never
// stage a project's deliverables, because none of them are in this repository.
import { execFile } from 'node:child_process';

const WRITE_TOOLS = /^(write|edit)$/;
const SHELL_TOOLS = /^(shell|bash|execute)$/;

// A shell command is judged on what it does to the harness, not on the fact that
// it names it. `skills/` is the harness's toolbox — the visual-review renderer,
// the design briefs — and running one is ordinary tool use, already in the
// transcript, the census and the session log. On the clock runs every render was a
// red alarm about the feature working as designed.
//
// So a command that names nothing but `skills/` is quiet. A *redirect* into the
// harness is still an alarm whatever it names, because that is the one shape that
// writes without a path a tool could check. `2>&1` is not a redirect to a file.
const REDIRECT_INTO = /(?:^|[^0-9&])>>?\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g;

// And a command that only *looks* is not tampering either. In Timer Test 1 a
// worker could not find the renderer its skill named, so it listed Synapse's own
// folders to find it — `Get-ChildItem … F:\dev\Synapse\skills -Recurse` — and that
// harmless read raised the alarm the operator sees as a popup. Every model that
// cannot find a tool does this first, so the popup was guaranteed. A command made
// only of read verbs is logged and not raised; anything else that names the
// harness still rings, because the safe default is to over-report a rare thing
// rather than to miss the write that matters.
//
// Judged **piece by piece**, because a command is a list of them: `cd <project>;
// Get-Content F:\dev\Synapse\logs\app.log -Tail 5` is a read of the harness's own
// log, and reading that log is how the Architect diagnoses its own runs. The old
// rule matched the whole string against a list of verbs starting at character one,
// so `cd` in front of a `Get-Content` was enough to turn a read into a popup — on
// every delegation, since every worker starts by changing directory.
const READ_VERBS = new RegExp(
  '^(?:get|test|resolve|select|where|measure|sort|format|out-string|' +
    'findstr|type|cat|ls|dir|head|tail|more|echo|' +
    'cd|chdir|set-location|push-location|pop-location|sl|pwd)\\b',
  'i',
);

/** The pieces a shell would run in sequence. Quote-aware: a `;` inside a string is
 *  part of an argument, not a second command. */
function segmentsOf(command) {
  const text = String(command || '');
  const out = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === ';' || char === '|') { out.push(current); current = ''; continue; }
    if (char === '&' && text[i + 1] === '&') { out.push(current); current = ''; i += 1; continue; }
    current += char;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Does every piece of this command only look? */
function onlyReads(command) {
  for (let piece of segmentsOf(command)) {
    piece = piece.replace(/^\(\s*/, '').replace(/\)+$/, '').trim();
    // `$a = Get-Content …` is the same read, and `$a` on its own reads the variable.
    const assigned = piece.match(/^\$\w+\s*=\s*(.*)$/);
    if (assigned) piece = assigned[1].trim();
    if (!piece || /^\$[\w.:]+$/.test(piece)) continue;
    if (!READ_VERBS.test(piece)) return false;
  }
  return true;
}

/** Could a script inside the harness be running, whatever it is named? */
const RUNS_HARNESS_CODE = /\b(?:node|nodejs|pwsh|powershell|python|python3|deno|bun|cmd|sh)\b[^;&|]*\.(?:js|mjs|cjs|ps1|py|bat|cmd)\b/i;

export function createHarnessGuard({ root, logger, notify }) {
  const log = logger.channel('app');
  const asKey = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
  const rootKey = asKey(root);

  /** Is this path (or this command text) inside the harness? */
  const inHarness = (value) => {
    const key = asKey(value);
    return Boolean(key) && (key === rootKey || key.includes(`${rootKey}/`));
  };

  const skillsKey = `${rootKey}/skills/`;

  /** The harness paths a command names, as keys. Split on shell punctuation, so a
   *  quoted path with spaces survives and a path inside a pipe still counts. */
  const harnessPathsIn = (command) =>
    String(command || '')
      .split(/[\s"'`;|&()<>,]+/)
      .filter(Boolean)
      .map(asKey)
      .filter((token) => token === rootKey || token.includes(`${rootKey}/`));

  /** Does a redirect in this command aim at a file inside the harness? */
  const redirectsInto = (command) => {
    for (const match of String(command || '').matchAll(REDIRECT_INTO)) {
      const target = String(match[1] || '').replace(/^["']|["']$/g, '');
      if (inHarness(target)) return true;
    }
    return false;
  };

  /** Is this shell command just the harness's own toolbox being used? */
  const runsTheToolbox = (command) => {
    const named = harnessPathsIn(command);
    if (!named.length || !named.every((p) => p.startsWith(skillsKey))) return false;
    return !redirectsInto(command);
  };

  /**
   * Could this command change the harness, or run its code?
   *
   * A read of the harness is worth a log line and not an alarm: `Get-ChildItem`,
   * `Get-Content`, `Select-String` and their like cannot write, whatever they
   * name. Everything else — a redirect, a script inside the harness, any verb not
   * on the read list — is treated as a write risk, which is the safe way round.
   */
  const couldWriteHarness = (command) => {
    const text = String(command || '');
    if (redirectsInto(text)) return true;
    if (RUNS_HARNESS_CODE.test(text)) return true;
    return !onlyReads(text);
  };

  /**
   * What a transcript touched inside the harness. Only write-shaped tools name a
   * path, so those are reported as writes. A shell command is split in two: one
   * that could change the harness is reported verbatim, because reading it is
   * harmless but it is also how a write would go around a path rule; one that
   * only looks is returned separately, for the log and never for the alarm.
   */
  function inspect(messages) {
    const writes = new Set();
    const shells = new Set();
    const reads = new Set();
    for (const message of messages || []) {
      for (const part of message?.parts || []) {
        if (part?.type !== 'tool') continue;
        const name = String(part.name || '');
        const input = part.input && typeof part.input === 'object' ? part.input : {};
        const target = input.filePath || input.file_path || input.path || '';
        if (WRITE_TOOLS.test(name) && inHarness(target)) writes.add(String(target));
        if (SHELL_TOOLS.test(name) && harnessPathsIn(input.command).length && !runsTheToolbox(input.command)) {
          const shown = String(input.command).replace(/\s+/g, ' ').slice(0, 160);
          if (couldWriteHarness(input.command)) shells.add(shown);
          else reads.add(shown);
        }
      }
    }
    return { writes: [...writes], shells: [...shells], reads: [...reads] };
  }

  /** Say it loudly, once, in both places the operator looks: the log and the UI. */
  function alarm({ sessionId, what, paths, note }) {
    const list = (paths || []).join(' | ');
    log.error(`HARNESS ${what}${sessionId ? ` (${sessionId})` : ''}: ${list}${note ? ` — ${note}` : ''}`);
    try {
      notify?.({ kind: 'alarm', type: 'tamper', sessionId, what, paths, note });
    } catch { /* a broken listener must not break a run */ }
  }

  /** Report a turn's own tool calls. Cheap: the caller already has the messages. */
  const checked = new Map(); // sessionId -> Set of message ids already inspected

  function checkTurn({ sessionId, messages, label }) {
    // Every finished turn is handed the whole transcript, so a call from an hour
    // ago arrived again on every later turn and rang the same alarm each time
    // (measured 26 Oct: three identical alarms for one command). The alarm is
    // about a call, not about how many turns have finished since it.
    let seen = checked.get(sessionId);
    if (!seen) {
      seen = new Set();
      checked.set(sessionId, seen);
    }
    const fresh = (messages || []).filter((message) => !message?.id || !seen.has(message.id));
    for (const message of messages || []) if (message?.id) seen.add(message.id);
    const { writes, shells, reads } = inspect(fresh);
    if (writes.length) alarm({ sessionId, what: 'WRITE INSIDE THE HARNESS', paths: writes, note: label });
    if (shells.length) {
      alarm({ sessionId, what: 'shell command naming the harness', paths: shells, note: label });
    }
    for (const read of reads) log.info(`read the harness${label ? ` (${label})` : ''}: ${read}`);
    return { writes, shells, reads };
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
      log.info(`harness snapshot committed (${label}) — ${files.split('\n').length} file(s)`);
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

  return { inspect, checkTurn, alarm, snapshot, state, changed, inHarness };
}
