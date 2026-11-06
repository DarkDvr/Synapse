// The four automation switches, and the one place that reads them.
//
// They replaced two blunt ones: "Keep running" (carry on with the plan) and
// "Full auto" (answer *everything* for the operator). The pair had to be moved
// together, so an operator who wanted questions answered also had every
// permission allowed. The four are now independent, per project, and stored in
// the session metadata (`synapse.automation`) so they survive a restart and
// travel with the chat.
//
// The delays are NOT here: those are one global set in Settings → Automation,
// because they describe how patient the harness is, not what one project wants.
//
// Nothing in this file touches the disk or the engine: it is the shape, so the
// page, the API and the tests can agree on it.
export const AUTOMATION_KEYS = ['keepBuilding', 'autoPermissions', 'autoAnswer', 'autoShutdown'];

/**
 * What a project starts with. Only Keep Building is on: it is the same thing the
 * old "Keep running" did when the operator turned it on, and a new project that
 * stalls after one task is the more annoying default.
 */
export const AUTOMATION_DEFAULTS = Object.freeze({
  keepBuilding: true,
  autoPermissions: false,
  autoAnswer: false,
  autoShutdown: false,
});

/** Four booleans, whatever was stored. Unknown keys are dropped. */
export function cleanAutomation(value) {
  const src = value && typeof value === 'object' ? value : {};
  const out = { ...AUTOMATION_DEFAULTS };
  for (const key of AUTOMATION_KEYS) if (typeof src[key] === 'boolean') out[key] = src[key];
  return out;
}

/**
 * Read a session's automation, honouring the two switches that came before it.
 *
 * A session saved under the old names is not reset: `synapse.auto` becomes Keep
 * Building, `synapse.fullAuto` becomes both Auto-Permissions and Auto-Answer (it
 * answered both), and the old global "turn the PC off when the Architect
 * finishes" becomes Auto-Shutdown. An explicit `synapse.automation` always wins,
 * so the first toggle an operator flips settles that project for good.
 */
/**
 * Read the switches from one `synapse` metadata block, honouring the names that
 * came before them.
 *
 * A session saved under the old names is not reset: `synapse.auto` becomes Keep
 * Building, `synapse.fullAuto` becomes both Auto-Permissions and Auto-Answer (it
 * answered both), and the old global "turn the PC off when the Architect finishes"
 * becomes Auto-Shutdown. An explicit `synapse.automation` always wins, so the first
 * toggle an operator flips settles that project for good.
 */
function resolveAutomation(synapse, { shutdownWhenDone = false } = {}) {
  const block = synapse && typeof synapse === 'object' ? synapse : {};
  const stored = block.automation && typeof block.automation === 'object' ? block.automation : null;
  // A chat from before the four switches: `synapse.auto` was off unless the
  // operator turned it on, and that is what it keeps. The on-by-default belongs to
  // *new* projects, which are seeded with `synapse.automation` at creation — a chat
  // that never carried the switch must not start running itself after an update.
  const legacyKeep = typeof block.auto === 'boolean' ? block.auto : false;
  const legacyFull =
    typeof block.fullAuto === 'boolean'
      ? block.fullAuto
      : typeof block.permissionTimeout === 'boolean'
        ? block.permissionTimeout
        : null;
  return {
    keepBuilding: typeof stored?.keepBuilding === 'boolean' ? stored.keepBuilding : legacyKeep,
    autoPermissions:
      typeof stored?.autoPermissions === 'boolean'
        ? stored.autoPermissions
        : legacyFull === null
          ? AUTOMATION_DEFAULTS.autoPermissions
          : legacyFull,
    autoAnswer:
      typeof stored?.autoAnswer === 'boolean'
        ? stored.autoAnswer
        : legacyFull === null
          ? AUTOMATION_DEFAULTS.autoAnswer
          : legacyFull,
    autoShutdown:
      typeof stored?.autoShutdown === 'boolean' ? stored.autoShutdown : shutdownWhenDone === true,
  };
}

export function readAutomation(raw, options) {
  return resolveAutomation(raw?.metadata?.synapse, options);
}

/**
 * The metadata an update writes: the whole `synapse` block, plus the legacy keys
 * kept in step while anything might still read them (`synapse.auto` is what the
 * brief and the run record use).
 */
export function nextSynapse(synapse, patch) {
  const base = synapse && typeof synapse === 'object' ? { ...synapse } : {};
  // Resolved before the oldest name is dropped: the write carries forward what the
  // chat already had, and only then forgets the name it came from.
  const current = resolveAutomation(base);
  delete base.permissionTimeout;
  const next = cleanAutomation({ ...current, ...(patch || {}) });
  return {
    ...base,
    automation: next,
    // The old names are mirrors now: written so an older reader — or a brief
    // already in flight — cannot disagree with the switch the operator just set.
    auto: next.keepBuilding,
    fullAuto: next.autoPermissions && next.autoAnswer,
  };
}
