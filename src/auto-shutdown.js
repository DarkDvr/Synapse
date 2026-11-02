// Auto-Shutdown: turn the PC off when the harness has run out of things to do.
//
// The condition is deliberately the whole machine, not one project: a project
// with the switch on is only allowed to take the PC down when nothing anywhere is
// running, nothing is waiting for a question or a permission, and no turn is live.
// Anything else and the shutdown would kill work the operator never agreed to
// lose.
//
// The clock lives here, in the server. A hidden window throttles its timers — the
// operator who needs this is asleep with Synapse in the tray — and a countdown in
// a hidden page can take twenty minutes or never come. The page only draws what
// the server announces.
//
// It does not shut the machine down itself: it arms the countdown the shutdown
// feature already has, which announces itself, can be cancelled, and refuses on
// its own if a run has started.
import { AUTOMATION_DEFAULTS, readAutomation } from './automation.js';
import { shutdownIdleMs } from './auto-answer.js';

/**
 * @param {object} deps
 * @param {object} deps.engine    the engine adapter (sessions, active turns, forms, permissions)
 * @param {object} deps.api       `runs()`, `powerOffState()`, `armPowerCountdown()` and `cancelPowerOff()`
 * @param {object} [deps.logger]
 * @param {() => object} deps.getConfig
 * @param {() => number} [deps.now]
 */
export function createAutoShutdown({ engine, api, logger, getConfig, now = Date.now }) {
  const log = logger?.channel?.('app');
  // When the machine last became quiet. The idle delay counts from here, not from
  // an event, so a page that was never open cannot change the answer.
  let quietSince = null;
  // Was the countdown ours? A cancel by the operator must start the whole wait
  // again rather than re-arm on the next tick.
  let armed = false;

  const sessionsWith = async () => {
    const list = await engine.listSessions();
    return (list || []).filter((s) => readAutomation(s.raw || s).autoShutdown === true);
  };

  /** Is there anything at all the harness could still be doing? */
  async function quiet() {
    const [active, forms, permissions, runs] = await Promise.all([
      engine.listActiveSessions().catch(() => []),
      engine.listForms().catch(() => []),
      engine.listPendingPermissions().catch(() => []),
      api.runs().catch(() => ({ runs: [] })),
    ]);
    const live = (runs?.runs || []).length + (active || []).length;
    return {
      quiet: live === 0 && (forms || []).length === 0 && (permissions || []).length === 0,
      why: live
        ? `${live} turn(s) running`
        : (forms || []).length
          ? `${forms.length} question(s) waiting`
          : (permissions || []).length
            ? `${permissions.length} permission(s) waiting`
            : '',
    };
  }

  async function tick() {
    try {
      const wanted = await sessionsWith();
      if (!wanted.length) {
        quietSince = null;
        // A project that switched Auto-Shutdown off must not leave a countdown
        // running that it armed a minute ago.
        if (armed) {
          armed = false;
          await api.cancelPowerOff().catch(() => {});
        }
        return { skipped: 'no project has Auto-Shutdown on' };
      }

      const state = await quiet();
      if (!state.quiet) {
        quietSince = null;
        if (armed) {
          armed = false;
          await api.cancelPowerOff().catch(() => {});
          log?.info(`auto-shutdown cancelled: ${state.why}`);
        }
        return { skipped: state.why };
      }

      // The operator cancelled the countdown: the whole wait starts again, so a
      // Cancel is a decision and not a speed bump.
      const power = await api.powerOffState().catch(() => ({ armed: false }));
      if (armed && !power.armed) {
        armed = false;
        quietSince = now();
        return { skipped: 'cancelled' };
      }
      if (armed) return { skipped: 'countdown running' };

      if (quietSince === null) quietSince = now();
      const wait = shutdownIdleMs(getConfig());
      if (now() - quietSince < wait) return { waiting: wait - (now() - quietSince) };

      armed = true;
      const minutes = Math.round(wait / 60_000);
      log?.info(`auto-shutdown: nothing to do for ${minutes} minute(s), starting the countdown`);
      const armedNow = await api.armPowerCountdown();
      if (armedNow?.ok !== true) {
        armed = false;
        log?.warn(`auto-shutdown could not start the countdown: ${armedNow?.error || 'unknown'}`);
      }
      return { armed: armedNow };
    } catch (err) {
      log?.warn(`auto-shutdown tick failed: ${err.message}`);
      return { error: err.message };
    }
  }

  return { tick, defaults: AUTOMATION_DEFAULTS };
}
