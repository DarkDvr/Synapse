// Logging: one file per channel under logs/, with size rotation and
// age-based cleanup. Channels: app, engine, session, tools.
import fs from 'node:fs';
import path from 'node:path';
import { LOGS_DIR } from './paths.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function ts() {
  return new Date().toISOString();
}

class Logger {
  constructor() {
    this.level = 'info';
    this.maxBytes = 5 * 1024 * 1024;
    this.retentionDays = 7;
    this.enabled = { app: true, engine: true, session: true, tools: true };
    this._cleanupTimer = null;
  }

  configure(logging = {}) {
    this.level = LEVELS[logging.level] !== undefined ? logging.level : 'info';
    this.maxBytes = (Number(logging.maxFileMb) || 5) * 1024 * 1024;
    this.retentionDays = Number(logging.retentionDays) || 7;
    this.enabled = { app: true, engine: true, session: true, tools: true, ...(logging.channels || {}) };
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }

  _file(channel) {
    return path.join(LOGS_DIR, `${channel}.log`);
  }

  _rotate(file) {
    try {
      const st = fs.statSync(file);
      if (st.size < this.maxBytes) return;
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
    if (channel === 'app' || level === 'error') process.stdout.write(`[${channel}] ${line}`);
    try {
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
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      const cutoff = Date.now() - this.retentionDays * 86400000;
      for (const name of fs.readdirSync(LOGS_DIR)) {
        if (!name.endsWith('.log')) continue;
        const file = path.join(LOGS_DIR, name);
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
