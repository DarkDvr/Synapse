// Synapse API — a stable, engine-agnostic surface for the UI.
// Handlers call the engine adapter; nothing here knows about OpenCode.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { appendRun, readPlan, readRuns, runLedger, briefSession, logPlanState, BRIEF_KEY } from './plans.js';
import { ensureProjectDoc, appendRequest as appendProjectRequest, appendChat, appendDecision as appendProjectDecision, appendEntry, setHandover } from './project-doc.js';
import { createFormAuto } from './form-auto.js';
import { answerTimeoutMs, formPages } from './auto-answer.js';
import { AUTOMATION_DEFAULTS, AUTOMATION_KEYS, cleanAutomation, nextSynapse, readAutomation } from './automation.js';
import { keepAttachments } from './keep-attachments.js';
import { skillRules, describeSkills } from './skills.js';
import { rulesFor, decide, resolvePath, refusalNote, SINGLE_RULES } from './permissions.js';
import { stopTargets, createStopper } from './stop.js';
import { PROJECTS_ROOT, SKILLS_DIR, ROOT, SCRATCH_ROOT, scratchDir, normDir, BROWSER_DIR } from './paths.js';
import { EV } from '../web/events.js';
import { fail, refuseBusy } from './errors.js';
import { braveEntries, entryBlockingWrite, protectionEntries, protectionFor } from './protection.js';
import { mayRecycleFolder } from './projects.js';
import { fetchProviderModels } from './providers.js';
import { providerId } from './providers.js';
import { isLocalProvider, providerUp } from './providers.js';
import { providerApiKey } from './config.js';
import * as windows from './windows.js';
import { questionSignature, guardDecision, readableAnswer } from './question-loop.js';
import { setProviderKey, providerKeyState, maskKey } from './secrets.js';
import { probeToolchain } from './toolchain.js';
import { busyInfo } from './busy.js';
import { APP_VERSION, sourceVersion } from './version.js';

// What an attachment may be. The old rule was six files of up to 8 MB each, which
// made twelve small screenshots impossible for no reason: the real cost is the
// bytes the provider is asked to read, not the number of names. The total is the
// same 48 MB the old six-file ceiling allowed; the count stays only as a sanity
// cap so one message cannot become an unreadable wall of chips.
const ATTACH_MAX_BYTES = 8 * 1024 * 1024;
const ATTACH_TOTAL_BYTES = 48 * 1024 * 1024;
const ATTACH_MAX_COUNT = 24;
// A steer is one instruction to a worker that is working, not a second brief.
// Long enough for a paragraph and a pasted error; short enough that it is read
// at the next step instead of displacing the task.
const STEER_MAX_CHARS = 4000;

/**
 * The files on an outgoing message, as the engine wants them.
 *
 * Tolerant by design: a malformed entry is dropped rather than failing the whole
 * send, because the operator's sentence matters more than their attachment. What
 * survives is bounded — count and size — and named, so the transcript can say what
 * arrived.
 */
/** What is in the project's `bin\`, if anything.
 *
 * A project's `bin` is the one folder whose contents are a *deliverable* — the app
 * that was built — rather than working state. Deleting it is a different consent
 * from deleting the sources beside it, so the dialog asks for it separately, and
 * this is what tells the dialog to ask.
 */
export function binContents(dir) {
  const bin = path.join(dir, 'bin');
  const found = { path: bin, exists: false, files: 0, bytes: 0 };
  try {
    if (!fs.statSync(bin).isDirectory()) return found;
  } catch {
    return found; // no bin folder: nothing to count
  }
  found.exists = true;
  const walk = (at) => {
    let entries;
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return; // an unreadable folder is skipped, not counted
    }
    for (const entry of entries) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      found.files += 1;
      try {
        found.bytes += fs.statSync(full).size;
      } catch { /* it went away while we looked */ }
    }
  };
  walk(bin);
  return found;
}

/**
 * Send a folder to the Windows Recycle Bin.
 *
 * `fs.rm` is permanent, and a project's folder is the operator's work, so deleting
 * a project has to be something they can take back. The shell is the only thing
 * that puts a folder in the bin, and .NET's FileSystem is the one API that asks it
 * to; it is called with the path in the *environment*, never spliced into the
 * command text, so a folder name can never become code.
 *
 * Resolves only when the folder is really gone — the exit code alone is not proof.
 */
function recycleFolder(dir) {
  return new Promise((resolve, reject) => {
    // Newlines, never semicolons: the call is one statement spread over six lines,
    // and a `;` after `DeleteDirectory(` ends it mid-call — "MissingEndParenthesis
    // InMethodCall", which is what a join on ';' produced the first time.
    const script = [
      'Add-Type -AssemblyName Microsoft.VisualBasic',
      "$ErrorActionPreference = 'Stop'",
      '[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(',
      '  $env:SYNAPSE_RECYCLE_TARGET,',
      '  [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,',
      '  [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)',
    ].join('\n');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      windowsHide: true,
      env: { ...process.env, SYNAPSE_RECYCLE_TARGET: dir },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let noise = '';
    child.stderr.on('data', (chunk) => { noise += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0 && !fs.existsSync(dir)) return resolve();
      // PowerShell's stderr is a stack trace: the useful line is the one that says
      // what went wrong, not the `+ CategoryInfo` noise around it.
      const lines = String(noise).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const detail =
        lines.find((l) => !l.startsWith('+') && /exception|denied|not found|in use|cannot/i.test(l)) ||
        lines.find((l) => !l.startsWith('+')) ||
        `the Recycle Bin refused it (exit ${code})`;
      reject(new Error(detail));
    });
  });
}

export function normalizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  let total = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (out.length >= ATTACH_MAX_COUNT) break;
    const data = String(item.data || '').replace(/^data:[^;]*;base64,/, '');
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) continue;
    // Base64 length to bytes, minus the padding: len*3/4 alone over-counts by the
    // two '=' of a single-byte tail, which refused a file of exactly the limit.
    const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    const size = Math.floor((data.length * 3) / 4) - pad;
    if (size > ATTACH_MAX_BYTES) continue;
    // One file over the message budget is dropped; a later, smaller one may still
    // fit, so this does not abandon the rest.
    if (total + size > ATTACH_TOTAL_BYTES) continue;
    total += size;
    out.push({
      name: String(item.name || 'attachment').slice(0, 120),
      mime: String(item.mime || 'application/octet-stream').slice(0, 120),
      keep: item.keep === true,
      data,
    });
  }
  return out;
}

/**
 * The config as the browser may see it: no password, no provider key — a mask and
 * "one exists" instead. Exported because the runner can change the config too (a run
 * measures a model's real window and writes it), and the page has to be told that
 * without being handed the secrets.
 */
export function toClientConfig(cfg) {
  const c = structuredClone(cfg);
  if (c.engine?.opencode) {
    const pw = c.engine.opencode.password || '';
    c.engine.opencode.password = '';
    c.engine.opencode.passwordSet = Boolean(pw);
    // A provider's key is never sent to the browser. The screen shows a mask
    // and knows whether one exists; the value itself stays on this side.
    c.engine.opencode.providers = (c.engine.opencode.providers || []).map((p) => {
      const stored = providerKeyState(p.id);
      const literal = String(p.apiKey || '');
      const fromEnv = /^env:/i.test(literal);
      return {
        ...p,
        apiKey: fromEnv ? literal : '',
        apiKeySet: stored.set || Boolean(literal && !fromEnv),
        apiKeyMasked: stored.set ? stored.masked : literal && !fromEnv ? maskKey(literal) : '',
        apiKeyFrom: stored.set ? 'stored' : fromEnv ? literal : literal ? 'config' : '',
      };
    });
  }
  return c;
}

/** Every model's configured window, keyed by ref — what a save is compared against. */
function windowMap(config) {
  const out = {};
  for (const provider of config?.engine?.opencode?.providers || []) {
    for (const model of provider?.models || []) {
      if (!provider.id || !model?.id) continue;
      out[`${provider.id}/${model.id}`] = Number(model.context) || 0;
    }
  }
  return out;
}

export function createApi({ getConfig, applyConfig, power, engine, logger, getBootError, projects, toolStats, probe, modelCache, traceReasons, inspectModel: inspectRef, probeDir, runs, desk, engineUpdate, synapseUpdate, restart, stopSelf, pcShutdown, notify, permissionLog, permissionGate, permissionMemory }) {
  const app = logger.channel('app');

  // Stop lives in one place now. Every route that stops anything — the gentle
  // press, the immediate one, a stop from a permission card — goes through this,
  // and this is the only thing that interrupts a session. See src/stop.js for the
  // engine behaviour that made the old arrangement fail.
  const stopper = createStopper({
    engine,
    runs,
    desk,
    log: app,
    notify,
  });

  // ── the timed shutdown's clock ──────────────────────────────────────
  // Twenty seconds of warning, and both waits owned by the server. A hidden window's
  // timers are throttled by the browser — the tray is exactly when this feature is
  // wanted, and a 20-second countdown in a hidden page can take twenty minutes or
  // never come. The page draws the countdown; it does not keep it.
  const POWER_COUNTDOWN_SEC = 20;
  let powerGrace = 0;
  let powerTick = 0;
  // Set while the countdown was armed by Auto-Shutdown rather than by the old
  // "turn the PC off when the Architect finishes" setting. Everything else in
  // powerRefusal still guards the final second.
  let powerByAutomation = false;

  function clearPower() {
    let was = false;
    if (powerGrace) { clearTimeout(powerGrace); powerGrace = 0; was = true; }
    if (powerTick) { clearInterval(powerTick); powerTick = 0; was = true; }
    powerByAutomation = false;
    return was;
  }

  /** Why the machine must stay on, or null when it may go. Shared by the route and
   *  the countdown so the last second is guarded as hard as the request.
   *
   *  `byAutomation` is passed explicitly by the countdown: it clears the flag as it
   *  disarms, and reading the cleared flag here is how Auto-Shutdown spent a night
   *  refusing itself (4 Nov: "Turning the PC off when the Architect finishes is off
   *  in Settings", every twenty minutes until morning). */
  function powerRefusal(confirmed, byAutomation = powerByAutomation) {
    const c = getConfig();
    if (!byAutomation && c?.shutdown?.whenDone !== true) {
      return 'Turning the PC off when the Architect finishes is off in Settings.';
    }
    if (!confirmed) return 'The countdown has to be confirmed before the PC is turned off.';
    if ((runs?.active?.() || []).length) return 'A run is still going, so the PC was left on.';
    if (!pcShutdown) return 'This build cannot turn the PC off.';
    return null;
  }

  function startPowerCountdown() {
    powerGrace = 0;
    // Who armed it, remembered across clearPower() at the final tick.
    const automated = powerByAutomation;
    let left = POWER_COUNTDOWN_SEC;
    notify?.({ kind: 'shutdown-warning', seconds: left });
    powerTick = setInterval(() => {
      // A run that started during the countdown means the operator is back at work.
      if ((runs?.active?.() || []).length) {
        clearPower();
        app.info('timed shutdown cancelled: a run started');
        notify?.({ kind: 'shutdown-cancelled', reason: 'A run started.' });
        return;
      }
      left -= 1;
      if (left > 0) {
        notify?.({ kind: 'shutdown-tick', seconds: left });
        return;
      }
      clearPower();
      // `clearPower` resets the automation flag, so the answer is carried across
      // the disarm: the countdown was armed by Auto-Shutdown, and that is what
      // authorises the last second.
      const refused = powerRefusal(true, automated);
      if (refused) {
        app.warn(`timed shutdown did not run: ${refused}`);
        notify?.({ kind: 'shutdown-cancelled', reason: refused });
        return;
      }
      app.info('timed shutdown: turning the PC off');
      notify?.({ kind: 'shutdown-done' });
      pcShutdown();
    }, 1000);
    powerTick.unref?.();
  }

  // The last brief we handed each session, so an unchanged plan does not PUT
  // the same text again on every message.
  const briefed = new Map();

  // Conversations with a compact in flight. The operator can only start one from
  // one window, but the route is open to any client, and a second compact while
  // the engine is summarising would create two chats from one.
  const compacting = new Set();
  // A compact is a request plus a wait for the engine's summary. Stop must end
  // the wait, not leave the page disabled until the three-minute timeout.
  const compactCancels = new Set();
  function cancelCompact(sessionId) {
    if (!compacting.has(sessionId)) return false;
    compactCancels.add(sessionId);
    return true;
  }

  // Is each local model server answering, and when did we last ask. Four seconds:
  // the sidebar polls, and a dead port must not be retried on every tick.
  const healthCache = new Map();

  // Who started the work in each directory. Used only for the sentence a refused
  // sender reads — "started from laptop" — never to decide anything.
  const drivers = new Map();

  /**
   * Is the project this session belongs to busy, and why.
   *
   * The engine's active list is the authority for a turn, the runner's live map
   * for a delegated run, and a pending permission for a card. General sessions
   * have their own directory, so the same comparison locks only themselves.
   */
  async function busyFor(sessionId) {
    // No session, no work. Without this the engine is asked about `null`, answers
    // 400, and the catch below reads that as "the engine is down" — so a caller
    // with no session was told the engine had stopped while it was answering every
    // other route (7 Nov).
    if (!sessionId) return { busy: false };
    let directory = '';
    try {
      directory = (await engine.getSession(sessionId))?.directory || '';
    } catch (err) {
      // The engine is not answering. Nothing can be running, but the reason matters:
      // 'Nothing is running now' for a dead engine is a lie the operator would act on.
      return { busy: false, engineDown: true, reason: err.message };
    }
    if (!directory) return { busy: false };

    const [active, sessions, permissions] = await Promise.all([
      safe(() => engine.listActiveSessions(), []),
      safe(() => engine.listSessions(), []),
      safe(() => engine.listPendingPermissions(), []),
    ]);
    const bySession = new Map((sessions || []).map((s) => [s.id, s]));
    const waiting = (permissions || [])
      .map((p) => {
        const session = bySession.get(p.sessionId || p.sessionID);
        return session && normDir(session.directory) === normDir(directory)
          ? { ...p, directory, sessionId: session.id, title: session.title }
          : null;
      })
      .filter(Boolean);
    const forms = await safe(() => engine.listForms(sessionId), []);
    return busyInfo({
      directory,
      active,
      sessions,
      runs: runs?.active?.() || [],
      permissions: waiting,
      forms: (forms || []).map((f) => ({ ...f, directory })),
      driver: drivers.get(sessionId) || drivers.get(normDir(directory)) || null,
    });
  }

  /**
   * Which roles this *session* has used, ever.
   *
   * The operator's rule: a non-Architect card starts dim and goes solid the first
   * time that role is used for anything in this session, and it stays solid for
   * the rest of the session. A delegation attempt counts even when the model
   * refused it — that is what the ladder does with a dead model — and rewriting
   * the plan does not reset it, because it is the session's history, not the
   * plan's state. A new session starts everyone dim again, which is the point.
   *
   * The run log has it: every delegate line records the architect session and the
   * role the task was written for; the result line records the role that actually
   * ran it. Both count, joined by callId.
   */
  function usedRoles(directory, sessionId) {
    if (!directory || !sessionId) return [];
    const runs = readRuns(directory);
    const mine = new Set(
      runs.filter((r) => r.kind === 'delegate' && r.architect === sessionId).map((r) => r.callId),
    );
    const used = new Set();
    for (const r of runs) {
      if (r.kind === 'delegate' && r.architect === sessionId && r.role) used.add(r.role);
      else if (r.kind === 'result' && r.role && mine.has(r.callId)) used.add(r.role);
    }
    return [...used];
  }

  /**
   * Tell a session where it is and what the project plan says.
   *
   * This goes through the engine's instruction entries rather than the message
   * text: a prefix would join the conversation and read as if the operator had
   * typed it. Failure is logged once and never blocks the turn — an engine
   * without the concept still works, it just gets no brief.
   */
  async function brief(sessionId, directory, role, auto = false, { single: forcedSingle = null } = {}) {
    try {
      // The project's document is created (and the two old files imported) the
      // first time a project is briefed, so the brief can name one file. It is
      // idempotent and cheap; a failure costs the name, not the turn.
      try {
        ensureProjectDoc(directory);
      } catch (err) {
        app.warn(`could not prepare the project document in ${directory}: ${err.message}`);
      }
      // Which mode the session is in decides what the brief says: Single is a chat
      // with tools, Multi is the harness. A send passes the mode it is about to
      // apply, because the engine's own record may be a moment behind it.
      let single;
      if (forcedSingle === null) {
        try {
          single = (await engine.getSession(sessionId))?.single === true;
        } catch {
          single = false; /* the brief still works without it */
        }
      } else {
        single = forcedSingle === true;
      }
      const text = briefSession({
        dir: directory,
        role,
        auto,
        single,
        // Single is a chat, not this harness: its skills line may not say "this
        // role" or "your report", because there is neither.
        skills: describeSkills(getConfig(), role, { chat: single }),
        focus: getConfig()?.roles?.[role]?.focus,
        instructions: getConfig()?.roles?.[role]?.instructions,
      });
      if (briefed.get(sessionId) === text) return;
      await engine.setInstruction(sessionId, BRIEF_KEY, text);
      briefed.set(sessionId, text);
    } catch (err) {
      if (briefed.get(sessionId) !== 'failed') {
        app.warn(`could not brief ${sessionId}: ${err.message}`);
        briefed.set(sessionId, 'failed');
      }
    }
  }

  /**
   * Wait for the engine's handover after asking it to compact.
   *
   * The call is a queue entry, not a blocking one: it runs at the next step
   * boundary, and from an idle chat that is now. The summary lands in the
   * transcript as a `compaction` message with `status: completed` and a
   * `summary`; this polls the newest page until a new one with text appears.
   * Returns `{text, messages, at}` for a handover, `{failed: true, reason}`
   * when the engine reports that the compaction failed or was cancelled, and
   * null on timeout. The caller must delete nothing in either non-success case.
   */
  async function waitForHandover(sessionId, before, timeoutMs, cancelled = null) {
    const seen = new Set((before || []).filter((m) => m.type === 'compaction').map((m) => m.id));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (cancelled?.has(sessionId)) {
        return { failed: true, cancelled: true, reason: 'the compaction was cancelled' };
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const messages = await engine.getMessages(sessionId).catch(() => null);
      if (messages) {
        const fresh = messages
          .filter((m) => m.type === 'compaction' && !seen.has(m.id))
          .sort((a, b) => (Number(a.created) || 0) - (Number(b.created) || 0));
        const last = fresh[fresh.length - 1];
        // A failed compaction is news the moment its message lands. Waiting the
        // full three minutes for a summary that will never come left the page
        // saying "Compacting…" long after the engine had given up.
        if (last && (last.raw?.status === 'failed' || last.error)) {
          const reason = String(last.raw?.error?.message || last.error || 'the compaction failed');
          return { failed: true, cancelled: /cancelled|canceled/i.test(reason), reason };
        }
        const done = fresh
          .filter((m) => String(m.raw?.summary || '').trim())
          .filter((m) => m.raw?.status !== 'running');
        if (done.length) {
          const handover = done[done.length - 1];
          const counted = messages.filter((m) => m.type === 'user' || m.type === 'assistant').length;
          return {
            text: String(handover.raw.summary).trim(),
            messages: counted,
            at: Number(handover.created) || Date.now(),
          };
        }
      }
      if (Date.now() >= deadline) return null;
    }
  }

  /** Directory comparison key: case-insensitive, no trailing separator. */

  /** Probe scratch sessions and Synapse's own worker sessions are scaffolding,
   *  never the operator's work: they never appear in the rail. */
  const isScratchSession = (s) => {
    if (s?.internal) return true;
    const key = normDir(probeDir);
    return Boolean(key) && normDir(s?.directory) === key;
  };

  /**
   * Projects with their sessions attached. A session belongs to the project
   * whose directory it runs in. A session that matches no project is not shown:
   * there is no built-in project to fall back to, and a row that cannot be
   * opened is noise. (Scaffolding is filtered separately.)
   */
  async function projectsWithSessions() {
    const list = projects.list().map((p) => ({ ...p, sessions: [] }));
    if (!engine.status().ready) return list;

    const byDir = new Map(list.map((p) => [normDir(p.directory), p]));
    let sessions = [];
    try {
      sessions = await engine.listSessions();
    } catch (err) {
      app.warn(`could not list sessions: ${err.message}`);
    }
    for (const s of sessions) {
      if (isScratchSession(s)) continue; // probe/model-check scaffolding
      const owner = byDir.get(normDir(s.directory));
      if (!owner) continue;
      owner.sessions.push(s);
    }
    for (const p of list) {
      // Oldest first, so a new session always appears at the bottom of its
      // project and the list never reshuffles under the cursor.
      p.sessions.sort((a, b) => (a.created || 0) - (b.created || 0));
      p.sessionCount = p.sessions.length;
    }
    return list;
  }

  // When the UI saves config with an empty password, keep the existing one — and
  // a typed provider key moves to data\provider-keys.json instead of the config
  // file. `null` means the operator removed the key; `''` means they did not
  // touch it (the browser never received the literal, so it cannot send it back).
  function reconcile(incoming) {
    const next = structuredClone(incoming || {});
    if (next.engine?.opencode) {
      const provided = next.engine.opencode.password;
      if (provided === undefined || provided === null || provided === '') {
        next.engine.opencode.password = getConfig().engine?.opencode?.password || '';
      }
      delete next.engine.opencode.passwordSet;
    }
    const list = next.engine?.opencode?.providers;
    if (Array.isArray(list)) {
      // The id is what a key is filed under, and a provider added in Settings has
      // none until its first save — so decide it here, with the same rule
      // config.normalize uses, or the new provider's key would be filed under ''.
      const taken = [];
      for (const p of list) {
        if (!p.id) p.id = providerId(p.name, taken);
        if (p.id) taken.push(p.id);
      }
      for (const p of list) {
        delete p.apiKeySet;
        delete p.apiKeyMasked;
        delete p.apiKeyFrom;
        delete p.apiKeyRemoved;
        // The page's own flag for "the operator typed this prefix themselves"; it
        // decides whether the prefix follows the name, and has no place in the file.
        delete p.idTouched;
        const key = p.apiKey;
        if (key === null) {
          if (p.id) setProviderKey(p.id, '');
          p.apiKey = '';
        } else if (typeof key === 'string' && key.trim() && !/^env:/i.test(key.trim())) {
          if (p.id) setProviderKey(p.id, key.trim());
          p.apiKey = '';
        }
      }
    }
    return next;
  }

  /**
   * Question loops.
   *
   * A worker asking a question gets one answer from the operator, which the engine
   * records as the tool's result. If the same question comes back, the worker is
   * not asking for information any more — it is looping, and the operator is being
   * asked to answer the same thing twice. Measured on Shift Test 2: four asks, the
   * same one three times, every answer recorded and every answer ignored.
   *
   * So: the second ask is answered with the operator's own earlier answer, without
   * showing it to them; the third stops the run with a reason the report carries.
   * That is a show stopper on purpose — the operator wants to see it and fix the
   * model, not be asked again.
   */
  const questionHistory = new Map(); // sessionId -> Map(signature -> { answer, asks })
  const autoAnswered = new Set();    // form ids already answered here

  /**
   * A read that is allowed to fail. Listing what waits on the operator must not
   * throw because one engine route is unhappy — and the form lookup after a
   * reply must not throw either, or the reply never gets sent (it lived inside
   * `pending` once, which is exactly how `safe is not defined` stopped a run).
   *
   * One warning per cause per minute. While the engine restarts, the page keeps
   * polling this route and every poll logged eight identical warnings: 2,077 of
   * them in `app.log` by 10 Nov, in a file whose whole point is that the one line
   * that matters is findable. The first still says what broke; the repeats go to
   * `debug.log`, where the detail belongs.
   */
  const warnedAt = new Map();
  const safe = async (fn, fallback) => {
    try {
      return await fn();
    } catch (err) {
      const msg = `pending: ${err.message}`;
      const now = Date.now();
      if (now - (warnedAt.get(msg) || 0) > 60_000) {
        warnedAt.set(msg, now);
        app.warn(msg);
      } else {
        app.debug?.(msg);
      }
      return fallback;
    }
  };

  const formSignature = questionSignature;
  const readableAnswerOf = readableAnswer;

  /** Returns the forms that should still be shown; answers or stops the rest. */
  async function guardQuestions(forms) {
    const open = [];
    for (const form of forms || []) {
      const sessionId = form?.sessionID;
      const signature = formSignature(form);
      if (!sessionId || !form.id || !signature) { open.push(form); continue; }
      const per = questionHistory.get(sessionId);
      const decision = guardDecision(per, form.id, signature);
      if (decision.action === 'show') { open.push(form); continue; }
      if (autoAnswered.has(form.id)) continue;

      if (decision.action === 'stop') {
        const seen = per.get(signature);
        seen.asks = decision.asks;
        seen.stopped = true;
        autoAnswered.add(form.id);
        const reason =
          `Stopped: the worker asked the same question ${decision.asks} times and had the answer. ` +
          `Question: "${signature}". The operator answered: "${readableAnswerOf(decision.answer)}". ` +
          `Do not re-delegate this task as it is: split it, or make the decision yourself and say what you chose.`;
        app.error(`question loop in ${sessionId} (${decision.asks} asks) - stopping the run`);
        const stopped = runs?.stopWithReason?.(sessionId, reason);
        if (!stopped) {
          // No run to stop (an Architect turn, or the worker is already gone):
          // interrupt the session so it cannot ask a fourth time.
          try { await engine.interrupt(sessionId); } catch { /* already gone */ }
        }
        continue; // never shown again
      }

      // Second ask: answer it for them, with the answer they already gave.
      autoAnswered.add(form.id);
      per.get(signature).asks = decision.asks;
      try {
        await engine.replyForm(sessionId, form.id, decision.answer);
        app.warn(
          `question loop in ${sessionId}: answered "${signature.slice(0, 80)}" again with the operator's earlier answer ` +
            `(ask ${decision.asks}); the next repeat stops the run`,
        );
      } catch (err) {
        app.warn(`could not answer the repeated question in ${sessionId}: ${err.message}`);
        open.push(form);
      }
    }
    return open;
  }

  /**
   * Every pending form, whichever chat asked it.
   *
   * The engine scopes its list by the request's directory header, and Synapse asks
   * from the workspace root — where the answer is always an empty array. That is
   * why Auto-Answer never fired, with the old single switch either (found 3 Nov:
   * the same sweep with the form's own directory answered at once). So ask each
   * known session, and each active one, for its own forms.
   */
  async function formsEverywhere() {
    const [sessions, active] = await Promise.all([
      safe(() => engine.listSessions(), []),
      safe(() => engine.listActiveSessions(), []),
    ]);
    const ids = new Set();
    for (const s of sessions || []) if (s?.id) ids.add(s.id);
    for (const id of active || []) if (id) ids.add(typeof id === 'string' ? id : id.id);
    const lists = await Promise.all([...ids].map((id) => safe(() => engine.listForms(id), [])));
    const out = [];
    const seen = new Set();
    for (const list of lists) {
      for (const form of list || []) {
        if (!form?.id || seen.has(form.id)) continue;
        seen.add(form.id);
        out.push(form);
      }
    }
    return out;
  }

  // Auto-Answer for questions. The permission gate handles permission cards; this
  // handles forms, on the same switch and the same minute. It records the answer
  // exactly as an operator reply would: the question-loop history, the form
  // broadcast, and the project document.
  const formAuto = createFormAuto({
    engine,
    logger,
    listForms: formsEverywhere,
    getTimeoutMs: () => answerTimeoutMs(getConfig()),
    onAnswered: async ({ form, sessionId, answer }) => {
      const signature = formSignature(form);
      if (signature) {
        const per = questionHistory.get(sessionId) || new Map();
        per.set(signature, { answer, asks: 1 });
        questionHistory.set(sessionId, per);
      }
      notify?.({ kind: 'form', type: 'form.answered', formId: form.id, sessionId, by: 'Auto-Answer' });
      try {
        const session = await safe(() => engine.getSession(sessionId), null);
        if (session?.directory && Array.isArray(form.fields) && form.fields.length) {
          const written = appendProjectDecision(session.directory, { fields: form.fields, answer });
          if (written && written.ok === false) app.warn(`could not write the full-auto answer: ${written.error}`);
        }
      } catch (err) {
        app.warn(`could not write the full-auto answer to the project document: ${err.message}`);
      }
      app.info(`auto-answer answered a question in ${sessionId}`);
      // The model must not read an automatic reply as the operator's own decision:
      // they are away from the harness, which is the whole reason this fired. A
      // synthetic line is the only channel into its context, so it is told plainly
      // who answered (4 Nov).
      Promise.resolve(
        engine.synthetic?.(
          sessionId,
          'Auto-Answer answered that question: the operator is away from the harness right now, so Synapse ' +
            'itself took the recommended options. Treat these answers as the harness\'s, not as the operator\'s, ' +
            'and say so when you report the decision.',
          { description: 'Auto-Answer' },
        ),
      ).catch((err) => app.warn(`could not tell ${sessionId} that Auto-Answer replied: ${err.message}`));
    },
  });

  const requireReady = () => {    const st = engine.status();    if (!st.ready) {
      const err = new Error(getBootError() || `${st.kind} engine is not ready`);
      err.status = 503;
      throw err;
    }
  };

  /**
   * Write the four automation switches for a session, and tell everything that
   * acts on them. Read through src/automation.js, which also carries a chat saved
   * under the older names (`synapse.auto`, `synapse.fullAuto`) into the new shape
   * without resetting it — and writes those two as mirrors so any older reader
   * cannot disagree with the switch the operator just set.
   */
  async function applyAutomation(sessionId, patch) {
    requireReady();
    const session = await engine.getSession(sessionId);
    const meta = session?.metadata && typeof session.metadata === 'object' ? session.metadata : {};
    const next = nextSynapse(meta.synapse, patch && typeof patch === 'object' ? patch : {});
    await engine.updateSessionMetadata(sessionId, { ...meta, synapse: next });
    const automation = cleanAutomation(next.automation);
    // The brief carries Keep Building, so the Architect hears about it on the very
    // next message rather than discovering it mid-run.
    await brief(sessionId, session?.directory, 'architect', automation.keepBuilding);
    // Open cards and forms follow their two switches at once — and it is the
    // project's switch, not this session's: a worker's card is in the same
    // directory.
    permissionGate?.setAutomation?.(sessionId, automation, session?.directory || '');
    formAuto.setAutomation(sessionId, automation, session?.directory || '');
    // Turning Keep Building on is the operator saying "carry on", so a project they
    // stopped may run again.
    if (automation.keepBuilding && session?.directory) runs?.resume?.(session.directory);
    const on = AUTOMATION_KEYS.filter((key) => automation[key]);
    app.info(`automation ${on.length ? on.join(', ') : 'all off'} for ${sessionId}`);
    notify?.({ kind: 'sessions', type: EV.automation, sessionId, automation });
    return { ok: true, automation };
  }

  // SynaBrowse's sign-in: open the harness's own browser on a site and put it where the
  // operator can log in. One browser per process, because a profile cannot be open twice
  // and the session is the whole point of it.
  //
  // The site is recorded when the operator *closes* that window — their own "done" — and
  // the page is told, because the previous version left them guessing whether the login
  // had been kept (11 Nov).
  async function browserSignin(url) {
    const target = String(url || '').trim();
    if (!target) return { ok: false, error: 'there is no address to open' };
    const cfg = getConfig();
    const profile = String(cfg.browser?.profile || '').trim() || `${BROWSER_DIR}\\profile`;
    // The operator's own switch, beside the screen sounds: one chime, or none.
    const sound = cfg.notify?.browserSounds === false ? '' : undefined;
    try {
      const { askToSignIn } = await import('./browser/signin.js');
      const { addSite } = await import('./browser/sites.js');
      const answer = await askToSignIn({
        url: target,
        profile,
        log: app,
        sound,
        // The operator closed the window: that is "done". Before the row is written, the
        // address is opened once more, hidden, to see whether the site still asks for a
        // password — a session that did not take must not become a row that says it did.
        onDone: async (opened) => {
          const { confirmSession } = await import('./browser/signin.js');
          const host = String(opened || '').replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0].toLowerCase();
          // The window is closed and the address is about to be checked: the page turns
          // the button into "Saving…" for this gap, so the wait is visible (11 Nov).
          notify?.({ kind: 'browser-signin-closed', host, ts: Date.now() });
          const check = await confirmSession({ url: opened, profile, log: app })
            .catch((err) => ({ ok: false, url: opened, why: err.message }));
          if (!check.ok) {
            app.info(`SynaBrowse: ${host} not confirmed — ${check.why}`);
            notify?.({ kind: 'browser-session-unconfirmed', host, why: check.why, ts: Date.now() });
            return;
          }
          const next = getConfig();
          next.browser = { ...next.browser, sites: addSite(next.browser?.sites, host, Date.now(), check.url) };
          applyConfig(next);
          app.info(`SynaBrowse: ${host} signed in and confirmed; the session stays in its profile`);
          notify?.({ kind: 'browser-session-kept', host, url: check.url, ts: Date.now() });
        },
      });
      if (answer.ok) app.info(`SynaBrowse: sign-in window asked for ${answer.url}`);
      else app.warn(`SynaBrowse: could not show the sign-in window for ${target}: ${answer.error}`);
      return answer;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /** Forget a site: the row goes, and the browser drops what it keeps for that host. */
  async function browserForget(host) {
    const key = String(host || '').trim().toLowerCase();
    if (!key) return { ok: false, error: 'there is no site to forget' };
    const cfg = getConfig();
    const { forgetSite } = await import('./browser/sites.js');
    const next = { ...cfg, browser: { ...cfg.browser, sites: forgetSite(cfg.browser?.sites, key) } };
    applyConfig(next);
    // Deleting is not reading: the browser drops its own storage for the origin, and
    // Synapse never looks at a value.
    try {
      const { createBrowser } = await import('./browser/browser.js');
      const profile = String(cfg.browser?.profile || '').trim() || `${BROWSER_DIR}\\profile`;
      const browser = createBrowser({ profile });
      for (const origin of [`https://${key}`, `http://${key}`]) {
        try { await browser.clearOrigin(origin); } catch { /* the host may have no data */ }
      }
      app.info(`SynaBrowse: forgot ${key} — its cookies and storage are gone from the profile`);
    } catch (err) {
      app.warn(`SynaBrowse: forgot ${key} in the list, but could not clear its data: ${err.message}`);
    }
    return { ok: true, host: key, sites: next.browser.sites };
  }

  return {
    browserSignin,
    browserForget,
    status: async () => ({
      version: APP_VERSION,
      // The files on disk may be newer than this process — a page reload cannot
      // change the running version, so the pair lets the rail say a restart is
      // pending (9 Nov).
      sourceVersion: sourceVersion(),
      engine: engine.status(),
      bootError: getBootError(),
      config: toClientConfig(getConfig()),
      // Whether the machine is actually being held awake right now, and whether the
      // monitor is included. The config says what was asked; this says what happened.
      power: power?.state?.() || null,
    }),

    getConfig: async () => toClientConfig(getConfig()),

    // "Refresh List" in Settings > Providers: ask a server what it serves. The
    // operator's click is the only reason this contacts anything - see
    // src/providers.js.
    //
    // The key is resolved on this side: the browser is never given one, so the
    // only thing it can send is a key typed into the field and not yet saved. A
    // stored key (or `env:...` in the config) is what an unsaved row's call has
    // to use, or every provider with a key answers 401 here and works nowhere.
    /**
     * Which local model servers are answering right now, and their names.
     *
     * The sidebar's Local LLM row answers one question — "is the thing I turned on
     * actually there" — so it needs a *now* answer, not the config. Each probe is
     * one short GET, and the result is held for a few seconds: the row is polled,
     * and a dead port must not be re-tried on every tick.
     */
    providerHealth: async () => {
      const providers = Array.isArray(getConfig()?.engine?.opencode?.providers)
        ? getConfig().engine.opencode.providers
        : [];
      const local = providers.filter(isLocalProvider);
      const now = Date.now();
      const stale = local.some((p) => !healthCache.has(p.id) || now - healthCache.get(p.id).at > 4000);
      if (stale) {
        await Promise.all(
          local.map(async (p) => {
            const up = await providerUp(p);
            healthCache.set(p.id, { at: Date.now(), up });
          }),
        );
      }
      return {
        servers: local.map((p) => ({
          id: p.id,
          name: p.name || p.id,
          up: healthCache.get(p.id)?.up ?? false,
        })),
      };
    },

    providerModels: async (body) => {
      const id = String(body?.id || '').trim();
      const key = id ? providerApiKey({ id, apiKey: body?.apiKey }, process.env).key : String(body?.apiKey || '').trim();
      return fetchProviderModels({ ...(body || {}), apiKey: key });
    },

    // Settings > Save Changes asks whether to restart. The engine and the server
    // read their settings at start, so this is the honest answer to "apply now".
    restart: async () => {
      if (!restart) return { ok: false, error: 'This build cannot restart itself.' };
      return restart();
    },

    // Tray > Stop Server. Graceful, like the restart: the engine is stopped by the
    // same shutdown path rather than being killed with its parent.
    shutdown: async () => {
      if (!stopSelf) return { ok: false, error: 'This build cannot stop itself.' };
      return stopSelf();
    },

    /**
     * Arm the timed shutdown for this finish.
     *
     * The wait and the countdown live *here*, not in the page, for one measured
     * reason: a hidden window's timers are throttled by the browser. Synapse in the
     * tray is exactly the case this feature exists for, and a 20-second countdown in
     * a hidden page can take twenty minutes — or never come. The server's clock is
     * not throttled, so it owns the deadline and the page only draws it.
     */
    armPowerOff: async (body) => {
      const c = getConfig();
      // `force` is the Auto-Shutdown watcher: it has already waited its idle
      // delay and read the project's own switch, so the old global setting is not
      // its gate. Everything below the gate is shared — one clock, one countdown,
      // one Cancel.
      if (body?.force !== true && c?.shutdown?.whenDone !== true) {
        return { ok: false, error: 'Turning the PC off when the Architect finishes is off in Settings.' };
      }
      clearPower();
      const minutes = Math.min(180, Math.max(1, Math.round(Number(body?.minutes ?? c.shutdown.minutes) || 5)));
      powerGrace = setTimeout(() => startPowerCountdown(), minutes * 60_000);
      powerGrace.unref?.();
      app.info(`timed shutdown armed: ${minutes} minute(s) after this finish`);
      return { ok: true, minutes, deadline: Date.now() + minutes * 60_000 };
    },

    /** The operator changed their mind, in the wait or in the countdown. */
    cancelPowerOff: async () => {
      const was = clearPower();
      if (was) {
        app.info('timed shutdown cancelled');
        notify?.({ kind: 'shutdown-cancelled' });
      }
      return { ok: true, cancelled: was };
    },

    /**
     * The Auto-Shutdown watcher's arm. The idle wait has already passed, so this
     * starts the countdown itself — same clock, same 20 seconds, same Cancel, and
     * the same refusal if a run started in the meantime.
     */
    armPowerCountdown: async () => {
      if (!pcShutdown) return { ok: false, error: 'This build cannot turn the PC off.' };
      clearPower();
      powerByAutomation = true;
      startPowerCountdown();
      return { ok: true, seconds: POWER_COUNTDOWN_SEC };
    },

    /** Is a shutdown waiting or counting down? The watcher needs the answer so a
     *  Cancel is a decision, not a speed bump it immediately undoes. */
    powerOffState: async () => ({
      armed: Boolean(powerGrace || powerTick),
      countdown: Boolean(powerTick),
    }),

    /**
     * Turn the PC off *now*, confirmed. Kept as its own route because it is the
     * countdown's final act and must stay callable without a timer — and because
     * the guards below are the ones the countdown reuses.
     */
    powerOff: async (body) => {
      const refused = powerRefusal(body?.confirm === true);
      if (refused) return { ok: false, error: refused };
      return pcShutdown();
    },

    // The engine updates often and the model catalog ships inside it, so this is
    // the one place Synapse will talk to the network for something other than a
    // model — and only because the operator asked. `check` without `online` is
    // free: it reads the engine, the desktop's own version file and the cache.
    engineUpdate: async () => engineUpdate.check({ online: false }),
    checkEngineUpdate: async () => engineUpdate.check({ online: true }),
    updateEngine: async () =>
      engineUpdate.update({
        onLog: (line) => notify?.({ kind: 'update', type: 'update.log', target: 'engine', line }),
      }),

    // Synapse's own release, from the public feed. `check` is cached; `checkNow`
    // is the operator asking. The update downloads, stages and closes the app —
    // the helper finishes outside it.
    synapseUpdate: async () => synapseUpdate.check({ online: false }),
    checkSynapseUpdate: async () => synapseUpdate.check({ online: true }),
    updateSynapse: async () =>
      synapseUpdate.update({
        onLog: (line) => notify?.({ kind: 'update', type: 'update.log', target: 'synapse', line }),
      }),

    // What this machine can build with, for Settings → Windows. Cheap and cached:
    // one PowerShell call, no builds, so the tab opens instantly.
    toolchain: async ({ force = false } = {}) => probeToolchain({ force }),

    saveConfig: async (body, actor = null) => {
      // Which roles had a different model before this save. A run of that role
      // asleep in a provider backoff (a usage cap, a rate limit) is waiting on a
      // clock that the operator has just made irrelevant: the runner wakes it and
      // moves its session to the new model (see runs.wakeRole).
      const beforeRefs = new Map(
        Object.entries(getConfig()?.roles || {}).map(([role, entry]) => [role, String(entry?.ref || '')]),
      );
      // Every model's configured window, before and after: a number the operator
      // typed replaces whatever measurement was remembered for that model, and a
      // role that just changed model is measured straight away.
      const beforeWindows = windowMap(getConfig());
      const saved = applyConfig(reconcile(body));
      const afterWindows = windowMap(saved);
      for (const [ref, context] of Object.entries(afterWindows)) {
        if (beforeWindows[ref] !== context) windows.forget(ref);
      }
      const selected = new Set();
      // The wake lock is a config answer too: Settings' checkboxes take effect on
      // Save, not at the next restart.
      power?.apply?.(saved.automation);
      // A changed Auto-Answer wait applies to cards already on screen, not only to
      // the next ask.
      permissionGate?.retime?.();
      for (const [role, entry] of Object.entries(saved.roles || {})) {
        const ref = String(entry?.ref || '');
        if (!ref || ref === beforeRefs.get(role)) continue;
        selected.add(ref);
        // The operator chose a model for this role: the harness's loop marks on it
        // are about a different run, and must not greet the choice as ISSUES. The
        // task attempt counts for this role reset lazily as well — a run on the old
        // model is not evidence against the new one (`modelChangedSinceAttempt`).
        try {
          const cleared = modelCache?.clearLoopIssues?.(ref) || 0;
          if (cleared) {
            notify?.({ kind: 'model', type: 'issues', ref });
            app.info(`model loops cleared for ${role}: ${ref} (${cleared} mark(s); the role's model changed)`);
          }
        } catch (err) {
          app.warn(`could not clear the loop marks on ${ref}: ${err.message}`);
        }
        try {
          // The variant travels with the ref: a role set to a high thinking
          // effort must not come back as the default one mid-run. The runner may
          // switch a session before it wakes it, so the call is awaited by it and
          // any failure is logged there, never thrown back here.
          Promise.resolve(runs?.wakeRole?.(role, { ref, variant: entry?.variant || '' })).catch((err) =>
            app.warn(`could not wake ${role} after its model change: ${err.message}`),
          );
        } catch (err) {
          app.warn(`could not wake ${role} after its model change: ${err.message}`);
        }
      }
      // A role that just changed model is measured now, not at the next run: the
      // card must show the window the server really has *before* the model is used,
      // and the answer arrives on the stream so every view repaints (8 Nov).
      for (const ref of selected) {
        windows
          .refreshWindow(saved, ref, { cache: modelCache })
          .then((r) => {
            if (!r.changed) return;
            if (windows.writeIntoConfig(saved, ref, r)) applyConfig(saved);
            notify?.({ kind: 'model', type: 'window', ref, context: r.context, source: r.source });
            app.info(`${ref}: ${r.previous || 'nothing'} -> ${r.context} tokens, measured from the server`);
          })
          .catch(() => { /* a server that cannot answer changes nothing */ });
      }
      app.info('config saved via UI');
      const shown = toClientConfig(saved);
      // The other view must not keep showing the old file until somebody
      // refreshes. The switcher above is the same rule for the LAN toggle. `byId`
      // is what keeps the save from being announced to the view that saved it as
      // "Saved on another computer" — a lie it told itself (measured 31 Oct).
      notify?.({ kind: 'config', type: 'config.saved', config: shown, by: actor?.name || null, byId: actor?.id || null });
      return shown;
    },

    /**
     * Measure every local provider once, now that the page is up.
     *
     * Boot measures before the engine starts, and a runtime that is still waking up
     * answers nothing — which leaves the config, the card and the picker showing the
     * number from the last time that model was loaded smaller. One request per
     * server, the same numbers a selection would find, written into the provider
     * entries and announced (8 Nov).
     */
    refreshWindows: async () => {
      const cfg = getConfig();
      const changes = await windows.refreshLocalProviders(cfg);
      for (const change of changes) {
        windows.writeIntoConfig(cfg, change.ref, { context: change.to });
        notify?.({ kind: 'model', type: 'window', ref: change.ref, context: change.to, source: 'loaded' });
      }
      if (changes.length) applyConfig(cfg);
      return changes;
    },

    models: async () => {
      requireReady();
      const list = await engine.listModels();
      // The catalog is the live truth; record it so a model that later leaves
      // the list still has its context, variants and tools on file.
      if (modelCache) {
        try { modelCache.record(list); } catch (err) { app.warn(`model cache update failed: ${err.message}`); }
      }
      // Only the providers this config holds are offered. Every provider is the
      // operator's now — OC Zen and OC Go are ordinary OpenAI-compatible rows, added
      // with Add Provider and removed by deleting the row — so the engine serving a
      // model is not a reason to show it. The engine keeps serving whatever a role
      // already points at; this is the menu, not the permission. Recorded above, so
      // a model's context and variants are known if its provider is added back.
      const cfg = getConfig();
      const configured = new Set((cfg?.engine?.opencode?.providers || []).map((p) => String(p.id || '')).filter(Boolean));
      const hidden = new Set((cfg?.engine?.opencode?.hiddenProviders || []).map(String));
      const shown = list.filter((m) => configured.has(String(m.provider)) && !hidden.has(String(m.provider)));
      if (shown.length !== list.length) {
        app.debug(`models: ${list.length - shown.length} not offered — no provider row for them`);
      }
      // The engine's catalog is what it was *told* when it started. The config is
      // what Synapse budgets with — measured at boot, corrected by a run, typed in
      // Settings — and after any of those the two disagree until the engine
      // restarts. The page shows the config's number, because that is the one the
      // watchdog uses, and a corner reading a window nobody budgets for is worse
      // than one that lags a restart.
      return {
        models: shown.map((m) => {
          const known = modelCache?.get(m.ref);
          // One resolver for the card and the watchdog: the config's number, the
          // measurement remembered for this model, and the catalog, in that
          // module's order. A stale provider entry is why a 128k local model read
          // 60k on the card (8 Nov).
          const window = windows.knownWindow(cfg, m.ref, { cache: modelCache });
          return {
            ...m,
            context: window.context || m.context,
            output: window.output || m.output,
            contextSource: window.source,
            tools: known?.tools || null,
            issues: known?.issues || null,
          };
        }),
      };
    },

    /** The raw per-model knowledge base, for inspection and debugging. */
    modelCache: async () => (modelCache ? modelCache.snapshot() : { version: 1, models: {} }),

    /**
     * Clear a model's issues. The operator's own call, from the picker: they
     * checked it and it works, so the badge goes and nothing is asked of anyone.
     */
    clearModelIssues: async (body) => {
      const ref = String(body?.ref || '').trim();
      if (!ref) {
        throw fail(400, 'a provider/model ref is required');
      }
      const cleared = modelCache ? modelCache.clearIssues(ref) : false;
      app.info(`model issues cleared: ${ref}${cleared ? '' : ' (there were none)'}`);
      return { ok: true, ref, cleared };
    },

    /** Zero every model's ask counter (keeps valid results). */
    resetModelAsks: async () => ({
      ok: true,
      models: modelCache ? modelCache.resetAsks() : 0,
    }),

    /**
     * Kick off a background toolset discovery for one model. Idempotent: a model
     * already checked returns its cached tools, and one already running reports
     * `running` instead of stacking a second turn.
     */
    inspectModel: async (body) => {
      requireReady();
      if (!inspectRef) return { started: false, reason: 'model checks are unavailable' };
      const ref = String(body?.ref || '').trim();
      if (!ref.includes('/')) {
        throw fail(400, 'a provider/model ref is required');
      }
      return inspectRef(ref);
    },

    agents: async () => {
      requireReady();
      return { agents: await engine.listAgents() };
    },

    /**
     * What the engine can actually load, and what the role settings expect.
     *
     * A config that travelled from another machine can name skills that are not
     * here, and a missing name does not fail — the rule allows it and nothing
     * loads, which is the quietest way for a capability to disappear. So the gap
     * is reported as data: the UI says it once at boot, and the role picker shows
     * the name it cannot offer rather than dropping it in silence.
     */
    skills: async () => {
      const config = getConfig() || {};
      // A shipped skill also present in a *configured* folder is worth naming:
      // the configured copy wins (measured), so an edit to the shipped one would
      // not be the one loaded. The engine's default `~/.agents/skills` scan is not
      // a problem — it loses to the configured copy, which is the point.
      let shipped = new Set();
      try {
        shipped = new Set(
          fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name),
        );
      } catch { /* no shipped folder: nothing can collide */ }
      const paths = (config.engine?.opencode?.skillPaths || []).map((p) => {
        const entry = { path: String(p), exists: fs.existsSync(String(p)), duplicates: [] };
        if (!entry.exists || !shipped.size) return entry;
        try {
          entry.duplicates = fs
            .readdirSync(String(p), { withFileTypes: true })
            .filter((e) => e.isDirectory() && shipped.has(e.name))
            .map((e) => e.name)
            .sort();
        } catch { /* an unreadable folder is reported by `exists` */ }
        return entry;
      });
      if (!engine.status().ready) return { skills: [], missing: [], paths, bundled: SKILLS_DIR };
      const skills = await engine.listSkills();
      const names = new Set(skills.map((s) => s.name));
      const missing = [];
      for (const [role, entry] of Object.entries(config.roles || {})) {
        for (const name of entry?.skills || []) {
          if (names.has(name)) continue;
          let record = missing.find((m) => m.name === name);
          if (!record) {
            record = { name, roles: [] };
            missing.push(record);
          }
          record.roles.push(role);
        }
      }
      return { skills, missing, paths, bundled: SKILLS_DIR };
    },

    /** Delegated work in flight, one entry per project. The live path and the
     *  role cards are drawn from this; the SSE events are the fast path and
     *  this is what a page opened mid-run starts from. */
    // What is running, with the reasoning each worker has finished. The steps are
    // kept server-side so a reload and a second view show the same trace instead of
    // an empty one (8 Nov).
    runs: async () => ({
      runs: (runs?.active() || []).map((run) => ({ ...run, reasons: traceReasons?.get?.(run) || [] })),
    }),

    /** One finished reasoning step from a worker's trace. */
    traceReason: async (body = {}) => {
      const run = {
        dir: String(body?.dir || ''),
        task: String(body?.task || ''),
        startedAt: Number(body?.startedAt) || 0,
      };
      const text = String(body?.text || '');
      if (!run.dir || !run.task || !text) throw fail(400, 'a run and the text it thought are needed');
      return { ok: true, count: traceReasons?.add?.(run, text) || 0 };
    },

    // POST /api/runs/cancel - stop the delegated run in a project. The UI's Stop
    // button uses this when the open session is idle and a worker is not: the
    // worker is the thing that needs stopping, and a run waiting out a five-minute
    // backoff has to stop immediately.
    cancelRun: async ({ dir } = {}) => {
      const directory = String(dir || '').trim();
      if (!directory) {
        throw fail(400, 'a directory is needed to stop a run');
      }
      return { ok: Boolean(runs?.cancel?.(directory)) };
    },

    /**
     * POST /api/runs/resume — the operator has acted, so a stopped project may run
     * again. The message path already does this, and so does turning keep-building
     * on; a model change is the third kind of "I fixed it": the thing that was
     * refused has been replaced, and the hold has no reason to outlive it.
     */
    resumeRuns: async ({ dir } = {}) => {
      const directory = String(dir || '').trim();
      if (!directory) return { ok: false, resumed: false };
      // A run that is resumed must not be cut a moment later by a stop that is
      // still watching the project.
      stopper.clear(directory);
      return { ok: true, resumed: Boolean(runs?.resume?.(directory)) };
    },

    // ── projects ─────────────────────────────────────────────
    projects: async () => ({ projects: await projectsWithSessions() }),

    createProject: async (body) => {
      // Does this folder already carry a plan? Adding a project only registers a
      // directory, so a folder the operator deleted the *project* for is still on
      // disk with everything in it — including the plan the Architect left there.
      // That is the right behaviour for re-adding a real project, and a trap when
      // the name is reused for a fresh start: the pane opened onto a finished
      // 4/4 plan and the Architect card said DONE before anyone had typed
      // anything. So it is reported, never wiped.
      let existingPlan = null;
      const dir = String(body?.directory || '').trim();
      if (dir) {
        try {
          const before = readPlan(dir);
          if (before.exists && before.plan?.tasks?.length) {
            existingPlan = {
              tasks: before.plan.tasks.length,
              done: before.plan.tasks.filter((t) => t.status === 'done').length,
              goal: (before.plan.goal || '').slice(0, 120),
            };
          }
        } catch { /* a directory we cannot read is the project's problem, not this call's */ }
      }
      const project = projects.create({ name: body?.name, directory: body?.directory });
      // The store gives it `.synapse\plan.json` and its scratch folder, whether
      // the folder was new or already there. Re-adding a project continues its
      // plan; this never touches an existing one.
      return {
        project: (await projectsWithSessions()).find((p) => p.id === project.id) || project,
        existingPlan,
      };
    },

    /**
     * Open a project in Explorer, or a command prompt at it. Both are detached
     * GUI processes: Synapse does not track them and never kills them.
     */
    openProject: async (id, what) => {
      const project = projects.find(id);
      if (!project) {
        throw fail(404, 'project not found');
      }
      if (!fs.existsSync(project.directory)) {
        throw fail(400, `the folder does not exist: ${project.directory}`);
      }
      // Array args, never a shell string: the directory is the operator's, and
      // it must not be able to turn into a command.
      //
      // A command prompt goes through `start`, because a `cmd.exe` spawned
      // directly by this process has no console of its own and exits instantly
      // (verified: exit 0 within a second, no window). `start` asks the shell to
      // create the window, and it survives.
      const cmd = what === 'cmd';
      const args = cmd
        ? ['/c', 'start', '', 'cmd.exe', '/K', `cd /d ${project.directory}`]
        : [project.directory];
      const child = spawn(cmd ? 'cmd.exe' : 'explorer.exe', args, { detached: true, stdio: 'ignore' });
      child.unref();
      app.info(`opened ${cmd ? 'a command prompt' : 'Explorer'} at ${project.directory}`);
      return { ok: true };
    },

    updateProject: async (id, body) => {
      const project = projects.update(id, { name: body?.name });
      return { project };
    },

    /** Move a project up or down the rail: the registry is the order. */
    moveProject: async (id, body) => {
      const moved = projects.move(id, Number(body?.delta) < 0 ? -1 : 1);
      return { ...moved, projects: projects.list() };
    },

    /**
     * Look at a folder *before* a project is registered there.
     *
     * Deleting a project only unregisters it, so a reused name lands on the old
     * folder with everything still in it — plan included. The UI asks this first and
     * shows a three-way choice; nothing is created or deleted by this call.
     */
    inspectProjectDir: async (body) => {
      const dir = String(body?.directory || '').trim();
      if (!dir) {
        throw fail(400, 'a directory is required');
      }
      const state = readPlan(dir);
      let files = 0;
      try {
        files = fs.readdirSync(dir, { recursive: true }).length;
      } catch { /* not there, or not readable: both mean "nothing to lose" */ }
      return {
        directory: dir,
        exists: fs.existsSync(dir),
        files,
        plan: state.exists && state.plan?.tasks?.length
          ? {
              tasks: state.plan.tasks.length,
              done: state.plan.tasks.filter((t) => t.status === 'done').length,
              goal: state.plan.goal || '',
              mtime: state.mtime,
            }
          : null,
      };
    },

    /**
     * Wipe a project folder so a fresh project can start in it.
     *
     * Deliberately narrow: only a directory *inside* the projects root, never the
     * root itself, never General's folder. The engine is told to release the
     * location first — that handle is the only reason a folder could not be
     * deleted while Synapse runs.
     */
    wipeProjectDir: async (body) => {
      const dir = String(body?.directory || '').trim();
      if (!dir) {
        throw fail(400, 'a directory is required');
      }
      const guarded = entryBlockingWrite(dir, getConfig() || {});
      if (guarded) {
        throw fail(403, `${dir} is protected (${guarded.label}) and cannot be deleted`);
      }
      const rel = path.relative(PROJECTS_ROOT, path.resolve(dir));
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw fail(400, `refusing to wipe ${dir}: it is not inside ${PROJECTS_ROOT}`);
      }
      try {
        await engine.evictLocation?.(dir);
      } catch (err) {
        app.warn(`could not release ${dir} before wiping it: ${err.message}`);
      }
      // Even a confirmed release can leave the filesystem a tick behind, so the
      // delete is retried briefly rather than failing on the first EBUSY.
      let lastError = null;
      for (let i = 0; i < 10; i += 1) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      if (lastError) {
        const e = new Error(`could not delete ${dir}: ${lastError.message}`);
        e.status = 423; // locked
        throw e;
      }
      app.info(`wiped project folder: ${dir}`);
      return { ok: true, removed: !fs.existsSync(dir) };
    },

    /**
     * What deleting this project would do, before anything is deleted.
     *
     * The dialog needs two facts the project list does not carry: whether the
     * folder is still on disk, and whether there are deliverables in `bin\` — the
     * one thing in a project that has to be agreed to separately.
     */
    projectDeleteInfo: async (id) => {
      const current = projects.find(id);
      if (!current) {
        throw fail(404, 'project not found');
      }
      const withSessions = (await projectsWithSessions()).find((p) => p.id === id);
      return {
        id,
        name: current.name,
        directory: current.directory,
        exists: fs.existsSync(current.directory),
        general: Boolean(current.general),
        sessions: withSessions?.sessions?.length || 0,
        bin: binContents(current.directory),
      };
    },

    /**
     * Delete a project — its conversation, its folder and its memory.
     *
     * The project is one chat, so deleting the project ends that chat too; there
     * is no separate "delete the session first" step any more. The folder goes to
     * the Recycle Bin (the undo), and `bin\` — the built app, a deliverable rather
     * than working state — has to be agreed to on its own. A project that is
     * working, or waiting on a card, is refused: stopping the work is the
     * operator's call, not a side effect of a menu item.
     */
    deleteProject: async (id, body) => {
      const current = projects.find(id);
      if (!current) {
        throw fail(404, 'project not found');
      }
      const withSessions = (await projectsWithSessions()).find((p) => p.id === id);
      const sessions = withSessions?.sessions || [];
      if (sessions.length) {
        const busy = await busyFor(sessions[sessions.length - 1].id);
        if (busy.busy) throw refuseBusy(busy);
      }
      const bin = binContents(current.directory);
      // Enforced here as well as in the dialog: the checkbox is the operator's
      // consent, and a request may not assert one it was never asked for.
      if (bin.files > 0 && body?.binConfirmed !== true) {
        const err = new Error(
          `"${current.name}" has ${bin.files} file${bin.files === 1 ? '' : 's'} in bin\\. Confirm that the deliverables there are to be deleted with the project.`,
        );
        err.status = 409;
        throw err;
      }
      let recycled = false;
      if (fs.existsSync(current.directory)) {
        // The engine holds a location "loaded" once it has served a turn there,
        // and that handle is what made a finished project's folder undeletable
        // until Synapse was stopped. Release it before the folder moves.
        try {
          await engine.evictLocation?.(current.directory);
        } catch (err) {
          app.warn(`could not release ${current.directory} from the engine: ${err.message}`);
        }
        const allowed = mayRecycleFolder(current.directory, { projectsRoot: PROJECTS_ROOT, harness: ROOT });
        if (!allowed.ok) {
          throw fail(400, `refusing to delete the folder: ${allowed.reason}`);
        }
        const guarded = entryBlockingWrite(current.directory, getConfig() || {});
        if (guarded) {
          const err = new Error(
            `refusing to delete ${current.directory}: it is on the prohibited list (${guarded.label})`,
          );
          err.status = 403;
          throw err;
        }
        try {
          await recycleFolder(current.directory);
          recycled = true;
        } catch (err) {
          // The project stays registered. A folder still on disk with its registry
          // entry gone is the worse half of a failed delete: the operator can see the
          // folder but Synapse no longer knows it is there.
          const e = new Error(`could not move ${current.directory} to the Recycle Bin: ${err.message}`);
          e.status = 423; // locked
          throw e;
        }
        app.info(`deleted project folder to the Recycle Bin: ${current.directory}`);
      }
      // The project's scratch folder lives beside the projects, not inside the
      // folder the Recycle Bin takes, and it belongs to this project and nothing
      // else. A deleted project must not leave gigabytes behind: one project's
      // scratch alone had reached 12 GB (4 Nov).
      try {
        const scratch = scratchDir(current.directory);
        if (fs.existsSync(scratch)) {
          fs.rmSync(scratch, { recursive: true, force: true });
          app.info(`removed the deleted project's scratch folder: ${scratch}`);
        }
      } catch (err) {
        app.warn(`could not remove the scratch folder of a deleted project: ${err.message}`);
      }
      // The folder is gone first, so a failed conversation delete cannot leave a
      // working project pointing at nothing; a session that fails to delete here
      // is invisible anyway (its directory is not a project any more).
      for (const s of sessions) {
        try {
          await engine.deleteSession(s.id);
          briefed.delete(s.id);
          permissionMemory?.forgetSession?.(s.id);
        } catch (err) {
          app.warn(`could not delete the conversation ${s.id} of a deleted project: ${err.message}`);
        }
      }
      projects.remove(id);
      return { ok: true, recycled, directory: current.directory, binFiles: bin.files };
    },

    /**
     * The PROHIBITED list, for Settings. Entries are built-ins from src/protection.js
     * plus the ones the operator added; `enabled` is their tick, `builtin` decides
     * whether the row can be deleted.
     */
    protection: async () => ({ entries: protectionEntries(getConfig() || {}) }),

    /** The native picker behind Settings > Prohibited > Add. Runs on this PC. */
    pickProtectionPath: async (body) => {
      const kind = body?.kind === 'file' ? 'file' : 'folder';
      const script =
        kind === 'file'
          ? [
              'Add-Type -AssemblyName System.Windows.Forms',
              '$d = New-Object System.Windows.Forms.OpenFileDialog',
              "$d.Title = 'Protect a file'",
              'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileName }',
            ].join('\n')
          : [
              'Add-Type -AssemblyName System.Windows.Forms',
              '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
              "$d.Description = 'Protect a folder'",
              '$d.ShowNewFolderButton = $false',
              'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }',
            ].join('\n');
      const chosen = await new Promise((resolve, reject) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-STA', '-Command', script],
          { windowsHide: true, timeout: 300000 },
          (err, stdout, stderr) => {
            if (err) {
              reject(new Error(String(stderr || err.message).split(/\r?\n/).filter(Boolean).pop() || err.message));
              return;
            }
            resolve(String(stdout || '').trim());
          },
        );
      });
      return { path: chosen || null };
    },

    createSession: async (body) => {
      requireReady();
      // A conversation is the project's. There is no built-in project to open a
      // chat in, so a create without one is a caller bug, not a default.
      const project = body?.projectId ? projects.find(body.projectId) : null;
      if (!project) {
        throw fail(400, 'choose a project first');
      }
      const location = project.directory;
      const session = await engine.createSession({
        // The engine's own title is never shown: the rail names the project. It is
        // set to the project's name so the engine's list is readable in an audit.
        title: project.name,
        model: body?.model,
        agent: body?.agent,
        // The permission ladder comes first: every write, shell, read and code
        // call asks the engine, and the gate answers from the policy. The
        // caller's own rules (Single's `subagent` deny) come after, so a mode
        // rule still wins by being last, and the role's skill list comes last of
        // all for the same reason.
        permissions: [
          ...rulesFor(),
          ...(Array.isArray(body?.permissions) ? body.permissions : []),
          ...skillRules(getConfig(), 'architect'),
        ],
        directory: location,
      });
      // From the first turn, the Architect knows where it is and that the plan
      // file is its own to keep.
      await brief(session.id, location, 'architect', false);
      // A new project starts with the four automation switches written down, not
      // left to be inferred: Keep Building on, the other three off. Writing them
      // here means the cog has real values to show before anything is toggled, and
      // a later change to the defaults cannot move a project that already exists.
      try {
        await engine.updateSessionMetadata(session.id, {
          synapse: { automation: { ...AUTOMATION_DEFAULTS }, auto: AUTOMATION_DEFAULTS.keepBuilding, fullAuto: false },
        });
      } catch (err) {
        app.warn(`could not write the automation defaults for ${session.id}: ${err.message}`);
      }
      // A new session is a new piece of work, and the census is a picture of what
      // the models are doing *now*: left to accumulate it describes a machine that
      // no longer exists. The operator opens the popup to answer "what is being
      // called", not "what has ever been called".
      if (toolStats) toolStats.clear();
      return { session, projectId: project.id };
    },

    /** Switch the model and/or thinking effort used by an existing session. */
    switchModel: async (sessionId, body) => {
      requireReady();
      const model = body?.model;
      if (!model || (typeof model === 'string' && !model.includes('/'))) {
        throw fail(400, 'a model reference is required');
      }
      await engine.switchModel(sessionId, model);
      return { ok: true };
    },

    messages: async (sessionId) => {
      requireReady();
      return { messages: await engine.getMessages(sessionId) };
    },

    /**
     * The open session's project plan, read straight from `.synapse\plan.json`
     * in its directory. The file is the source of truth — there is no store to
     * keep in sync, and a plan written by hand reads the same as one the
     * Architect wrote.
     */
    plan: async (sessionId) => {
      let directory = null;
      try {
        const session = await engine.getSession(sessionId);
        directory = session?.directory || null;
      } catch { /* session gone; report no plan rather than an error */ }
      const state = directory ? readPlan(directory) : readPlan('');
      // The pane polls this, so the logger is told once per distinct problem
      // rather than once per poll (see logPlanState).
      logPlanState(state, app);
      // How long each step has actually taken, and which steps this session's
      // workers have handed back. Both are read from the project's run log, so
      // both survive a reload — but scoped to *this* session: a task id means
      // nothing across sessions, and an old run under the same id was showing its
      // time and its "waiting for review" on a plan it never touched.
      const { spent, reported } = directory
        ? runLedger(readRuns(directory), sessionId)
        : { spent: {}, reported: [] };
      return { ...state, used: usedRoles(directory, sessionId), spent, reported };
    },

    sendMessage: async (sessionId, body, actor = null) => {
      requireReady();
      const text = String(body?.text ?? '').trim();
      // An attachment on its own is a message: "look at this" with the file in
      // hand is a request, and refusing it because there was no sentence would be
      // the harness being pedantic about the shape of a sentence.
      const attachments = normalizeAttachments(body?.files);
      if (!text && !attachments.length) {
        throw fail(400, 'message text is required');
      }
      // One project, one conversation. The rule is the same for both views — a
      // second prompt into a working project would interleave with a plan that is
      // already in flight, whoever sends it. Cards and Stop stay open.
      const busy = await busyFor(sessionId);
      if (busy.busy) throw refuseBusy(busy);
      if (actor?.name) {
        drivers.set(sessionId, { name: actor.name, id: actor.id || null, at: Date.now() });
        if (busy.directory) drivers.set(normDir(busy.directory), { name: actor.name, id: actor.id || null, at: Date.now() });
      }
      // The mode is a choice about *this message*. It is applied here, once, so a
      // toggle clicked ten times and then sent applies exactly one — and the mode
      // the engine enforces is always the one this turn was briefed with.
      const asked = body?.mode === 'single' ? 'single' : body?.mode === 'multi' ? 'multi' : null;
      let directory = '';
      let single = false;
      let sessionModel = '';
      try {
        const session = await engine.getSession(sessionId);
        directory = session?.directory || '';
        sessionModel = String(session?.model || '');
        const applied = session?.single === true ? 'single' : 'multi';
        single = asked ? asked === 'single' : applied === 'single';
        if (asked && asked !== applied) {
          // The mode rule is added to the policy, never instead of it. This used to
          // send the mode rule alone, and the engine then had no ask rule for any
          // tool: switching a chat to Single quietly turned the whole policy off,
          // and a write outside the project stopped raising a card (found by the
          // smoke test, 7 Nov). Session creation and the boot pass already compose
          // it this way; keep the three identical.
          await engine.updateSessionPermissions(sessionId, [
            ...rulesFor(),
            ...(single ? SINGLE_RULES : []),
            ...skillRules(getConfig(), 'architect'),
          ]);
          app.info(`mode ${applied} -> ${asked} for ${sessionId} (applied at send)`);
          notify?.({ kind: 'sessions', type: EV.mode, sessionId, mode: asked });
        }
        // A send into a finished plan starts a new round. Close it before the
        // brief, so the brief's QC allowance is this round's — and so the finished
        // plan keeps its row times until this moment. Closing at the end of the
        // plan (in the wake) hid them: the marker is the ledger's boundary, and a
        // just-closed plan's own results sit before it ("not run", 28 Oct).
        if (directory) {
          try {
            if (runs?.closeRound?.(directory)) app.info(`round closed: ${directory} - caps reset`);
          } catch (err) {
            app.warn(`could not close the round: ${err.message}`);
          }
        }
        await brief(sessionId, directory, 'architect', session?.automation?.keepBuilding === true, { single });
      } catch (err) {
        app.warn(`brief skipped for ${sessionId}: ${err.message}`);
      }
      // The operator's own words, written down before any model can restate them.
      // A Multi message is the project's request; a Single one is a side ask, so it
      // is logged as a chat and never becomes the head's Request. Both are in the
      // same file, so nothing the operator said is lost when a conversation ends.
      if (directory) {
        const body = text || `(attached ${attachments.length} file(s))`;
        const written = single ? appendChat(directory, body) : appendProjectRequest(directory, body);
        if (written && written.ok === false) app.warn(`could not write to the project document: ${written.error}`);
      }
      // Speaking is the answer to "what now" after a stop: whatever they stopped
      // may run again from here, and a stop still watching the project must not
      // interrupt the turn they just started.
      if (directory) {
        stopper.clear(directory);
        runs?.resume?.(directory);
      }
      // "Keep" is a deliberate project file, written before the message goes. The
      // inline copy is still what the model reads now; this copy is what survives a
      // compact and what a later Architect or a worker can open. Not a temp file:
      // it lives under the project and is deleted with the project.
      let kept = [];
      if (directory && attachments.some((f) => f.keep)) {
        try {
          kept = keepAttachments(directory, attachments);
          for (const file of kept) {
            const written = appendEntry(
              directory,
              'attachment',
              `Kept ${file.path} (${file.mime}, ${file.bytes} bytes).`,
            );
            if (written && written.ok === false) {
              app.warn(`could not record the kept attachment: ${written.error}`);
            }
          }
        } catch (err) {
          app.warn(`could not keep the attachments: ${err.message}`);
        }
      }
      // A new message is a new intent, so the question-loop history starts over.
      // Without this, asking the same question again on purpose — which the
      // operator does all the time in a test chat — was read as a model looping:
      // the second ask was answered with the *old* answer and the third stopped
      // the run (Test project, 3 Nov: "Single color" came back Red for a turn that
      // had asked for Yellow as the recommended option).
      questionHistory.delete(sessionId);
      // The chat is the Architect's, so the Architect's configured model is what the
      // next turn must run on. The session also carries a model of its own — the one
      // the engine last stored — and that can go stale: a provider renamed since
      // leaves a ref the engine refuses, and no amount of picking in the UI reaches
      // it, because picking saves the config and only a switch changes the session.
      // (9 Nov: `opencode-go/deepseek-v4.1-flash`, from before the provider became
      // `oc-go`.) One comparison per message, and the stale case repairs itself.
      const architectRef = String(getConfig()?.roles?.architect?.ref || '');
      if (architectRef && sessionModel !== architectRef) {
        try {
          await engine.switchModel(sessionId, architectRef);
          app.info(`model repaired for ${sessionId}: ${sessionModel || 'none'} -> ${architectRef}`);
        } catch (err) {
          // A switch that fails must not swallow the message: the prompt below is the
          // operator's actual request, and it will report the model it could not use.
          app.warn(`could not set the Architect's model for ${sessionId}: ${err.message}`);
        }
      }
      // The operator's words are the message. A stop before this one is just a cut:
      // no note explains it, the same way a dropped connection is not explained. If
      // they want the work resumed or changed, they say so here.
      await engine.prompt(sessionId, text, { files: attachments });
      return { ok: true, kept };
    },

    /**
     * Send guidance into work that is already happening.
     *
     * The engine's prompt is an inbox entry: with `delivery: "steer"` it joins
     * the running turn and is read at its next step boundary. It cannot preempt
     * a tool call in flight or a token being generated; Stop is the hard
     * interrupt.
     *
     * Only the view that started the work may steer — "whoever started work (that
     * PC)" — because a second voice changing the task under the first is the
     * accident the busy rule existed to prevent. The driver is the computer name
     * recorded when the operator last sent into this project, so a reload on the
     * same PC still counts.
     */
    steer: async (sessionId, body, actor = null) => {
      requireReady();
      const text = String(body?.text ?? '').trim();
      const attachments = normalizeAttachments(body?.files);
      if (!text && !attachments.length) {
        throw fail(400, 'a steer needs at least a sentence');
      }
      if (text.length > STEER_MAX_CHARS) {
        const err = new Error(
          `a steer is one instruction (${STEER_MAX_CHARS} characters at most) — split it, or stop the run and send a message`,
        );
        err.status = 400;
        throw err;
      }
      const busy = await busyFor(sessionId);
      if (!busy.busy) {
        const err = new Error('Nothing is running now — send it as a message.');
        err.status = 409;
        err.body = { notBusy: true };
        throw err;
      }
      if (busy.state === 'waiting') {
        const err = new Error(`${busy.project || 'This project'} is waiting for an answer. Answer the card first.`);
        err.status = 409;
        err.busy = busy;
        throw err;
      }
      const directory = busy.directory;
      if (!directory) {
        throw fail(409, 'could not find the project for this session');
      }
      // A delegated worker is the thing working; the Architect is idle and would
      // only start a competing turn. `runs.steer` is the one place that knows the
      // live worker session.
      //
      // The operator speaking ends any stop in force, whichever way their words
      // travel. Measured 6 Nov: Stop, then a message sent a second later, and the
      // message became a steer to the very worker the stop was about to cut — the
      // stop went ahead and the words were never read.
      stopper.clear(directory);
      runs?.resume?.(directory);
      if (busy.kind === 'run') {
        // The worker's session is not the chat, so the run card is the only place
        // the operator's picture can be seen after they send it. The bytes go into
        // the project — the folder "Keep" already uses — and the card reads them
        // from there; the engine gets the bytes on the prompt as before.
        const saved = attachments.length
          ? keepAttachments(directory, attachments.map((f) => ({ ...f, keep: true })))
          : [];
        const result = await runs?.steer?.(directory, { text, files: attachments, saved, actor });
        if (!result?.ok) {
          const err = new Error(result?.reason || 'the worker could not be reached');
          err.status = 409;
          err.busy = busy;
          throw err;
        }
        app.info(`steer: ${actor?.name || 'operator'} -> ${result.task || 'worker'} (${result.role || '?'})`);
        return { ok: true, ...result };
      }
      // The open session's own turn (usually the Architect planning), or a
      // worker whose run record is gone. The engine's active list is the truth.
      const targetId = busy.sessionId || sessionId;
      const active = await engine.listActiveSessions().catch(() => []);
      if (!active.includes(targetId)) {
        const err = new Error('The turn just ended — send it as a message.');
        err.status = 409;
        err.body = { notBusy: true };
        throw err;
      }
      try {
        await engine.prompt(targetId, `[steer] ${text}`, { files: attachments, delivery: 'steer' });
      } catch (err) {
        const wrapped = new Error(`could not reach the session: ${err.message}`);
        wrapped.status = 502;
        throw wrapped;
      }
      const at = Date.now();
      appendRun(directory, {
        kind: 'steer',
        scope: 'session',
        session: targetId,
        at,
        by: actor?.name || null,
        text: text.slice(0, 1200),
      });
      app.info(`steer: ${actor?.name || 'operator'} -> ${targetId} (mid-turn)`);
      return { ok: true, target: targetId === sessionId ? 'architect' : 'session', at };
    },

    /**
     * Compact: the engine writes a handover, the conversation is discarded, a
     * fresh one starts in the same folder.
     *
     * This is the only reset. It is refused while anything is running (a chapter
     * cannot close mid-turn) and while another compact on the same chat is in
     * flight. Nothing is deleted until the handover is safely in the project
     * document: a compaction that fails leaves the conversation exactly as it was.
     *
     * The new session keeps what belongs to the project rather than the chat —
     * folder, mode, Keep Building, model — and carries the "Always Allow" grants,
     * because compaction is about context, not consent. Its metadata carries the
     * post the chat shows (`synapse.compacted`), and the project document's
     * `## Handover` carries the brief.
     */
    compactSession: async (sessionId, { timeoutMs = 180000 } = {}) => {
      requireReady();
      if (compacting.has(sessionId)) {
        throw fail(409, 'this conversation is already being compacted');
      }
      const busy = await busyFor(sessionId);
      if (busy.busy) throw refuseBusy(busy);
      const session = await engine.getSession(sessionId);
      if (!session?.directory) {
        throw fail(400, 'this conversation is not in a project folder');
      }
      const before = await engine.getMessages(sessionId).catch(() => []);
      if (!before.length) {
        throw fail(400, 'there is nothing to compact yet');
      }
      compacting.add(sessionId);
      compactCancels.delete(sessionId);
      const cancelled = () => {
        const err = new Error('the compaction was cancelled; nothing was deleted');
        err.status = 409;
        return err;
      };
      try {
        try {
          await engine.compact(sessionId);
        } catch (err) {
          const wrapped = new Error(`the engine could not compact: ${err.message}`);
          wrapped.status = 502;
          throw wrapped;
        }
        const handover = await waitForHandover(sessionId, before, timeoutMs, compactCancels);
        if (compactCancels.has(sessionId)) throw cancelled();
        if (!handover) {
          throw fail(504, 'the engine did not write a handover in time; nothing was deleted');
        }
        if (handover.failed) {
          const err = new Error(`${handover.reason || 'the compaction failed'}; nothing was deleted`);
          err.status = handover.cancelled ? 409 : 502;
          throw err;
        }
        const at = handover.at || Date.now();
        if (!setHandover(session.directory, handover.text, { at })) {
          throw fail(500, 'the handover could not be written to the project document; nothing was deleted');
        }
        if (compactCancels.has(sessionId)) throw cancelled();
        const marker = appendEntry(
          session.directory,
          'compact',
          `The conversation was discarded after ${handover.messages} messages; the handover is in this document.`,
          { at },
        );
        if (marker && marker.ok === false) app.warn(`could not mark the compact in the project document: ${marker.error}`);

        const meta = session.metadata && typeof session.metadata === 'object' ? { ...session.metadata } : {};
        const synapse = { ...(meta.synapse && typeof meta.synapse === 'object' ? meta.synapse : {}) };
        // The new conversation keeps the four switches (and the legacy mirrors
        // `nextSynapse` writes), or a compaction would quietly reset the project's
        // automation.
        Object.assign(synapse, nextSynapse(synapse, readAutomation(session)));
        synapse.compacted = { at, summary: handover.text, messages: handover.messages };
        if (compactCancels.has(sessionId)) throw cancelled();
        const created = await engine.createSession({
          title: path.basename(session.directory) || 'chat',
          model: session.model ? { ref: session.model, variant: session.variant || undefined } : undefined,
          directory: session.directory,
          permissions: session.single ? SINGLE_RULES : [],
          metadata: { ...meta, synapse },
        });
        if (!created?.id) {
          throw fail(502, 'the engine did not return a new conversation; nothing was deleted');
        }
        if (compactCancels.has(sessionId)) {
          // Stop landed while the replacement was being made: remove the orphan
          // and leave the conversation the operator still has open untouched.
          try { await engine.deleteSession(created.id); } catch { /* left for the sweep */ }
          throw cancelled();
        }
        try {
          permissionMemory?.carry?.(sessionId, created.id);
        } catch (err) {
          app.warn(`the Always Allow grants could not be carried to the new conversation: ${err.message}`);
        }
        try {
          await engine.deleteSession(sessionId);
        } catch (err) {
          // The new chat is live and the old one is now an orphan; the app shows
          // the new one, and the failure is in the log for a later sweep.
          app.warn(`the old conversation could not be deleted after a compact: ${err.message}`);
        }
        briefed.delete(sessionId);
        await brief(created.id, session.directory, 'architect', session?.automation?.keepBuilding === true, {
          single: session.single === true,
        });
        app.info(
          `compacted ${sessionId} -> ${created.id}: ${handover.messages} messages, handover ${handover.text.length} chars`,
        );
        notify?.({
          kind: 'project',
          type: 'project.compacted',
          oldSessionId: sessionId,
          sessionId: created.id,
          directory: session.directory,
          at,
        });
        return {
          ok: true,
          sessionId: created.id,
          oldSessionId: sessionId,
          at,
          messages: handover.messages,
          summary: handover.text,
        };
      } finally {
        compacting.delete(sessionId);
        compactCancels.delete(sessionId);
      }
    },

    /**
     * The four automation switches, per project. The body carries a `patch`, so the
     * page sends only what moved and the answer is always the whole set.
     */
    setAutomation: async (sessionId, body) => applyAutomation(sessionId, body?.patch),

    /** The old two switches, still callable: each maps onto the one it became. */
    setAuto: async (sessionId, body) => applyAutomation(sessionId, { keepBuilding: body?.auto === true }),

    setFullAuto: async (sessionId, body) =>
      applyAutomation(sessionId, {
        autoPermissions: body?.enabled === true,
        autoAnswer: body?.enabled === true,
      }),

    /**
     * The cog's "Keep PC Awake".
     *
     * It is not a per-project switch like the four above: the machine is one
     * machine. The cog toggles the global answer and it is written to the config,
     * so it survives a restart; Settings > Automation has the same switch plus the
     * amplified one (keep the monitor on too).
     */
    setPower: async (body) => {
      const awake = body?.awake === true;
      const current = getConfig() || {};
      const saved = applyConfig({
        ...current,
        automation: { ...(current.automation || {}), keepAwake: awake },
      });
      const state = power?.apply?.(saved.automation) || { awake: false, display: false, error: null };
      if (awake && state.error) {
        throw fail(500, `the wake lock could not be held: ${state.error}`);
      }
      notify?.({
        kind: 'config',
        type: 'config.saved',
        config: toClientConfig(saved),
        by: null,
        byId: null,
      });
      return { ok: true, automation: saved.automation, power: state };
    },

    /** One form sweep, called on a timer by the server. Exposed for tests. */
    autoAnswerTick: async () => formAuto.tick(),

    /** Stop now. One owner: src/stop.js decides, watches and reports. */
    interrupt: async (sessionId) => {
      requireReady();
      // A compact is a request plus a wait; Stop must end that wait, or the page
      // sits on "Compacting…" until the three-minute timeout.
      if (cancelCompact(sessionId)) app.info(`compact cancelled for ${sessionId}`);
      const out = await stopper.stop({ sessionId, hard: true });
      return { ok: true, stoppedRun: false, stopped: [sessionId], stopping: out.stopping, phase: out.phase };
    },

    /**
     * The first Stop: finish the step in flight, then end the turn.
     *
     * The second press cuts now. Both go through `stopper`, which keeps
     * interrupting while the engine's own retry loop is still alive — an interrupt
     * during its thirty-second backoff is a no-op, which is how five Stops in a
     * row each said "interrupted" and changed nothing (6 Nov).
     */
    stop: async (sessionId) => {
      requireReady();
      // A compact is a request plus a wait, not a step: there is nothing to finish
      // and its own timeout is three minutes. The immediate press always cancelled
      // it; the gentle one did not, so Stop during a compact sat behind the grace
      // while the page said "Compacting…".
      if (cancelCompact(sessionId)) app.info(`compact cancelled for ${sessionId}`);
      const busy = await busyFor(sessionId);
      if (busy.engineDown) throw fail(503, 'The engine is not answering, so there is nothing to stop.');
      if (!busy.busy) {
        throw fail(409, 'Nothing is running now.');
      }
      if (busy.state === 'waiting') {
        const err = new Error('A question or permission card is waiting; stopping now is immediate.');
        err.status = 409;
        err.body = { waiting: true };
        throw err;
      }
      const out = await stopper.stop({ sessionId: busy.sessionId || sessionId, hard: false });
      return { ...out, task: out.target === 'worker' ? busy.task : undefined };
    },

    /** The stop state for a page that reloaded mid-stop, and the boundary feed. */
    stopState: (directory) => stopper.state(directory),
    onEngineEvent: (ev) => stopper.handleEvent(ev),

    // ── the screen ──────────────────────────────────────────
    /** Who has the operator's screen, if anyone. Read by the page on load and
     *  after every reconnect: a lease is not something the stream can lose. */
    deskState: async () => ({ ...(desk?.state?.() || { desk: null }), now: Date.now() }),

    /** Take the screen back. The work that asked keeps running — it just cannot
     *  take the screen again until the operator allows it once more. */
    releaseDesk: async (body = {}) => {
      const why = String(body?.why || '').trim() || 'the operator took it back';
      const out = desk?.release?.(why) || { ok: false, released: false };
      if (out.released) app.info(`the screen was taken back by the operator (${out.held?.dir || 'unknown'})`);
      return out;
    },
    permission: async (sessionId, body, actor = null) => {
      requireReady();
      const wanted = body?.decision || 'once';
      // The operator's own sentence, when a rejection carried one. Bounded and
      // flattened: it travels in a message to a model, and a 3,000-word essay
      // would become the next turn's prompt.
      const reason = String(body?.reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      // "Always" is ours, not the engine's. The engine's `always` saves the
      // request's `save` patterns for the whole project; for an edit those are
      // `*`, so one click would let the AI edit anything, including Synapse. We
      // answer once and remember this exact action + resource for the session.
      const decision = wanted === 'always' ? 'once' : wanted;
      const entry = permissionLog?.get?.(body?.requestId);
      // Two views can see the same card. The first answer is the answer; the
      // second is not an error, it is a page that was a moment late — it still
      // needs the decision broadcast so its panel closes.
      let already = false;
      try {
        await engine.replyPermission(sessionId, body?.requestId, decision);
      } catch (err) {
        if (/not found|already|gone|404|409/i.test(String(err?.message || ''))) {
          already = true;
        } else {
          throw err;
        }
      }
      // Answered here (or by another view): a pending permission-timeout must not
      // fire on a card that is already settled.
      permissionGate?.answered?.(body?.requestId, decision);
      // The gate logs what the policy decided; the operator's own answer had no
      // line at all, so a card that left the screen had no record of who removed
      // it, from which page, or with which button. One line per decision, in the
      // same shape as the gate's (30 Oct: a card "disappeared before I could
      // answer", and the log could only say a reply had been sent).
      {
        const what = entry
          ? `${entry.action || 'tool call'} ${(entry.resources || []).join(' ')}`.replace(/\s+/g, ' ').trim().slice(0, 140)
          : `request ${body?.requestId || '?'}`;
        const who = entry?.role ? ` (${[entry.role, entry.task].filter(Boolean).join(' ')})` : '';
        const label = wanted === 'always' ? 'Always Allow' : decision === 'reject' ? 'Reject' : 'Allow Once';
        app.info(
          `permission ${decision === 'reject' ? 'refused' : 'allowed'} in the page${
            actor?.name ? ` by ${actor.name}` : ''
          }${who}: ${what} — ${label}${already ? ' (already answered elsewhere)' : ''}`,
        );
      }
      if (!already && decision === 'reject') {
        // The reply's `message` is dropped on this route (measured), so the note is
        // a synthetic message: the only channel that reaches the asker. Workers get
        // it always (the role is told and carries on). The Architect gets it when
        // the operator typed a reason — that sentence is the point of "Reject With
        // Reason" (3 Nov), and without this the reason vanished for its own chat.
        // With no reason the old rule stands: no extra turn in the Architect's chat,
        // which once ended a report empty (26 Oct).
        const askedByWorker = entry?.role && entry.role !== 'architect';
        if (askedByWorker || reason) {
          Promise.resolve(
            engine.synthetic?.(sessionId, refusalNote({ role: entry?.role, scope: entry?.scope, reason }), {
              description: 'permission refused',
            }),
          ).catch((err) => app.warn(`could not explain the refusal to ${sessionId}: ${err.message}`));
        }
      }
      if (!already && wanted === 'always' && entry) {
        permissionGate?.remember?.(entry.sessionId || sessionId, entry.action, entry.resources);
      }
      // The chip on the tool call: this is the moment an ask becomes a decision,
      // and the only one the policy did not already record. The operator's reason
      // rides it, so the transcript can say what they told the role.
      const answered = permissionLog?.answer?.(
        body?.requestId,
        decision,
        actor?.name || null,
        decision === 'reject' ? reason || null : null,
      );
      const by = actor?.name || null;
      if (answered) {
        notify?.({
          kind: 'permission',
          type: 'permission.decided',
          decision: { ...answered, by },
          requestId: body?.requestId,
          sessionId,
        });
      } else {
        notify?.({
          kind: 'permission',
          type: 'permission.decided',
          decision: { requestId: body?.requestId, sessionId, decision, effect: decision === 'reject' ? 'deny' : 'allow', by },
          requestId: body?.requestId,
          sessionId,
        });
      }
      return { ok: true, already };
    },

    /** Is this session's project busy, and why — what the composer shows. */
    busy: async (sessionId) => busyFor(sessionId),

    /** Decisions recorded for a session, for the chips on a transcript that was
     *  loaded after they happened. */
    permissionDecisions: async (sessionId) => ({
      decisions: sessionId ? permissionLog?.list?.(sessionId) || [] : [],
    }),

    /**
     * Everything currently waiting on the operator. A session blocked on a
     * permission or a form makes no progress and emits nothing, so this is the
     * only way to notice it after a reload.
     */
    pending: async (focusSessionId = null) => {
      if (!engine.status().ready) return { permissions: [], forms: [], active: [], canStop: false, stopping: null };
      const [permissions, active] = await Promise.all([
        safe(() => engine.listPendingPermissions(), []),
        safe(() => engine.listActiveSessions(), []),
      ]);

      // Can Stop do anything for the session on screen? A hidden worker in the
      // same project counts, and it is the case the operator cannot see: the
      // Architect is idle, the run record may be gone, and the worker is still
      // working. Without this the button sat disabled while the project ran.
      let canStop = false;
      let activeHere = 0;
      let focusDir = null;
      if (focusSessionId && active.length) {
        try {
          const focus = await engine.getSession(focusSessionId);
          const directory = focus?.directory || null;
          focusDir = directory;
          if (directory) {
            const known = await engine.listSessions();
            const targets = stopTargets({ sessionId: focusSessionId, directory, active, sessions: known });
            activeHere = targets.filter((id) => active.includes(id)).length;
            canStop = activeHere > 0;
          }
        } catch { /* the button stays off rather than guessing */ }
      }
      // A stop in force outlives a page reload. Without this the notice and the
      // red button vanished on refresh while the work was still stopping.
      const stopping = focusDir ? stopper.state(focusDir) : null;

      // Forms have to be asked for per session. The engine's global list is
      // scoped to its *own* location (the workspace), so a form raised by a
      // session running in a project subfolder is not in it — which is why a
      // question from a project session used to be invisible while the session
      // sat there blocked. A session waiting on a form is exactly a session the
      // engine reports as active, and the session the operator has open is asked
      // for by name as well, so the panel is never wrong about what is on screen.
      const ask = [...new Set([...active, focusSessionId].filter(Boolean))];
      // Permissions have the same location scope as forms: the engine's global
      // list only covers its own directory, and every project session runs in a
      // subfolder of it. Without this, an ask raised inside a project never
      // reached the UI — measured 26 Oct: the global list was empty while the
      // session was blocked on a request it held. Ask the active sessions and the
      // open one directly, and merge by request id.
      const permissionLists = await Promise.all([
        Promise.resolve(permissions),
        ...ask.map((id) => safe(() => engine.listSessionPermissions(id), [])),
      ]);
      const allPermissions = [];
      const seenRequests = new Set();
      for (const list of permissionLists) {
        for (const p of list || []) {
          const id = p?.id || p?.requestID;
          if (!id || seenRequests.has(id)) continue;
          // A request the policy is judging right now, or has already answered,
          // is not the operator's to see. The engine lists it as pending from the
          // moment it raises it, so without this a write inside the project — which
          // the policy always allows — could paint a card for one poll and take it
          // away on the next. That flash is what a run looked like with every call
          // allowed (30 Oct).
          if (permissionGate?.answering?.(id)) continue;
          if (permissionLog?.get?.(id)?.decided) continue;
          seenRequests.add(id);
          allPermissions.push(p);
        }
      }

      const lists = await Promise.all([
        safe(() => engine.listForms(), []),
        ...ask.map((id) => safe(() => engine.listForms(id), [])),
      ]);
      const forms = [];
      const seen = new Set();
      for (const list of lists) {
        for (const f of list || []) {
          if (!f?.id || seen.has(f.id)) continue;
          seen.add(f.id);
          forms.push(f);
        }
      }

      // A worker that asks the same question again is looping, not gathering
      // information. See guardQuestions: the second ask is answered for it, the
      // third stops the run and says so.
      const open = await guardQuestions(forms);

      // A permission request carries an action and a path, not a name. The card
      // has to say who is asking — a hidden worker's request is as real as the
      // open session's, and "coder-2, t4: write ..\..\Windows\x" is a different
      // decision from "something wants to write". The session is where the role,
      // the task and the directory live, so they are read here, once per request.
      const sessionIds = [...new Set(allPermissions.map((p) => p.sessionID).filter(Boolean))];
      const sessionInfo = new Map();
      await Promise.all(
        sessionIds.map(async (id) => {
          try {
            const s = await engine.getSession(id);
            if (s) sessionInfo.set(id, s);
          } catch { /* gone between the two calls */ }
        }),
      );

      return {
        permissions: allPermissions.map((p) => {
          const s = sessionInfo.get(p.sessionID);
          const meta = s?.metadata?.synapse || {};
          const directory = s?.directory || null;
          const action = p.action || p.title || 'tool call';
          const resources = Array.isArray(p.resources) ? p.resources : [];
          const isPath = /^(edit|write|read|patch|create)$/i.test(String(p.action || ''));
          const resolved =
            isPath && directory ? resources.map((r) => resolvePath(r, directory)?.path || String(r)) : [];
          const verdict = directory
            ? decide({
                action,
                resources,
                cwd: directory,
                projectRoot: directory,
                harnessRoot: ROOT,
                scratchRoot: SCRATCH_ROOT,
                protection: protectionFor(getConfig() || {}),
              })
            : null;
          return {
            requestId: p.id || p.requestID || null,
            sessionId: p.sessionID || null,
            action,
            resources,
            resolved,
            message: p.message || null,
            title: s?.title || null,
            role: meta.role || null,
            task: meta.task || null,
            directory,
            reason: verdict?.reason || '',
            scope: verdict?.scope || '',
            // When Auto-Permissions will allow this card, in epoch ms — the card
            // counts down to that moment instead of stating a fixed wait. Null when
            // the switch is off for the asking project, so nothing counts.
            autoPermissionsAt: permissionGate?.autoAllowAt?.(p.id || p.requestID) ?? null,
            // A write request carries the diff the model is about to apply. That
            // is the difference between "a file" and "this exact change", and it
            // is the operator's best evidence when the card asks them to decide.
            files: Array.isArray(p.metadata?.files)
              ? p.metadata.files.map((f) => ({
                  file: f.file || '',
                  status: f.status || '',
                  patch: f.patch || '',
                  additions: Number(f.additions) || 0,
                  deletions: Number(f.deletions) || 0,
                }))
              : [],
          };
        }),
        forms: await Promise.all(
          open.map(async (f) => {
            // Whether *this chat* answers its own questions (Auto-Answer is on for
            // it). It is that chat's switch, not the one on screen: a worker asking
            // from another chat must not be labelled with the open chat's setting.
            const autoAnswer = await formAuto.enabledFor(f.sessionID);
            // When the first page appeared and how many pages the form has, so the
            // panel can count each one down and turn the page itself. The reply goes
            // after the last page's wait, which is `autoAnswerAt` — one wait per
            // page, measured from the moment the sweep first saw the form.
            const seen = formAuto.seenAt?.(f.id);
            const waitMs = answerTimeoutMs(getConfig());
            const pages = formPages(f);
            const firstAt = Number(seen) || Date.now();
            return {
              id: f.id,
              sessionId: f.sessionID,
              title: f.title || 'Input needed',
              fields: Array.isArray(f.fields) ? f.fields : [],
              autoAnswer,
              autoAnswerFirstAt: autoAnswer ? firstAt : null,
              autoAnswerPages: pages,
              autoAnswerAt: autoAnswer ? firstAt + pages * waitMs : null,
            };
          }),
        ),
        active,
        canStop,
        activeHere,
        stopping,
      };
    },

    replyForm: async (sessionId, formId, body, actor = null) => {
      requireReady();
      const answer = body?.answer && typeof body.answer === 'object' ? body.answer : {};
      // The form goes away once answered, so remember what it asked first.
      const form = await safe(() => engine.listForms(sessionId), []).then((list) => (list || []).find((f) => f.id === formId));
      await engine.replyForm(sessionId, formId, answer);
      // The other view's panel has to close: an answered question is a form that
      // no longer exists, and a page still showing it is a page waiting for a
      // reply nobody will send.
      notify?.({
        kind: 'form',
        type: 'form.answered',
        formId,
        sessionId,
        by: actor?.name || null,
      });
      const signature = formSignature(form);
      if (signature) {
        const per = questionHistory.get(sessionId) || new Map();
        per.set(signature, { answer, asks: 1 });
        questionHistory.set(sessionId, per);
      }
      // Written where the model can find it after a compact, which is the one
      // thing a deleted conversation cannot survive. Best-effort: a session
      // outside a project has no .synapse, and an answer already given is not
      // worth failing the reply over.
      try {
        const session = await safe(() => engine.getSession(sessionId), null);
        if (session?.directory && Array.isArray(form?.fields) && form.fields.length) {
          const written = appendProjectDecision(session.directory, { fields: form.fields, answer });
          if (written && written.ok === false) app.warn(`could not write the operator's answer: ${written.error}`);
        }
      } catch (err) {
        app.warn(`could not write the operator's answer to the project document: ${err.message}`);
      }
      return { ok: true };
    },

    toolStats: async () => (toolStats ? toolStats.snapshot() : { total: 0, failed: 0, tools: [], models: [] }),

    /** Clear the tool census. */
    clearToolStats: async () => {
      if (toolStats) toolStats.clear();
      app.info('tool census cleared');
      return { ok: true };
    },

    /** The probe's case list plus the state of the last run. */
    probe: async () => {
      const s = probe ? probe.state() : { running: false, results: [] };
      return {
        running: s.running,
        current: s.current,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        results: s.results,
        // Which model these results are for — the toolset is per model.
        model: s.model || null,
        // Which tools this model was given, as it reported them. Used to label
        // a "not called" verdict honestly; the panel lists only the cases.
        toolset: s.toolset || [],
        cases: probe ? probe.cases.map((c) => ({ id: c.id, tool: c.tool })) : [],
      };
    },

    /**
     * Kick off a probe run. It takes minutes, so this returns immediately and
     * the run reports progress over the event stream. The run itself must NOT
     * be awaited here or the request would hang until every case finished.
     */
    runProbe: async () => {
      requireReady();
      if (!probe) return { started: false, reason: 'No probe available.' };
      if (probe.state().running) return { started: false, reason: 'A probe is already running.' };
      probe.run().catch((err) => app.error(`probe crashed: ${err.message}`));
      return { started: true };
    },
  };
}
