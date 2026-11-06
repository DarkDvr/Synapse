// The rail's two panels: Tools in Use, and the tool probe's results.
//
// Neither is a dialog in the modal sense — they are rail panels that slide over the
// rail, so the chat keeps its place while the operator reads what the tools have been
// doing. The probe table is the engine's own answer to "does this model have a tool?",
// run one turn per tool, and it is the only place that answer is written down.
//
// Nothing comes from app.js: these read state and draw.
import { state } from './state.js';
import { esc } from './format.js';
import { $ } from './dom.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { renderTranscript } from './transcript.js';

export function closeRailModal(id) {
  const el = $(id);
  if (el) el.hidden = true;
}

export async function renderToolUsage() {
  const note = $('toolUsageNote');
  const table = $('toolUsage');
  const meta = $('toolUsageMeta');
  if (!note || !table) return;
  let stats = null;
  try {
    stats = await api('GET', '/api/tools/stats');
  } catch { /* engine down */ }

  if (!stats || !stats.total) {
    note.hidden = false;
    note.textContent = `No tool calls yet. The census is cleared when a new chat starts.`;
    table.hidden = true;
    if (meta) meta.textContent = '';
    return;
  }
  note.hidden = true;
  table.hidden = false;
  table.querySelector('tbody').innerHTML = stats.tools
    .slice(0, 8)
    .map(
      (t) => `<tr>
        <td class="tool-name" title="${esc(t.key)}">${esc(t.key)}</td>
        <td class="tool-time">${t.calls}</td>
        <td class="tool-time${t.failed ? ' slow' : ''}">${t.failed || ''}</td>
        <td class="tool-time${t.avgMs > 1000 ? ' slow' : ''}">${t.avgMs ? fmtMs(t.avgMs) : ''}</td>
      </tr>`,
    )
    .join('');
  if (meta) {
    meta.textContent = `${stats.total} calls · ${stats.failed} failed (${Math.round(stats.failRate * 100)}%)`;
  }
}

function fmtMs(ms) {
  if (ms == null) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The probe's per-case results. A case is "clean" when the turn closed, the
 * tool we asked for actually ran, and none of its calls failed — anything else
 * is worth looking at, so it gets a coloured dot and, when there is a message,
 * the standard red Error button.
 */
export async function renderProbe() {
  const note = $('probeNote');
  const table = $('probeTable');
  const meta = $('probeMeta');
  const btn = $('runProbe');
  if (!note || !table) return;

  let st = null;
  try {
    st = await api('GET', '/api/tools/probe');
  } catch {
    return;
  }

  if (btn) {
    btn.disabled = Boolean(st.running);
    btn.textContent = st.running ? 'Probe Running…' : 'Run Tool Probe';
  }

  const results = st.results || [];
  if (!results.length) {
    note.hidden = false;
    note.textContent = st.running
      ? st.current === 'toolset'
        ? 'Asking the model which tools it has…'
        : `Running case "${st.current || '…'}"…`
      : 'Runs every tool once and records what happened, and how long it took.';
    table.hidden = true;
    if (meta) meta.textContent = '';
    return;
  }

  note.hidden = true;
  table.hidden = false;
  table.querySelector('tbody').innerHTML = results
    .map((r) => {
      // One word per case, and one meaning. A case that exists to exercise a
      // failure path reports `failed as asked` and shows no Error button: before,
      // it read `clean` and carried an Error chip at the same time, which is a
      // contradiction on one row.
      const label = r.ok
        ? r.expectFail
          ? 'failed as asked'
          : 'clean'
        : r.offered === false
          ? 'not offered'
          : r.timedOut
            ? 'timeout'
            : r.missing
              ? 'not called'
              : 'failed';
      const detail = r.expectFail
        ? ''
        : r.errors?.length
          ? r.errors.map((e) => `${e.tool}${e.exitCode != null ? ` (exit ${e.exitCode})` : ''}: ${e.detail}`).join('\n\n')
          : r.error || '';
      const errBtn = detail
        ? `<button class="err-btn" data-error-title="${esc(r.id)}" data-error="${esc(detail)}">Error</button>`
        : '';
      // The time shown is the tool's own execution. The turn took far longer,
      // but almost all of that is the model thinking — showing the turn time
      // here would make every tool look slow.
      const turn = r.ms ? `turn ${fmtMs(r.ms)}` : '';
      const tool = (r.used || []).join(', ') || r.expect || '—';
      const pill = `<span class="state-pill probe-state ${r.ok ? 'ok' : r.offered === false || r.timedOut ? 'warn' : 'err'}">${esc(label)}</span>`;
      return `<tr>
        <td class="tool-name" title="${esc(r.id)} · ran ${esc(tool)} · ${esc(label)}${turn ? ` · ${esc(turn)}` : ''}">${esc(r.id)}</td>
        <td class="tool-time${r.toolMs > 1000 ? ' slow' : ''}" title="tool ${fmtMs(r.toolMs)}${turn ? ` · ${turn}` : ''}">${r.toolMs ? fmtMs(r.toolMs) : ''}</td>
        <td class="probe-status">${pill}</td>
        <td class="probe-err">${errBtn}</td>
      </tr>`;
    })
    .join('');

  if (meta) {
    const passed = results.filter((r) => r.ok).length;
    meta.textContent = st.running
      ? `${results.length}/${st.cases?.length || results.length} done · running "${st.current || '…'}"`
      : `${passed}/${results.length} clean · tool times, not model times · ${relTime(st.finishedAt)}`;
  }
}

async function replyPermission(requestId, decision, reasonText = '') {  // The card can belong to a hidden worker session, not the open one. Answering
  // it on the open session would fail with a request id the engine never saw.
  const permission = (state.permissions || []).find((p) => p.requestId === requestId);
  const sessionId = permission?.sessionId || state.sessionId;
  // A refusal may carry the operator's own sentence, typed in the dialog that
  // "Reject With Reason" opens. Only a refusal sends one — an allow has nothing to
  // explain.
  const reason =
    decision === 'reject'
      ? String(reasonText || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300)
      : '';
  state.permissions = state.permissions.filter((p) => p.requestId !== requestId);
  renderTranscript();
  try {
    await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/permission`, {
      requestId,
      decision,
      ...(reason ? { reason } : {}),
    });
  } catch (err) {
    toast('Could not answer the request', err.message);
  }
}
