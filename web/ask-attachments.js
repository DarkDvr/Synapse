// The question panel's own attachments.
//
// A question is answered in the panel, and some answers need a file: a screenshot
// of the error, a log, the sketch the question is about. The panel used to be
// text-only, so the operator had to answer, wait for the turn to carry on, and
// send the file as a second message. This is the same strip the composer uses,
// with the same limits and the same Keep choice.
//
// The engine's form reply takes an answer and nothing else, so the files travel
// with a short steer sent after the answer settles (see ask-panel.js). They reach
// the model on its next step, and a kept copy stays in `.project/attachments/`.
import { esc, fmtBytes, shortName } from './format.js';
import { ATTACH_TOTAL_BYTES, addFilesToList, filesFromClipboard, hasDragFiles } from './composer.js';

let list = [];
let owner = '';

/** The files waiting on the open question. */
export function askAttachmentList() {
  return list;
}

/** A new form starts with an empty strip; polling the same form does not. */
export function resetAskAttachments(formId) {
  const id = String(formId || '');
  if (id === owner) return false;
  owner = id;
  list = [];
  return true;
}

/** The answer was taken (or the question went away): nothing waits here any more. */
export function clearAskAttachments() {
  list = [];
  renderAskAttachments();
}

/** Add files to the question's strip, under the composer's rules. */
export async function addAskFiles(files) {
  const added = await addFilesToList(list, files);
  if (added) renderAskAttachments();
  return added;
}

/** Draw the strip inside the open panel. Safe when the panel is not built yet. */
export function renderAskAttachments() {
  const strip = document.getElementById('askAttachStrip');
  if (!strip) return;
  strip.hidden = list.length === 0;
  const chips = list
    .map(
      (f) => `<span class="attach-chip" data-ask-attach="${esc(f.id)}">
        <span class="attach-name" title="${esc(f.name)}">${esc(shortName(f.name))}</span>
        <button type="button" class="attach-x" data-ask-detach="${esc(f.id)}" title="Remove ${esc(f.name)}" aria-label="Remove ${esc(f.name)}">✕</button>
      </span>`,
    )
    .join('');
  const total = list.reduce((n, f) => n + (Number(f.size) || 0), 0);
  strip.innerHTML =
    `${chips}<span class="attach-total">${list.length} file${list.length === 1 ? '' : 's'} · ` +
    `${fmtBytes(total)} of ${fmtBytes(ATTACH_TOTAL_BYTES)}</span>`;
}

/**
 * Wire the persistent ask host once. The panel is rebuilt on a new question, but
 * the host is not, so these delegated listeners outlive every rebuild.
 */
export function installAskAttachments(host) {
  if (!host) return;

  const panelOf = (e) => e.target.closest?.('.ask-panel') || null;
  const setDrop = (panel, on) => {
    if (!panel) return;
    panel.classList.toggle('is-drop-target', on);
    const hint = panel.querySelector('.ask-drop');
    if (hint) hint.hidden = !on;
  };

  host.addEventListener('click', (e) => {
    if (e.target.closest('#askAttachBtn')) {
      document.getElementById('askAttachInput')?.click();
      return;
    }
    const remove = e.target.closest('[data-ask-detach]');
    if (!remove) return;
    list = list.filter((f) => f.id !== remove.dataset.askDetach);
    renderAskAttachments();
  });

  host.addEventListener('change', (e) => {
    const input = e.target.closest('#askAttachInput');
    if (!input) return;
    const picked = [...(input.files || [])];
    input.value = '';
    addAskFiles(picked);
  });

  // Paste is the same door: a copied screenshot becomes an attachment instead of
  // a filename in a text field. Plain text still goes where the caret is.
  host.addEventListener('paste', (e) => {
    const panel = panelOf(e);
    if (!panel) return;
    const files = filesFromClipboard(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    addAskFiles(files);
  });

  // The whole panel takes a file, not just the attach button: the operator is
  // looking at the question when they drag, and a 18px target is not where they aim.
  host.addEventListener('dragenter', (e) => {
    const panel = panelOf(e);
    if (!panel || !hasDragFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDrop(panel, true);
  });

  host.addEventListener('dragover', (e) => {
    const panel = panelOf(e);
    if (!panel || !hasDragFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  host.addEventListener('dragleave', (e) => {
    const panel = panelOf(e);
    if (!panel || !hasDragFiles(e)) return;
    // Moving over the question's own fields is still inside the panel.
    if (e.relatedTarget && panel.contains(e.relatedTarget)) return;
    setDrop(panel, false);
  });

  host.addEventListener('drop', (e) => {
    const panel = panelOf(e);
    if (!panel || !hasDragFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDrop(panel, false);
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) addAskFiles(files);
  });
}
