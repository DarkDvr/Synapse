// The four automation switches, as the page names them.
//
// The cog in the chat opens this list. It is one definition because three places
// draw it — the menu, the toasts and the Settings note — and a name that differs
// between them is how "Keep Running" became "Keep Building" in two halves of the
// interface.
//
// Only the keys and the words are here: the values live in the session's
// metadata (src/automation.js), and the waits live in Settings → Automation.
export const AUTOMATION_DEFAULTS = Object.freeze({
  keepBuilding: true,
  autoPermissions: false,
  autoAnswer: false,
  autoShutdown: false,
});

export const AUTOMATION_ROWS = Object.freeze([
  {
    key: 'keepBuilding',
    label: 'Keep Building',
    hint: 'Carry the plan through until it is done or blocked',
    on: 'The Architect carries the plan through to the end, until a task is blocked.',
    off: 'The Architect does one task, then stops for you.',
  },
  {
    key: 'autoPermissions',
    label: 'Auto-Permissions',
    hint: 'Allow once, by itself, after the wait in Settings → Automation',
    on: 'Permission cards are allowed once after the wait, without a click.',
    off: 'Every permission card waits for your click.',
  },
  {
    key: 'autoAnswer',
    label: 'Auto-Answer',
    hint: 'Take the Recommended option, after the wait in Settings → Automation',
    on: 'Questions are answered with the Recommended option after the wait.',
    off: 'Every question waits for your answer.',
  },
  {
    key: 'autoShutdown',
    label: 'Auto-Shutdown',
    hint: 'Turn the PC off when nothing is left to do',
    on: 'The PC goes off when nothing is running and nothing can start.',
    off: 'Synapse leaves the PC on.',
  },
]);

/** Any switch on: the cog is green, the way it was for either of the old two. */
export function anyAutomationOn(automation) {
  return AUTOMATION_ROWS.some((row) => automation?.[row.key] === true);
}
