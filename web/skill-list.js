// The skills the page may offer.
//
// The engine reports two kinds in one list: the skills in Synapse's own folder (and
// the folders the operator configured), and skills compiled into the engine binary
// (`skill://browser/…`). The second kind describes the OpenCode desktop app; its
// tool names do not exist here, so showing it would only invite a model to call
// something Synapse never registers. The engine marks them `builtin` (see
// `listSkills` in src/engines/opencode.js); this is the one filter the UI uses.

/** The skills a role can actually be given on this machine. */
export function visibleSkills(skills) {
  return (Array.isArray(skills) ? skills : []).filter((s) => s && !s.builtin);
}
