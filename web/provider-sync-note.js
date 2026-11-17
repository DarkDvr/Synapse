// What the boot's model-list answer says to the operator.
//
// Two halves, deliberately not equally loud: the lists that changed are worth a line
// each — what arrived, what left — and the providers that did not answer are one
// comma-separated sentence. A provider that answered with exactly what it already
// had is not mentioned at all: there is nothing to do about it, and a notice that
// lists everything is a notice nobody reads.
//
// Pure — no DOM — so the shape is tested without a browser.
//
//   Got updated models from:
//   - OpenCode Go (+2, -1)
//   - Some Other Provider (-1)
//
//   Providers that didn't respond: Local LLM, PolyStrata

/** "OpenCode Go (+2, -1)" — a sign only on the numbers that moved. */
function lineOf(entry) {
  const bits = [];
  if (entry.added) bits.push(`+${entry.added}`);
  if (entry.removed) bits.push(`-${entry.removed}`);
  return `- ${entry.name} (${bits.join(', ')})`;
}

/**
 * The notice, or null when there is nothing to say.
 * `sync` is the report `syncProviderModels()` returns (and `/api/status` carries).
 */
export function providerSyncNote(sync) {
  if (!sync || typeof sync !== 'object') return null;
  const updated = (Array.isArray(sync.updated) ? sync.updated : []).filter(
    (u) => u && (Number(u.added) > 0 || Number(u.removed) > 0),
  );
  const failed = (Array.isArray(sync.failed) ? sync.failed : [])
    .map((f) => String(f?.name || '').trim())
    .filter(Boolean);
  if (!updated.length && !failed.length) return null;

  const lines = [];
  if (updated.length) {
    lines.push('Got updated models from:');
    for (const u of updated) lines.push(lineOf(u));
  }
  if (failed.length) {
    if (lines.length) lines.push('');
    lines.push(`Providers that didn't respond: ${failed.join(', ')}`);
  }
  return { title: 'Model Lists', body: lines.join('\n') };
}
