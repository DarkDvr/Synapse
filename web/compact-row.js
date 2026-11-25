// One compaction, drawn as the row a tool call uses — dot, name, target — in the
// harness yellow. The old line was a bold sentence with a large ⏳ and wide margins,
// and in the chat it read as a banner under the conversation instead of a moment in
// it. The tool head is the shape the operator already reads for "something happened
// here", so this borrows it without a chevron: there is nothing behind a compact to
// open.
import { esc } from './format.js';

/** 172000 -> "172K"; a million is one decimal. */
const compactK = (n) =>
  !n ? '0' : n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);

/**
 * `running` says "Compacting", otherwise "Compacted"; `count` is its place in the
 * chat, `size` the prompt that caused it, `limit` the window. `line` is the optional
 * `data-line` attribute the transcript's arrival animation gives a row.
 */
export function compactRow({ running = false, count = 1, size = 0, limit = 0, line = '' } = {}) {
  const n = Math.max(1, Number(count) || 1);
  const action = running ? 'Compacting' : 'Compacted';
  const where = Number(size)
    ? `context at ${compactK(Number(size))}${Number(limit) ? `/${compactK(Number(limit))}` : ''}`
    : '';
  return `<div class="trace-line is-compact"${line}>` +
    `<span class="compact-dot${running ? ' is-live' : ''}" aria-hidden="true"></span>` +
    `<span class="compact-name">${esc(action)} ×${n}</span>` +
    `${where ? `<span class="compact-target">${esc(where)}</span>` : ''}` +
    `</div>`;
}
