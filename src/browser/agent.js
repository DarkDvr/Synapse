// The action layer: agent-browser, a native Windows CLI that speaks to our Edge over CDP.
//
// Why it exists instead of more CDP code here: a model needs the page as *elements with
// names and refs* (`button "Manual download" [ref=e145]`), not as a picture with
// coordinates. agent-browser builds that accessibility snapshot, fails a click when the
// element is covered or hidden instead of silently missing it, and keeps one daemon per
// session between calls. It never launches its own browser here: every call carries
// `--cdp <port>` and attaches to the Edge Synapse already owns.
//
// No npm: the binary is vendored in `bin\agent-browser`, like the engine. The wrapper is
// deliberately thin — one process per tool call, JSON on stdout, a clear error otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.SYNAPSE_HARNESS || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN_DIR = path.join(ROOT, 'bin', 'agent-browser');

/** Where the binary lives, or null when the provision step has not run. */
export function agentBinary({ root = ROOT } = {}) {
  const candidates = [
    path.join(root, 'bin', 'agent-browser', 'agent-browser.exe'),
    path.join(root, 'bin', 'agent-browser.exe'),
    path.join(root, 'bin', 'agent-browser', 'agent-browser'),
  ];
  for (const file of candidates) {
    try { if (fs.statSync(file).isFile()) return file; } catch { /* not here */ }
  }
  return null;
}

/** The arguments for one call: globals first, then the command and its operands. */
export function agentArgs({ port, session = 'synapse', config = null, json = true }, argv = []) {
  const args = [];
  if (config) args.push('--config', String(config));
  args.push('--cdp', String(port), '--session', String(session));
  if (json) args.push('--json');
  args.push(...argv.map(String));
  return args;
}

/** agent-browser answers one JSON object; take the last line that is one. */
export function parseAgentJSON(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('agent-browser said nothing');
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const value = JSON.parse(lines[i]);
      if (value && typeof value === 'object' && ('success' in value || 'result' in value)) return value;
    } catch { /* a progress line, not the answer */ }
  }
  throw new Error(`agent-browser answered something that is not JSON: ${text.slice(0, 300)}`);
}

/** `e145` and `@e145` are the same ref; a selector is passed through untouched. */
export function normalizeRef(ref) {
  const value = String(ref || '').trim();
  if (!value) return '';
  return /^[a-zA-Z]?\d+$/.test(value) ? (value.startsWith('@') ? value : `@${value}`) : value;
}

/**
 * Open the action layer for one browser. `available` is false when the binary was never
 * provisioned; every method then throws with the fix, rather than pretending it works.
 */
export function createAgent({ port, log = null, session = 'synapse', root = ROOT } = {}) {
  const binary = agentBinary({ root });
  const socketDir = path.join(root, 'data', 'browser', 'sockets');
  const configFile = path.join(root, 'data', 'browser', 'agent-browser.json');
  let saidMissing = false;

  if (binary) {
    try {
      fs.mkdirSync(socketDir, { recursive: true });
      fs.mkdirSync(path.dirname(configFile), { recursive: true });
      // A trusted, minimal config: the daemon must not pick up a user-level
      // ~/.agent-browser/config.json on a machine Synapse does not own. `idleTimeout` is a
      // string in this CLI ("0" disables it), and the file is rewritten so a bad one from
      // an older build cannot poison every call.
      fs.writeFileSync(configFile, JSON.stringify({ idleTimeout: '0' }, null, 2), 'utf8');
    } catch (err) {
      log?.warn?.(`browser: could not prepare agent-browser folders: ${err.message}`);
    }
  }

  const env = {
    ...process.env,
    AGENT_BROWSER_SOCKET_DIR: socketDir,
    AGENT_BROWSER_CDP: String(port || ''),
    AGENT_BROWSER_IDLE_TIMEOUT_MS: '0',
    AGENT_BROWSER_NO_VERSION_CHECK: '1',
    AGENT_BROWSER_JSON: '1',
  };

  const fail = () => {
    const message = 'agent-browser is not installed in bin\\agent-browser — run vendor-agent-browser.ps1';
    if (!saidMissing) { saidMissing = true; log?.warn?.(message); }
    throw new Error(message);
  };

  const run = (argv, { timeoutMs = 45000 } = {}) =>
    new Promise((resolve, reject) => {
      if (!binary) return fail();
      const args = agentArgs({ port, session, config: configFile }, argv);
      execFile(binary, args, {
        cwd: root,
        env,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
      }, (err, stdout, stderr) => {
        if (err) {
          let said = null;
          try { said = parseAgentJSON(stdout); } catch { /* not JSON */ }
          const message = said?.error || String(stderr || '').trim() || err.message;
          reject(new Error(message));
          return;
        }
        try {
          const value = parseAgentJSON(stdout);
          if (value.success === false) { reject(new Error(value.error || 'agent-browser failed')); return; }
          resolve(value.data ?? value.result ?? {});
        } catch (parseError) {
          reject(parseError);
        }
      });
    });

  return {
    available: Boolean(binary),
    binary,
    /** The page as controls with stable refs, one element per line. */
    async snapshot({ interactive = true, compact = false, depth = null, selector = null } = {}) {
      const argv = ['snapshot'];
      if (interactive) argv.push('-i');
      if (compact) argv.push('-c');
      if (depth) argv.push('-d', String(depth));
      if (selector) argv.push('-s', String(selector));
      const data = await run(argv);
      return String(data.snapshot || data.text || data.tree || '');
    },
    /** Click a ref from a snapshot. agent-browser refuses a covered or hidden target. */
    async click(ref) {
      const value = normalizeRef(ref);
      if (!value) throw new Error('a ref is needed — take one from snapshot');
      await run(['click', value]);
      return value;
    },
    /** Replace a field's contents (a clear then a fill), by ref. */
    async fill(ref, text) {
      const value = normalizeRef(ref);
      if (!value) throw new Error('a ref is needed — take one from snapshot');
      await run(['fill', value, String(text ?? '')]);
      return value;
    },
    /** Type into a field by ref, as the page's own input events expect. */
    async type(ref, text) {
      const value = normalizeRef(ref);
      if (!value) throw new Error('a ref is needed — take one from snapshot');
      await run(['type', value, String(text ?? '')]);
      return value;
    },
    async press(key) {
      await run(['press', String(key)]);
    },
    /** Stop the daemon; the browser itself is closed by the caller. */
    async close() {
      if (!binary) return false;
      try { await run(['close'], { timeoutMs: 15000 }); return true; } catch { /* the daemon may already be gone */ return false; }
    },
  };
}

/** Where the daemon keeps its sockets, for tests and logs. */
export function agentSocketDir({ root = ROOT } = {}) {
  return path.join(root, 'data', 'browser', 'sockets');
}

export { BIN_DIR };
