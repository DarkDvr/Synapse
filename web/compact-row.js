// One compaction, drawn as an ordinary tool call: dot, name, target, state, chevron.
// A compaction is a Synapse event, so its text keeps the harness yellow; otherwise
// the card is the same one every other tool uses, with the same fold.
import { esc } from './format.js';

/** 172000 -> "172K"; a million is one decimal. */
const compactK = (n) =>
  !n ? '0' : n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);

/**
 * `running` says "Compacting", otherwise "Compacted"; `count` is its place in the
 * chat, `size` the prompt that caused it, `limit` the window. `line` is the optional
 * `data-line` attribute the transcript's arrival animation gives a row.
 */
export function compactRow({
  id = '',
  running = false,
  count = 1,
  size = 0,
  limit = 0,
  status = '',
  error = '',
  open = false,
  line = '',
} = {}) {
  const n = Math.max(1, Number(count) || 1);
  const action = running ? 'Compacting' : 'Compacted';
  const where = Number(size)
    ? `context at ${compactK(Number(size))}${Number(limit) ? `/${compactK(Number(limit))}` : ''}`
    : 'the conversation is being summarised';
  const failed = !running && (String(status) === 'failed' || Boolean(error));
  const cls = running ? 'warn' : failed ? 'err' : 'ok';
  const stateLabel = running ? 'running' : failed ? 'failed' : 'completed';
  const key = `compact:${id || 'latest'}`;
  const detail = running
    ? 'The engine is summarising this conversation. The chat continues in a new session when it finishes.'
    : failed
      ? (error || 'The compaction did not finish.')
      : 'The conversation was compacted; the handover is in .project/project.md and the chat continues in a new session.';
  return `<div class="tool-card is-compact-card${open ? ' open' : ''}" data-tool-card="${esc(key)}"${line}>
    <div class="tool-head" role="button" tabindex="0" data-tool-toggle="${esc(key)}" aria-expanded="${open ? 'true' : 'false'}" aria-controls="${esc(key)}-detail">
      <span class="status-dot ${cls}" role="img" aria-label="${esc(stateLabel)}"></span>
      <span class="tool-name">${esc(action)} ×${n}</span>
      <span class="tool-target" title="${esc(where)}">${esc(where)}</span>
      <span class="tool-state state-pill ${cls}">${esc(stateLabel)}</span>
      <span class="tool-chev" aria-hidden="true">›</span>
    </div>
    <div class="tool-detail" id="${esc(key)}-detail"${open ? '' : ' hidden'}>
      <div class="tool-body"><pre>${esc(detail)}</pre></div>
    </div>
  </div>`;
}
