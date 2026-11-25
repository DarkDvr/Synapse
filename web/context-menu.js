// The right-click menu: Copy, and the rest of what text deserves.
//
// Right-click was switched off on 13 Nov — correctly, for what it did: the only menu the
// page had opened the project list wherever you clicked. But that took copy with it. The
// operator could not copy a line out of the chat at all, and when the conversation was
// live the selection died a second later anyway (18 Nov). So:
//
//   * the menu is the page's own — Copy, Select All, and Cut/Paste in a field. Never the
//     browser's Print/Reload/Save As/Inspect;
//   * a file card also offers Open File and Open Folder, because a path in the chat is
//     something the operator can act on without typing it into Explorer;
//   * selected text can be sent straight back into the chat or into the question
//     panel's "Something Else" box (25 Nov);
//   * the item list is a pure function, so what it offers is testable without a browser
//     (tests/context-menu.test.mjs);
//   * nothing appears when there is nothing to act on.
//
// The selection half of the fix lives in transcript.js: a render waits while the operator
// is holding a selection (see selectionInChat), and app.js catches the chat up when it is
// released. One feature, two files, because one is about the menu and the other about the
// conversation.
import { toast } from './toast.js';
import { api } from './api.js';
import { state } from './state.js';
import { currentProject } from './run-view.js';

/**
 * What the menu offers, for a right-click at this spot.
 *
 * Pure on purpose: the interesting decisions are "is this a field?", "is anything
 * selected?" and "does this node name a file?", and all three can be answered by a
 * test with no DOM.
 */
export function menuItemsFor({
  editable = false,
  hasSelection = false,
  fieldSelection = false,
  file = '',
  canCopyIntoChat = false,
} = {}) {
  if (editable) {
    // A field keeps the browser's own vocabulary: Cut and Copy need a selection,
    // Paste does not.
    return [
      { id: 'cut', label: 'Cut', enabled: fieldSelection },
      { id: 'copy', label: 'Copy', enabled: fieldSelection },
      { id: 'paste', label: 'Paste', enabled: true },
      { id: 'select-all', label: 'Select All', enabled: true },
    ];
  }
  const items = [];
  // A file card is two actions, not a text selection's menu. They come first so a
  // right-click on a path never makes the operator hunt for them.
  if (file) {
    items.push({ id: 'open-file', label: 'Open File', enabled: true });
    items.push({ id: 'open-folder', label: 'Open Folder', enabled: true });
    // A file card with nothing selected has exactly the two actions the path
    // deserves; Select All would only compete with them.
    if (!hasSelection) return items;
  }
  if (hasSelection) items.push({ id: 'copy', label: 'Copy', enabled: true });
  // Only when there is somewhere for the text to land: the composer, or the
  // question panel's own "Something Else" field.
  if (hasSelection && canCopyIntoChat) {
    items.push({ id: 'copy-into-chat', label: 'Copy Into Chat', enabled: true });
  }
  items.push({ id: 'select-all', label: 'Select All', enabled: true });
  return items;
}

/**
 * The file a right-click is aimed at, if the node names one.
 *
 * Tool cards carry `data-file` from the call's own `filePath`/`path`; a picture chip
 * carries its project-relative `data-src`. Nothing is guessed from the visible label:
 * a target is often a command or a pattern, and opening that would be a lie.
 */
export function fileTargetAt(node) {
  const chip = node?.closest?.('.chat-image[data-src]');
  if (chip) return String(chip.dataset.src || '');
  const named = node?.closest?.('[data-file]');
  return String(named?.dataset?.file || '');
}

/** The "Something Else" row on the question panel's current page, if it has one. */
function askCustomTarget() {
  const panel = document.querySelector('.ask-panel');
  if (!panel) return null;
  const active = panel.querySelector('.ask-field:not(.ask-page-off)');
  const row = active?.querySelector('.ask-opt-other');
  const pick = row?.querySelector('[data-ask-custom]');
  const text = row?.querySelector('.ask-other-text');
  if (!row || !pick || !text) return null;
  return { row, pick, text };
}

/** Can selected text be placed into the chat as it stands? */
export function chatAcceptsText() {
  if (typeof document === 'undefined') return false;
  if (askCustomTarget()) return true;
  const input = document.getElementById('promptInput');
  return Boolean(state.sessionId) && Boolean(input) && !input.disabled && !state.compacting;
}

/** Put text into the composer: at the caret when it is focused, else at the end. */
function placeInComposer(text) {
  const input = document.getElementById('promptInput');
  if (!input || input.disabled || !state.sessionId || state.compacting) return false;
  const focused = document.activeElement === input;
  const start = focused ? input.selectionStart ?? input.value.length : input.value.length;
  const end = focused ? input.selectionEnd ?? start : input.value.length;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const glue = before && !/\s$/.test(before) ? '\n\n' : '';
  const insert = `${glue}${text}`;
  input.value = `${before}${insert}${after}`;
  // The page's own input handler grows the box; a programmatic value change does
  // not fire it by itself.
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
  const caret = before.length + insert.length;
  try { input.setSelectionRange(caret, caret); } catch { /* not a text field */ }
  return true;
}

/** Put text into the question panel's "Something Else" answer. */
function placeInAsk(text, target) {
  // Picking the row first lets the panel's own change handler enable the box; it
  // also clears the other radio in the same group.
  target.pick.checked = true;
  target.pick.dispatchEvent(new Event('change', { bubbles: true }));
  target.text.disabled = false;
  const draft = String(target.text.value || '').replace(/\s+$/, '');
  target.text.value = draft ? `${draft}\n\n${text}` : text;
  target.text.dispatchEvent(new Event('input', { bubbles: true }));
  target.text.focus();
  try { target.text.setSelectionRange(target.text.value.length, target.text.value.length); } catch { /* ignore */ }
  target.row.scrollIntoView?.({ block: 'nearest' });
}

/** Place selected text where the operator asked for it. */
export function copyIntoChat(text) {
  const value = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!value) return false;
  const ask = askCustomTarget();
  if (ask) {
    placeInAsk(value, ask);
    return true;
  }
  return placeInComposer(value);
}

/** Ask the server to open a project file, or reveal it in Explorer. */
async function openFile(relPath, reveal) {
  const project = currentProject();
  if (!project) {
    toast('No Project Open', 'Open a project chat before opening one of its files.');
    return;
  }
  try {
    const res = await api('POST', `/api/projects/${encodeURIComponent(project.id)}/open-path`, {
      path: relPath,
      select: reveal,
    });
    if (res?.missing) {
      toast('File Is Gone', `That file is no longer there; its folder is open instead.`);
    }
  } catch (err) {
    toast(reveal ? 'Could Not Open The Folder' : 'Could Not Open The File', err.message);
  }
}


let menu = null;
let wired = { onAction: null };

/** Take the menu away. Safe to call when there is none. */
export function hideContextMenu() {
  if (!menu) return;
  menu.remove();
  menu = null;
}

/**
 * Show the menu at the pointer, with the items for this spot.
 * `at` is a client point; the menu is kept inside the window.
 */
export function showContextMenu(at, items, onAction) {
  hideContextMenu();
  const panel = document.createElement('div');
  panel.className = 'ctx-menu';
  panel.setAttribute('role', 'menu');
  panel.innerHTML = items
    .map(
      (item) =>
        `<button type="button" class="ctx-item" role="menuitem" data-ctx="${item.id}"${
          item.enabled === false ? ' disabled' : ''
        }>${item.label}</button>`,
    )
    .join('');
  document.body.appendChild(panel);
  // Measure, then keep it on screen: a menu opened at the last line of the chat must
  // open upwards rather than off the bottom edge.
  const box = panel.getBoundingClientRect();
  const x = Math.max(6, Math.min(at.x, window.innerWidth - box.width - 6));
  const y = Math.max(6, Math.min(at.y, window.innerHeight - box.height - 6));
  panel.style.left = `${x}px`;
  panel.style.top = `${y}px`;
  panel.addEventListener('click', (e) => {
    const button = e.target.closest('[data-ctx]');
    if (!button || button.disabled) return;
    e.preventDefault();
    const id = button.dataset.ctx;
    hideContextMenu();
    onAction(id);
  });
  menu = panel;
}

/** The field around a right-click, if the click landed in one. */
function fieldAt(node) {
  const el = node?.closest?.('input, textarea, [contenteditable="true"]');
  return el && !el.disabled && !el.readOnly ? el : null;
}

/** The text the operator has selected inside the chat, exactly. */
function chatSelection() {
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
  return sel.toString();
}

/** The selected text of a field — the document selection does not see inside one. */
function fieldText(el) {
  if (!el || el.selectionStart === el.selectionEnd) return '';
  return String(el.value || '').slice(el.selectionStart, el.selectionEnd);
}

/** Copy, preferring the real clipboard and falling back to the old command. */
async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}

/** Select the block the menu was opened on — never the whole conversation. */
function selectBlock(node) {
  const el = node?.closest?.('.msg-body, .msg-answer, .chat-post-body, .tool-detail, .console-body, pre, .ask-panel');
  const target = el || document.getElementById('transcript');
  if (!target) return;
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(target);
  sel.addRange(range);
}

/** How the menu acts on a spot: the target node, the field (if any), the click point. */
function act(id, spot) {
  const { node, field, at } = spot;
  if (id === 'open-file' || id === 'open-folder') {
    if (spot.file) openFile(spot.file, id === 'open-folder');
    return;
  }
  if (id === 'copy') {
    const text = field ? fieldText(field) : spot.selected;
    copyText(text).then((ok) => {
      if (!ok) toast('Could Not Copy', 'Use Ctrl+C — the clipboard refused the request.');
    });
    return;
  }
  if (id === 'copy-into-chat') {
    if (!copyIntoChat(spot.selected)) {
      toast('No Chat To Paste Into', 'Open a project chat, or answer the question on screen.');
    }
    return;
  }
  if (id === 'cut' && field) {
    try {
      if (document.execCommand('cut')) return;
    } catch { /* fall through to the manual edit */ }
    const start = field.selectionStart;
    const end = field.selectionEnd;
    field.setRangeText('', start, end, 'start');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  if (id === 'paste' && field) {
    navigator.clipboard
      .readText()
      .then((text) => {
        const start = field.selectionStart ?? String(field.value || '').length;
        const end = field.selectionEnd ?? start;
        field.setRangeText(text, start, end, 'end');
        field.dispatchEvent(new Event('input', { bubbles: true }));
      })
      .catch(() => toast('Could Not Paste', 'Use Ctrl+V — the clipboard refused the request.'));
    return;
  }
  if (id === 'select-all') {
    if (field) {
      field.focus();
      field.select();
      return;
    }
    selectBlock(node);
    return at && hideContextMenu();
  }
}

/** Wire the page: right-click anywhere, a menu that fits the spot. Called once at boot. */
export function installContextMenu() {
  document.addEventListener('contextmenu', (e) => {
    const field = fieldAt(e.target);
    const selected = field ? fieldText(field) : chatSelection();
    // A click on a disabled control, a dialog backdrop or the menu itself is not a
    // place to open a text menu.
    const dead = e.target.closest?.('[disabled], .ctx-menu, .toast-region');
    if (dead) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    const file = field ? '' : fileTargetAt(e.target);
    const spot = {
      node: e.target,
      field,
      file,
      selected,
      at: { x: e.clientX, y: e.clientY },
    };
    const items = menuItemsFor({
      editable: Boolean(field),
      hasSelection: Boolean(selected.trim()),
      fieldSelection: Boolean(field && selected),
      file,
      canCopyIntoChat: Boolean(selected.trim()) && !field && chatAcceptsText(),
    });
    wired.onAction = (id) => act(id, spot);
    showContextMenu(spot.at, items, (id) => wired.onAction?.(id));
  });

  // Anywhere else is "not that menu": a left click, Escape, a scroll, a resize.
  document.addEventListener('pointerdown', (e) => {
    if (menu && !menu.contains(e.target)) hideContextMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    hideContextMenu();
  });
  window.addEventListener('wheel', hideContextMenu, { passive: true });
  window.addEventListener('resize', hideContextMenu);
  document.addEventListener('scroll', hideContextMenu, true);
}
