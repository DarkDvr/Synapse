// Logging: the readable story in one file per channel, the deep detail in one file
// of its own, with size rotation and age-based cleanup.
//
// The split is deliberate. A channel file (`app.log`, `session.log`, `engine.log`,
// `tools.log`) holds error, warn and info: what Synapse did and what went wrong. It
// is short enough to read, and it is the file to open first.
//
// `debug.log` holds every debug line from every channel, in one timeline, each line
// naming its channel. Debugging a run means following one thing across the harness
// and the engine at once, which is why it is one file and not four. It only grows
// while the operator has the level at Debug, and it is rotated on its own, smaller
// budget, because the chatter is enormous by nature (24,000 reasoning deltas in one
// day, measured 6 Nov).
import fs from 'node:fs';
import path from 'node:path';
import { LOGS_DIR } from './paths.js';

// Lower is more severe. A configured level writes itself and everything above it
// (so info writes error, warn and info, and drops debug).
export const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

/** Where the deep detail goes, whatever the channel. */
export const DEBUG_FILE = 'debug.log';
/** The chatter is rotated much sooner than a channel file. */
const DEBUG_MAX_BYTES = 20 * 1024 * 1024;

function ts() {
  return new Date().toISOString();
}

class Logger {
  constructor() {
    this.level = 'info';
    this.maxBytes = 5 * 1024 * 1024;
    this.retentionDays = 7;
    this.dir = LOGS_DIR;
    this.enabled = { app: true, engine: true, session: true, tools: true };
    this._cleanupTimer = null;
  }

  configure(logging = {}) {
    this.level = LEVELS[logging.level] !== undefined ? logging.level : 'info';
    this.maxBytes = (Number(logging.maxFileMb) || 5) * 1024 * 1024;
    this.retentionDays = Number(logging.retentionDays) || 7;
    this.enabled = { app: true, engine: true, session: true, tools: true, ...(logging.channels || {}) };
    // Tests point this at a temp folder; the app never passes it.
    if (logging.dir) this.dir = logging.dir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  _file(channel) {
    return path.join(this.dir, `${channel}.log`);
  }

  _rotate(file, maxBytes = this.maxBytes) {
    try {
      const st = fs.statSync(file);
      if (st.size < maxBytes) return;
      const prev = file.replace(/\.log$/, '.1.log');
      fs.rmSync(prev, { force: true });
      fs.renameSync(file, prev);
    } catch {
      /* file may not exist yet */
    }
  }

  _write(channel, level, msg) {
    if (this.enabled[channel] === false) return;
    if (LEVELS[level] > LEVELS[this.level]) return;
    const line = `${ts()} [${level.toUpperCase().padEnd(5)}] ${msg}\n`;
    // The console is the operator's quick check: the app channel is Synapse's own
    // narrative, and every warning or error from any channel. An info line from a
    // busy channel (the tool census) would drown it, which is why it is not all —
    // and debug is never mirrored, it is the deep file's business.
    if (level !== 'debug' && (channel === 'app' || level === 'error' || level === 'warn')) {
      process.stdout.write(`[${channel}] ${line}`);
    }
    try {
      if (level === 'debug') {
        // One timeline for all channels, each line saying which one it came from.
        const file = path.join(this.dir, DEBUG_FILE);
        this._rotate(file, DEBUG_MAX_BYTES);
        fs.appendFileSync(file, `${ts()} [DEBUG] [${channel}] ${msg}\n`, 'utf8');
        return;
      }
      const file = this._file(channel);
      this._rotate(file);
      fs.appendFileSync(file, line, 'utf8');
    } catch {
      /* never let logging break the app */
    }
  }

  /** Get a channel-scoped logger. */
  channel(name) {
    return {
      info: (m) => this._write(name, 'info', m),
      warn: (m) => this._write(name, 'warn', m),
      error: (m) => this._write(name, 'error', m),
      debug: (m) => this._write(name, 'debug', m),
    };
  }

  /** Delete rotated/old log files past retention. */
  cleanup() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const cutoff = Date.now() - this.retentionDays * 86400000;
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.endsWith('.log')) continue;
        const file = path.join(this.dir, name);
        const st = fs.statSync(file);
        if (st.mtimeMs < cutoff) fs.rmSync(file, { force: true });
      }
    } catch {
      /* ignore */
    }
  }

  /** Run cleanup now and every 6 hours. */
  startCleanupLoop() {
    this.cleanup();
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
    this._cleanupTimer = setInterval(() => this.cleanup(), 6 * 3600000);
    this._cleanupTimer.unref?.();
  }
}

export const logger = new Logger();
