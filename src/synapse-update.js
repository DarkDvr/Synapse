// Synapse's own updater.
//
// The release is a GitHub release whose zip carries the program files and nothing
// else: no `data\`, no `config\`, no `logs\`. The download is staged, a detached
// PowerShell helper waits for this app to close, backs up the program files,
// overlays the stage and starts Synapse again. Provider keys, sessions, settings
// and projects are never in the archive, so they cannot be lost by the update.
//
// The repository is private today; a private release feed answers 404, and this
// module says so in words rather than pretending there is no update. Make the
// repository public (or point `update.synapse.feed` at a public mirror) and the
// chip appears.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { DATA_DIR, ROOT } from './paths.js';
import { APP_VERSION } from './version.js';
import { compareVersions } from './engine-update.js';

const CACHE_FILE = path.join(DATA_DIR, 'synapse-update.json');
const UPDATE_DIR = path.join(DATA_DIR, 'update');
const FEED = 'https://api.github.com/repos/DarkDvr/Synapse/releases/latest';

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(value) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(value, null, 2) + '\n', 'utf8');
  } catch { /* the next check tries again */ }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function createSynapseUpdate({ logger, engine, runs, getConfig, notify, quit }) {
  const log = logger.channel('app');
  let inFlight = false;

  const feed = () =>
    String(getConfig?.()?.update?.synapse?.feed || process.env.SYNAPSE_UPDATE_FEED || FEED).trim();

  /** Why an update cannot run now, in the operator's words; null when it can. */
  function blocked() {
    if (process.env.SYNAPSE_SUPERVISED !== '1' || !process.ppid) {
      return 'Synapse is not running under its own window, so it cannot close and reopen itself. Start Synapse.exe and update from there.';
    }
    const live = runs?.active?.() || [];
    if (live.length) {
      const first = live[0];
      return `A delegation is running (${first.task} in ${path.basename(String(first.dir || ''))}). Stop it or wait for it to finish — the update would close Synapse under it.`;
    }
    return null;
  }

  function normalizeRelease(json) {
    const tag = String(json?.tag_name || json?.name || '').replace(/^v/i, '').trim();
    const assets = Array.isArray(json?.assets) ? json.assets : [];
    const zips = assets.filter((a) => /\.zip$/i.test(String(a.name || '')));
    const wanted = zips.find((a) => String(a.name || '').includes(tag)) || zips[0] || null;
    const sums = assets.find((a) => /sha256/i.test(String(a.name || ''))) || null;
    return {
      latest: tag || null,
      notes: String(json?.body || '').trim(),
      url: json?.html_url || null,
      publishedAt: json?.published_at || null,
      asset: wanted
        ? {
            name: String(wanted.name || ''),
            url: String(wanted.browser_download_url || ''),
            size: Number(wanted.size) || 0,
            digest: String(wanted.digest || ''),
          }
        : null,
      sums: sums ? { name: String(sums.name || ''), url: String(sums.browser_download_url || '') } : null,
    };
  }

  /** The cached answer, plus (when online) a fetch that may say why it failed. */
  async function check({ online = false, maxAgeMs = 0 } = {}) {
    const cached = readCache();
    if (!online) {
      return {
        current: APP_VERSION,
        latest: cached?.release?.latest || null,
        newer: Boolean(cached?.release?.latest && compareVersions(cached.release.latest, APP_VERSION) > 0),
        notes: cached?.release?.notes || '',
        url: cached?.release?.url || null,
        publishedAt: cached?.release?.publishedAt || null,
        asset: cached?.release?.asset || null,
        sums: cached?.release?.sums || null,
        checkedAt: cached?.checkedAt || null,
        error: cached?.error || null,
        private: Boolean(cached?.private),
        feed: feed(),
      };
    }
    if (maxAgeMs && !cached?.error && cached?.checkedAt && Date.now() - Date.parse(cached.checkedAt) < maxAgeMs) {
      return check({ online: false });
    }
    try {
      const res = await fetch(feed(), {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'Synapse' },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 404 || res.status === 401) {
        const message =
          'The release feed is private (or does not exist). Make the repository public, or set update.synapse.feed to a public release URL.';
        writeCache({ checkedAt: new Date().toISOString(), error: message, private: true });
        return { ...(await check({ online: false })), error: message, private: true };
      }
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const release = normalizeRelease(await res.json());
      if (!release.latest) throw new Error('the release has no version tag');
      const newer = compareVersions(release.latest, APP_VERSION) > 0;
      writeCache({ checkedAt: new Date().toISOString(), release, error: null });
      log.info(`synapse update: ${APP_VERSION} -> ${release.latest}${newer ? ' (newer)' : ' (current)'}`);
      return {
        current: APP_VERSION,
        ...release,
        newer,
        checkedAt: new Date().toISOString(),
        error: null,
        private: false,
        feed: feed(),
      };
    } catch (err) {
      const message = err?.name === 'TimeoutError' ? 'the check timed out' : err.message;
      writeCache({ checkedAt: new Date().toISOString(), error: message });
      return { ...(await check({ online: false })), error: message };
    }
  }

  async function activeSessions() {
    try {
      return await engine.listActiveSessions();
    } catch (err) {
      if (engine.status().ready) throw err;
      return [];
    }
  }

  async function sha256(file) {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      fs.createReadStream(file)
        .on('data', (chunk) => hash.update(chunk))
        .on('end', () => resolve(hash.digest('hex')))
        .on('error', reject);
    });
  }

  function runPowerShell(command, timeout = 120000) {
    return new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
        { windowsHide: true, timeout, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(String(stderr || stdout || err.message).trim().split(/\r?\n/).slice(-2).join(' / ')));
            return;
          }
          resolve(String(stdout || '').trim());
        },
      );
    });
  }

  async function update({ onLog = () => {} } = {}) {
    if (inFlight) return { ok: false, error: 'an update is already running' };
    const why = blocked();
    if (why) return { ok: false, error: why };
    let active = [];
    try {
      active = await activeSessions();
    } catch (err) {
      return { ok: false, error: `The engine did not report what is running (${err.message}), so Synapse will not close under it.` };
    }
    if (active.length) {
      return { ok: false, error: `A session is mid-turn (${active.length} active). Stop it first — the update would close Synapse under it.` };
    }

    inFlight = true;
    try {
      const state = await check({ online: true });
      if (!state.newer || !state.asset) {
        return { ok: false, error: state.error || 'there is no newer release with a downloadable zip' };
      }
      fs.mkdirSync(UPDATE_DIR, { recursive: true });
      // Keep the release's own file name: SHA256SUMS lists that name, and a
      // checksum that cannot be matched is worse than none.
      const zip = path.join(UPDATE_DIR, path.basename(state.asset.name || `${state.latest}.zip`));
      onLog(`Downloading Synapse ${state.latest}…`);
      const res = await fetch(state.asset.url, {
        headers: { 'user-agent': 'Synapse', accept: 'application/octet-stream' },
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok || !res.body) throw new Error(`the download answered ${res.status}`);
      const total = Number(res.headers.get('content-length')) || state.asset.size || 0;
      const out = fs.createWriteStream(zip);
      let got = 0;
      let shown = -1;
      for await (const chunk of res.body) {
        out.write(chunk);
        got += chunk.length;
        const pct = total ? Math.min(100, Math.floor((got / total) * 100)) : -1;
        if (pct >= 0 && pct !== shown && pct % 5 === 0) {
          shown = pct;
          onLog(`Downloading… ${pct}% (${Math.round(got / 1024 / 1024)} MB)`);
        }
      }
      await new Promise((resolve) => out.end(resolve));

      const digest = await sha256(zip);
      let expected = String(state.asset.digest || '').replace(/^sha256:/i, '').trim();
      if (!expected && state.sums) {
        onLog('Reading the release checksum…');
        const sums = await fetch(state.sums.url, { headers: { 'user-agent': 'Synapse' } });
        const text = await sums.text();
        const name = path.basename(zip);
        for (const line of text.split(/\r?\n/)) {
          const m = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
          if (m && m[2].trim() === name) { expected = m[1].toLowerCase(); break; }
        }
      }
      if (expected && expected.toLowerCase() !== digest) {
        throw new Error('the download does not match the release checksum');
      }
      if (!expected) onLog('No checksum published; the download is trusted by HTTPS only.');
      else onLog('Checksum matches.');

      const stage = path.join(UPDATE_DIR, state.latest);
      fs.rmSync(stage, { recursive: true, force: true });
      fs.mkdirSync(stage, { recursive: true });
      onLog('Unpacking…');
      await runPowerShell(
        `Expand-Archive -LiteralPath ${shellQuote(zip)} -DestinationPath ${shellQuote(stage)} -Force`,
      );
      for (const need of ['Synapse.exe', path.join('src', 'index.js'), path.join('web', 'index.html')]) {
        if (!fs.existsSync(path.join(stage, need))) throw new Error(`the zip is missing ${need}`);
      }

      const helper = path.join(UPDATE_DIR, `apply-${state.latest}.ps1`);
      fs.copyFileSync(path.join(ROOT, 'update-apply.ps1'), helper);
      onLog('Ready. Synapse will close, replace its program files and reopen.');
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', helper,
          '-Root', ROOT, '-Stage', stage, '-ServerPid', String(process.pid),
          '-ShellPid', String(process.ppid), '-Version', state.latest,
        ],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
      child.unref();

      setTimeout(() => {
        try { quit?.(); } catch { /* the helper is already waiting */ }
      }, 900);
      return { ok: true, version: state.latest, closing: true };
    } catch (err) {
      log.error(`synapse update failed: ${err.message}`);
      onLog(`Update failed: ${err.message}`);
      return { ok: false, error: err.message };
    } finally {
      inFlight = false;
    }
  }

  return { check, update, blocked };
}
