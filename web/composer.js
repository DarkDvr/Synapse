// The dock: what the operator writes, what they attach, and the three buttons that
// act on a turn — Send (or Steer while it is working), Stop, and the run menu.
//
// It is the one part of the page the operator touches every minute, so its rules are
// about what must not happen: a message that failed is a red line in the chat and not
// a toast, Stop is gentle first, and a steer is never silently dropped.
//
// Four things come from app.js and are wired at boot: reload the messages, refresh the
// cards that are waiting, redraw the compact chip and the project rail.
import { state } from './state.js';
import { esc, fmtBytes, shortName } from './format.js';
import { $ } from './dom.js';
import { namePasted } from './attach-names.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { addChatError } from './chat-notes.js';
import { chatScroller, animateScroll } from './chat-scroll.js';
import { currentProject, currentRun, roleLabel, currentForm, selectionFor, modelByRef, permissionsHere, inChat } from './run-view.js';
import { renderTranscript, attachmentImage } from './transcript.js';
import { traceOf, steerLine } from './traces.js';
import { clearModeNote } from './mode-note.js';

const missing = (name) => () => {
  throw new Error(`composer.js: ${name} was not wired at boot`);
};
const wired = {
  loadMessages: missing('loadMessages'),
  refreshPending: missing('refreshPending'),
  renderCompactChip: missing('renderCompactChip'),
  renderTree: missing('renderTree'),
};

/** Hand this module the four things that live in app.js. Called once, at boot. */
export function composerWiring(fns) {
  Object.assign(wired, fns);
}

// ── composer ────────────────────────────────────────────────────
/**
 * Where a message would go while the project is busy.
 *
 * A steer is not a second conversation: it joins the turn already running and is
 * read at the next step. Only the computer that started the work may send one —
 * the server records the driver and enforces the same rule, so this is the
 * honest face of it rather than the guard.
 */
function steerTarget() {
  if (state.compacting) return null;
  const busy = state.busyInfo;
  const live = currentRun();
  if (!live && !busy?.busy) return null;
  // A card is not something to steer; answer it first.
  if (busy?.state === 'waiting') return null;
  if (live?.retry) return null;
  // The run itself is the target. `workerId` need not have reached this page:
  // the server holds it, and `runs.steer` refuses only while the worker is
  // starting.
  if (live?.role) return { kind: 'worker', role: live.role, task: live.task };
  if (busy?.kind === 'run' && busy.role) return { kind: 'worker', role: busy.role };
  if (busy?.kind === 'turn') return { kind: 'architect' };
  return null;
}

/**
 * The composer. While a question is waiting the session genuinely cannot read a
 * message — the engine's turn is blocked on the answer — so the box says so
 * rather than letting a message be typed into nothing.
 */
export function renderComposer() {
  const hasSession = Boolean(state.sessionId);
  const asking = Boolean(currentForm());
  // A permission card blocks the composer exactly as a question does: the turn
  // cannot read a message while it waits on the operator, and a half-dead composer
  // invites a click that goes nowhere (3 Nov). Only this chat's cards do: another
  // project waiting is not this chat's block, and freezing this composer for it
  // was the bug (20 Nov).
  const awaitingPermission = permissionsHere().length > 0;
  const blocked = asking || awaitingPermission;
  const held = Boolean(state.busyInfo?.busy) || Boolean(currentRun());
  // A message waiting for a busy local server is not "working" and not blocked: this
  // chat's turn has not started. Stop is its way out (21 Nov).
  const queued = Boolean(state.lease?.waiting);
  // The stop's own life is the server's: it clears when the project is quiet (or
  // when the operator speaks), not when this page guesses from the run cards. The
  // old guess is what made the notice vanish while the engine kept retrying.
  const target = steerTarget();
  // Any question in this chat blocks this composer, whoever asked it: the
  // operator's attention is the thing the run is waiting on, and a worker's question
  // in the same project is no different from the Architect's in that respect. A
  // question in another project is that project's, and does not reach this box.
  //
  // No sentence explains it. One used to sit above the controls ("fever-tracker is
  // working — started from 192.0.2.115"), and the operator asked for it to go:
  // it took a line off the chat to say what the rail's dot and the role cards
  // already say. A dead Send with no explanation was accepted in exchange.
  const sendBtn = $('sendBtn');
  sendBtn.disabled = (state.busy && !hasSession) || blocked || state.compacting || (held && !target);
  // The same click, a different promise: while work is running the button says
  // Steer and wears the live path's yellow border. Anyone may press it.
  sendBtn.textContent = target ? 'Steer' : 'Send';
  sendBtn.classList.toggle('is-steer', Boolean(target));
  // Stop has to work while a worker is running or waiting out a retry, when the
  // open session is idle — that is exactly when it is the only way out. `canStop`
  // is the engine's answer for this project, so a hidden worker enables it even
  // when no run record is left.
  $('stopBtn').disabled = !hasSession || !(state.busy || currentRun() || state.canStop || state.compacting || Boolean(state.lease?.waiting));
  const input = $('promptInput');
  if (input) {
    input.disabled = blocked;
    input.placeholder = asking
      ? 'Answer the question to continue'
      : awaitingPermission
        ? 'Resolve the permission to continue'
        : target?.kind === 'worker'
          ? `Message ${roleLabel(target.role)} — seen at its next step`
          : target?.kind === 'architect'
            ? 'Message the Architect — seen mid-turn'
            : held && currentRun()?.retry
              ? 'Waiting on the provider — Stop or wait'
              : held
                ? 'Working — Stop to take over'
                : queued
                  ? 'Waiting for the local server — Stop to cancel'
                  : 'CTRL+Enter to send';
  }
  // A pending question takes the whole composer, not just the text box: Attach, the
  // mode switch and the run menu are all "start something else", and a half-dead
  // composer invites a click that goes nowhere. Stop stays live — it is the way out
  // of a question nobody can answer, and the engine treats it as the immediate stop.
  for (const id of ['attachBtn', 'modeToggle', 'runBtn']) {
    const el = $(id);
    if (el) el.disabled = blocked;
  }
  // A drop target is only honest while the box can take a file. A question or a
  // permission card closes the composer, so it also closes the chat's drop target.
  if (!composerAcceptsFiles()) hideDropHint();
  renderStopState();
  wired.renderCompactChip();
}

export async function send() {
  const input = $('promptInput');
  const text = input.value.trim();
  const files = state.attachments.slice();
  if (!text && !files.length) return;

  // A role without a model cannot run a turn: the engine would refuse the prompt, or
  // a worker would be briefed and never start. Say it before the message leaves the
  // box, and keep the draft — the operator has to choose a model, not retype.
  const pick = selectionFor('architect');
  if (pick?.ref && !modelByRef(pick.ref)) {
    toast('No Model for the Architect', `${pick.ref} is no longer offered. Choose a model on the card above.`);
    return;
  }

  // One project, one conversation. The server refuses too; this keeps the draft
  // in the box instead of losing it to a round trip. The exception is the
  // operator who started the work: a message sent while it runs is guidance for
  // the turn, not a second conversation.
  const busy = state.busyInfo;
  const target = steerTarget();
  if (busy?.busy && target) return sendSteer(text, files, target);
  if (busy?.busy) {
    const who = busy.driver?.name ? ` (started from ${busy.driver.name})` : '';
    toast(
      'Project Busy',
      busy.state === 'waiting'
        ? `${busy.project} is waiting for an answer${who}. Answer the card or stop it first.`
        : `${busy.project} is busy${who}. Answer its question or stop it before sending.`,
    );
    return;
  }

  if (!state.sessionId) {
    toast('No project open', 'Pick a project on the left.');
    return;
  }

  // The persona note was about the switch; the next message is the conversation
  // moving on. It belongs above this message, not after it.
  clearModeNote();
  input.value = '';
  autoGrow(input);
  // No optimistic "busy" mark here. It used to colour the rail on the same click, but
  // it is a claim the engine has not made: the next poll replaces the busy list, the
  // chat drops from "working" to "idle", and the watcher played the finished-work
  // chime for a message that was still waiting to be sent — or was refused (20 Nov).
  // The engine's own `execution.started` is what marks the chat working.
  try {
    await ensureSession();
    state.streaming = true;
    state.busy = true;
    renderComposer();
    state.messages.push({
      id: 'local-' + Date.now(),
      type: 'user',
      text,
      created: Date.now(),
      files: files.map((f) => ({ name: f.name, mime: f.mime })),
      // Until the reload brings the engine's own message back, Reuse needs the
      // bytes too; the raw shape would carry them, so keep the same here.
      _files: files.map((f) => ({ name: f.name, mime: f.mime, data: f.data })),
    });
    renderTranscript();
    // Sending is a statement of intent to read the answer: put the newest message
    // in view, and again after the turn's messages land.
    scrollChatToEnd();
    const sent = await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/messages`, {
      text,
      // The mode is this message's, applied by the server before the prompt, so
      // clicking the toggle and then sending is one decision rather than two
      // requests that can disagree.
      mode: state.mode,
      // The bytes go with the message, in the engine's own shape, so the file is
      // the operator's message rather than something the harness put on disk.
      files: files.map((f) => ({ name: f.name, mime: f.mime, data: f.data, keep: f.keep === true })),
    });
    if (sent?.queued) {
      // It is in the local server's queue, not in the engine yet. The chat says so in
      // Synapse's own post (drawn from the server's answer); the operator's echo goes,
      // because a post that looks sent but is not in the transcript is the one the next
      // load erased (20 Nov).
      state.messages = (state.messages || []).filter(
        (m) => !(String(m.id).startsWith('local-') && m.type === 'user' && m.text === text),
      );
      renderTranscript();
      toast(
        'Waiting For The Local Server',
        'Another project has it. Your message starts when that turn ends — the chat says so while it waits.',
        7000,
      );
    }
    if (sent?.kept?.length) {
      toast(
        'Kept In The Project',
        `${sent.kept.length === 1 ? 'The file is' : 'The files are'} in .project/attachments/ — it survives compaction and workers can read it.`,
      );
    }
    // The server has accepted it, so the project is busy now: read that state at
    // once and hold Send and the mode switch, rather than waiting for the poll.
    wired.refreshPending();
    // Only after the server has taken them: a failed send must not eat the files.
    state.attachments = [];
    renderAttachments();
    await wired.loadMessages();
    scrollChatToEnd();
  } catch (err) {
    // A refused send is not a lost message: the server said the project is busy (or
    // a local server is taking one turn at a time), so the words go back in the box
    // exactly as they were. Any 409 keeps them — the sentence says why.
    if (err.status === 409) {
      input.value = text;
      state.attachments = files;
      renderAttachments();
      autoGrow(input);
      if (err.body?.busy) state.busyInfo = err.body.busy;
    }
    // The send failed, so the work the rail was told about is not happening.
    state.busySessions.delete(state.sessionId);
    // The local echo is not a message: the engine never got it, and switching chats
    // reloads it away while "Message not sent" stays. It goes with the failure that
    // explains it, and the words are back in the composer (20 Nov).
    state.messages = (state.messages || []).filter(
      (m) => !(String(m.id).startsWith('local-') && m.type === 'user' && m.text === text),
    );
    wired.renderTree();
    // In the conversation, in red, and kept: a toast is gone in four seconds and
    // this is the message they just lost.
    addChatError({ title: 'Message not sent', detail: err.message });
    // A failed send re-renders so the line is where the message would have been.
    state.streaming = false;
    renderTranscript();
    toast('Send failed', err.message);
  } finally {
    state.streaming = false;
    renderComposer();
  }
}

/**
 * Send the operator's guidance into the work that is already happening.
 *
 * A worker steer is invisible in the Architect's transcript — the worker has its
 * own session — so the run trace carries the line (see `run.steer`). An Architect
 * steer is a real user message in the conversation it is working in, and comes
 * back through `loadMessages` with the `[steer]` marker stripped by the renderer.
 */
async function sendSteer(text, files, target) {
  const input = $('promptInput');
  clearModeNote();
  // The line is painted the moment the operator presses Steer, before the request.
  // The engine's steer prompt does not come back until the model reaches its next
  // step, so waiting for the answer left the chat unchanged for minutes — and with
  // only an attachment there was no sentence to notice missing, which is why it
  // read as a lost steer rather than a late one. `pending` is the breath; it ends
  // when the server says the model has taken the turn.
  let painted = null;
  let post = null;
  const chips = (files || []).map((f) => ({ name: f.name, mime: f.mime }));
  if (target?.kind === 'worker') {
    const trace = traceOf(currentRun());
    if (trace) {
      painted = {
        at: Date.now(),
        steer: true,
        text: steerLine(text),
        pending: true,
        files: chips,
      };
      trace.notes.push(painted);
      if (trace.notes.length > 60) trace.notes.splice(0, trace.notes.length - 60);
    }
  } else {
    // The engine only writes the operator's words into the transcript when it
    // delivers them, so the page paints the sentence now and keeps it until the
    // real message arrives (see loadMessages). No trailing space on a file-only
    // steer: that is the form the engine echoes back.
    post = {
      id: `local-steer-${Date.now()}`,
      type: 'user',
      text: text ? `[steer] ${text}` : '[steer]',
      created: Date.now(),
      pending: true,
      // The picture is part of the sentence here too: the chip is drawn from the
      // same files the send carried, so a steer reads exactly like a message.
      files: chips,
      _files: files.map((f) => ({ name: f.name, mime: f.mime, data: f.data })),
    };
    state.messages.push(post);
  }
  renderTranscript();
  scrollChatToEnd();

  // The line is on screen, so the box can let go of the draft. If the server
  // refuses it, the draft comes back rather than being eaten by a failed steer.
  const draft = { text, files };
  input.value = '';
  autoGrow(input);
  state.attachments = [];
  renderAttachments();
  try {
    const sent = await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/steer`, {
      text,
      files: files.map((f) => ({ name: f.name, mime: f.mime, data: f.data, keep: f.keep === true })),
    });
    if (painted) {
      // The runner's saved copies replace the name-only chips, so the hover works
      // as it does anywhere. The line stays pending until the worker reports that
      // the model reached it (run.steer delivered).
      if (Array.isArray(sent?.files) && sent.files.length) painted.files = sent.files;
      renderTranscript();
    }
    // An Architect steer stays pending here even after the request returns. The
    // request is an acknowledgement, not proof of the read: the engine's own
    // `[steer]` message is that proof, and loadMessages moves the line when it
    // sees it. (26 Nov: the request came back while the previous tool was still
    // streaming, so opening the next post here moved the steer too early.)
    toast(
      'Steer Sent',
      sent?.target === 'worker'
        ? `${roleLabel(sent.role)} will see it at its next step.`
        : 'The Architect will see it mid-turn.',
    );
    if (sent?.target !== 'worker') {
      await wired.loadMessages();
      scrollChatToEnd();
    }
  } catch (err) {
    // The line was a promise, and the promise was refused: take it back off rather
    // than leave a sentence that no worker ever read.
    if (painted) {
      const trace = traceOf(currentRun());
      const at = trace ? trace.notes.indexOf(painted) : -1;
      if (at >= 0) trace.notes.splice(at, 1);
    }
    if (post) {
      state.messages = (state.messages || []).filter((m) => m !== post);
    }
    renderTranscript();
    // Only restore if they have not typed or attached something new meanwhile.
    if (!input.value.trim() && !state.attachments.length) {
      input.value = draft.text;
      state.attachments = draft.files;
      renderAttachments();
      autoGrow(input);
    }
    if (err.status === 409 && err.body?.notBusy) {
      toast('Nothing Is Running', 'Press Send again to send it as a message.');
      return;
    }
    toast('Steer Not Sent', err.message || 'The message did not reach the work.');
  } finally {
    renderComposer();
  }
}



/**
 * The attachments of a sent message, in the composer's own shape.
 *
 * The engine keeps the bytes on the operator's message (`raw.files[].data`), not
 * just the name the transcript shows. A message echoed locally before the
 * reload has them on `_files`. A file that somehow has no bytes is skipped
 * rather than attached empty — an empty attachment would be worse than none.
 */
function messageAttachments(message) {
  const raw = Array.isArray(message?.raw?.files) ? message.raw.files : [];
  const local = Array.isArray(message?._files) ? message._files : [];
  const files = raw.length ? raw : local;
  const out = [];
  for (const [index, file] of files.entries()) {
    let data = String(file?.data || '');
    let mime = String(file?.mime || 'application/octet-stream');
    // A `data:` URI is the other shape the engine may carry.
    if (!data && typeof file?.uri === 'string' && file.uri.startsWith('data:')) {
      const comma = file.uri.indexOf(',');
      if (comma >= 0) {
        mime = file.uri.slice(5, comma).split(';')[0] || mime;
        data = file.uri.slice(comma + 1);
      }
    }
    if (!data) continue;
    out.push({
      id: `reuse-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`,
      name: String(file?.name || `attachment-${index + 1}`),
      mime,
      size: Math.floor((data.length * 3) / 4),
      data,
      keep: false,
    });
  }
  return out;
}

/**
 * Put a sent message back in the composer.
 *
 * The text replaces an empty box and is appended to a draft, so clicking Reuse
 * cannot silently throw away something the operator was already writing. The
 * attachments follow the same rule and stop at the message's total-size budget.
 */
export function reuseMessage(messageId) {
  const message = state.messages.find((m) => m.id === messageId && m.type === 'user');
  if (!message) return;
  const input = $('promptInput');
  if (!input) return;

  const text = String(message.text || '');
  const files = messageAttachments(message);
  const draft = input.value;
  if (!draft.trim()) input.value = text;
  else if (!draft.endsWith(text)) input.value = `${draft.replace(/\s+$/, '')}\n\n${text}`;
  autoGrow(input);

  const room = Math.max(0, ATTACH_MAX_COUNT - state.attachments.length);
  const taken = new Set(state.attachments.map((f) => `${f.name}\u0000${f.size}`));
  let used = attachmentBytes();
  const accepted = [];
  for (const file of files) {
    if (accepted.length >= room) break;
    if (taken.has(`${file.name}\u0000${file.size}`)) continue;
    if (file.size > ATTACH_MAX_BYTES) continue;
    if (used + file.size > ATTACH_TOTAL_BYTES) break;
    accepted.push(file);
    used += file.size;
  }
  if (accepted.length) state.attachments = [...state.attachments, ...accepted];
  renderAttachments();

  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  const missing = Math.max(0, files.length - accepted.length);
  const what = accepted.length
    ? ` and ${accepted.length} attachment${accepted.length === 1 ? '' : 's'}`
    : '';
  toast(
    'Copied To Composer',
    missing
      ? `The message is ready to send again${what}; ${missing} file${missing === 1 ? '' : 's'} could not be restored.`
      : `The message${what} ${accepted.length ? 'are' : 'is'} ready to send again.`,
  );
}


/** Read a picked file into the shape the message needs. */function readFileAsAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`could not read ${file.name}`));
    reader.onload = () => {
      const url = String(reader.result || '');
      const comma = url.indexOf(',');
      resolve({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        data: comma >= 0 ? url.slice(comma + 1) : '',
      });
    };
    reader.readAsDataURL(file);
  });
}

// One message may carry up to 48 MB in total (8 MB per file); the 24-file count
// is only a sanity cap so the strip cannot become a wall. Pasted data follows the
// same rules. A paste longer than ten lines (or 1,200 characters) becomes a text
// file instead of a wall in the box — the operator's DeepSeek-style cutoff.
const ATTACH_MAX_BYTES = 8 * 1024 * 1024;
export const ATTACH_TOTAL_BYTES = 48 * 1024 * 1024;
const ATTACH_MAX_COUNT = 24;
const PASTE_TEXT_MAX_LINES = 10;
const PASTE_TEXT_MAX_CHARS = 1200;

/** What the waiting attachments already weigh, in bytes. */
function attachmentBytes(list = state.attachments) {
  return (list || []).reduce((total, file) => total + (Number(file?.size) || 0), 0);
}

/** Is this paste better as a file than as text in the box? */
function pasteIsLarge(text) {
  if (!text) return false;
  const lines = text.split(/\r\n|\r|\n/).length;
  return lines > PASTE_TEXT_MAX_LINES || text.length > PASTE_TEXT_MAX_CHARS;
}

/** The in-memory text file a large paste becomes. No disk, so nothing to clean. */
function pastedTextFile(text) {
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '-');
  const taken = new Set((state.attachments || []).map((a) => a.name));
  let name = `pasted-text-${stamp}.txt`;
  let n = 2;
  while (taken.has(name)) name = `pasted-text-${stamp}-${n++}.txt`;
  return new File([text], name, { type: 'text/plain' });
}

/** Add files to the composer, with the size and count rules the picker uses. */
export async function addAttachmentFiles(files) {
  const added = await addFilesToList(state.attachments, files);
  if (added) {
    namePasted(state.attachments);
    renderAttachments();
  }
  return added;
}

/**
 * The same rules for any attachment strip: the composer's, and the question
 * panel's. A file that is too large, too many, or past the total budget is
 * refused with a toast; the rest still go. Never throws.
 */
export async function addFilesToList(target, files) {
  const list = target || [];
  let added = 0;
  let used = attachmentBytes(list);
  for (const file of files || []) {
    if (!file) continue;
    if (file.size > ATTACH_MAX_BYTES) {
      toast('File Too Large', `${file.name || 'That file'} is ${fmtBytes(file.size)}; the limit is 8 MB per file.`);
      continue;
    }
    if (list.length >= ATTACH_MAX_COUNT) {
      toast(
        'Too Many Files',
        `${ATTACH_MAX_COUNT} attachments is the limit for one message. The total size is the real limit; this is only the count cap.`,
      );
      break;
    }
    if (used + file.size > ATTACH_TOTAL_BYTES) {
      toast(
        'Attachments Too Large',
        `One message can carry ${fmtBytes(ATTACH_TOTAL_BYTES)} in total. This file would take it to ${fmtBytes(used + file.size)}; remove one or send it separately.`,
      );
      break;
    }
    try {
      const attachment = await readFileAsAttachment(file);
      list.push(attachment);
      used += attachment.size;
      added += 1;
    } catch (err) {
      toast('Could Not Read That File', err.message);
    }
  }
  return added;
}

/** The files in a clipboard event, whichever way the browser spells them. */
export function filesFromClipboard(dt) {
  if (!dt) return [];
  const files = [...(dt.files || [])];
  if (files.length) return files;
  for (const item of [...(dt.items || [])]) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile?.();
    if (file) files.push(file);
  }
  return files;
}

/** Can this chat take a dropped file right now? The composer is the same door. */
export function composerAcceptsFiles() {
  const input = $('promptInput');
  return Boolean(state.sessionId) && Boolean(input) && !input.disabled && !state.compacting;
}

/** Show or hide the chat's drop target. */
function showDropHint(on) {
  const dock = $('chatDock');
  const hint = $('chatDrop');
  if (dock) dock.classList.toggle('is-drop-target', on);
  if (hint) hint.hidden = !on;
}

function hideDropHint() {
  showDropHint(false);
}

/** Does this drag carry files from the operating system? */
export function hasDragFiles(e) {
  return [...(e.dataTransfer?.types || [])].includes('Files');
}

/**
 * The whole chat is a drop target for files.
 *
 * A file dragged from Explorer is the same thing as a file picked with the paperclip
 * or pasted into the box: it is read into memory and travels with the next message.
 * The target is the dock, not the textarea, because the operator is looking at the
 * conversation when they drag — requiring them to hit a one-line box first is the
 * kind of aim the rest of the page does not ask for.
 *
 * It is only live while the composer is: a question or a permission card blocks the
 * same door a paste would go through, and a drop target that accepts a file the
 * chat cannot send would be a lie.
 */
export function installChatDrop() {
  const dock = $('chatDock');
  if (!dock) return;

  dock.addEventListener('dragenter', (e) => {
    if (!hasDragFiles(e)) return;
    e.preventDefault();
    if (composerAcceptsFiles()) showDropHint(true);
  });

  dock.addEventListener('dragover', (e) => {
    if (!hasDragFiles(e)) return;
    // Without this the WebView2 navigates to the dropped file and the app is gone.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = composerAcceptsFiles() ? 'copy' : 'none';
  });

  dock.addEventListener('dragleave', (e) => {
    if (!hasDragFiles(e)) return;
    // Crossing from the transcript to the composer is not leaving the chat.
    if (e.relatedTarget && dock.contains(e.relatedTarget)) return;
    hideDropHint();
  });

  dock.addEventListener('drop', async (e) => {
    if (!hasDragFiles(e)) return;
    e.preventDefault();
    hideDropHint();
    if (!composerAcceptsFiles()) {
      toast(
        'Chat Is Not Taking Files',
        state.sessionId
          ? 'Answer the question or permission on screen first.'
          : 'Open a project chat first.',
      );
      return;
    }
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    const added = await addAttachmentFiles(files);
    if (!added) return;
    $('promptInput')?.focus();
    toast('Files Attached', `${added} file${added === 1 ? '' : 's'} ready to send.`);
  });

  // Leaving the window without dropping, and a cancelled drag, both put the target
  // away; otherwise it would stay lit over a chat that is no longer being dragged to.
  window.addEventListener('dragend', hideDropHint);
  window.addEventListener('blur', hideDropHint);
  // A drop outside the chat is still a file the WebView would navigate to. The
  // page swallows it rather than replacing the app with a picture.
  document.addEventListener('dragover', (e) => {
    if (hasDragFiles(e)) e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    if (hasDragFiles(e) && !e.target.closest?.('#chatDock')) e.preventDefault();
  });
}

/**
 * Paste anything into the composer.
 *
 * Files and images become attachments; long text becomes a .txt attachment; short
 * text is left to the browser at the caret. Everything is read into memory and
 * travels as base64 with the message — no temp file is written, so there is
 * nothing left to clean up.
 */
export async function onComposerPaste(e) {
  const dt = e.clipboardData;
  if (!dt) return;

  const files = filesFromClipboard(dt);
  if (files.length) {
    e.preventDefault();
    await addAttachmentFiles(files);
    return;
  }

  const text = dt.getData('text/plain');
  if (text && pasteIsLarge(text)) {
    if (state.attachments.length >= ATTACH_MAX_COUNT) {
      // Do not swallow the paste when full: losing the operator's text would be
      // worse than a long box. The toast says why it stayed text.
      toast('Too Many Files', `${ATTACH_MAX_COUNT} attachments is the limit; the text was pasted instead.`);
      return;
    }
    e.preventDefault();
    const size = new Blob([text]).size;
    if (size > ATTACH_MAX_BYTES) {
      toast('Paste Too Large', `That text is ${fmtBytes(size)}; the limit is 8 MB per file.`);
      return;
    }
    if (attachmentBytes() + size > ATTACH_TOTAL_BYTES) {
      toast(
        'Attachments Too Large',
        `One message can carry ${fmtBytes(ATTACH_TOTAL_BYTES)} in total; the text was pasted instead.`,
      );
      return;
    }
    await addAttachmentFiles([pastedTextFile(text)]);
    toast('Text Attached', 'Long text was attached as a file instead of pasted into the box.');
    return;
  }

  // Some apps copy an image as HTML with the bytes in a data: URI and no File.
  if (text) return;
  const html = dt.getData('text/html');
  const match = /<img[^>]+src=["'](data:image\/[a-z0-9.+-]+;base64,[^"']+)["']/i.exec(html || '');
  if (!match) return;
  e.preventDefault();
  try {
    const blob = await (await fetch(match[1])).blob();
    const ext = (blob.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
    await addAttachmentFiles([new File([blob], `pasted-image.${ext}`, { type: blob.type })]);
  } catch (err) {
    toast('Could Not Read The Pasted Image', err.message);
  }
}

/**
 * The attachments waiting to be sent, as panels above the box.
 *
 * They sit inside the composer rather than floating over the transcript: the
 * operator's own sketch had them overlaying the chat's last line, and in practice
 * that hides the sentence you are about to send. The strip takes its own row, so
 * nothing is covered and the box does not move when the first file is added.
 */
export function renderAttachments() {
  const strip = $('attachStrip');
  if (!strip) return;
  const list = state.attachments || [];
  strip.hidden = list.length === 0;
  const chips = list
    .map(
      (f) => {
        const image = /^image\//i.test(f.mime);
        const keepTitle = f.keep
          ? 'Kept — a copy will be saved in .project/attachments when you send. It survives compaction and workers can read it. Click to stop keeping it.'
          : 'Keep a copy in this project when you send. It survives compaction and workers can read it.';
        // A picture says more than its name, so the chip carries the bytes for a
        // preview; anything else keeps the tooltip that already showed its name.
        return `<span class="attach-chip" data-attach="${esc(f.id)}"${image ? ' data-image="1"' : ''} title="${image ? '' : `${esc(f.name)} · ${fmtBytes(f.size)}`}">
        <span class="attach-name">${esc(shortName(f.name))}</span>
        <label class="attach-keep" title="${esc(keepTitle)}">
          <input type="checkbox" data-keep="${esc(f.id)}"${f.keep ? ' checked' : ''} aria-label="Keep a copy of ${esc(f.name)} in the project" />
          <span class="keep-box" aria-hidden="true"></span>
          <span class="keep-label">Keep</span>
        </label>
        <button type="button" class="attach-x" data-detach="${esc(f.id)}" title="Remove ${esc(f.name)}" aria-label="Remove ${esc(f.name)}">✕</button>
      </span>`;
      },
    )
    .join('');
  // The total is the number that matters now that the count is only a sanity
  // cap; it sits under the chips rather than beside them so it never competes
  // with a filename.
  const total = `<span class="attach-total">${list.length} file${list.length === 1 ? '' : 's'} · ${fmtBytes(
    attachmentBytes(list),
  )} of ${fmtBytes(ATTACH_TOTAL_BYTES)}</span>`;
  strip.innerHTML = `${chips}${total}`;
}

/**
 * The picture behind an image chip, on hover.
 *
 * Fixed-position and outside the composer: a popup drawn inside it would be
 * clipped by the dock at the exact moment you wanted to look at it. It appears
 * above the chip, and never off the top of the window - the composer is at the
 * bottom, which is where the room is.
 */
export function showAttachPreview(id) {
  const box = $('attachPreview');
  const img = $('attachPreviewImg');
  const name = $('attachPreviewName');
  const f = (state.attachments || []).find((a) => a.id === id);
  const chip = document.querySelector(`.attach-chip[data-attach="${CSS.escape(String(id))}"]`);
  if (!box || !img || !name || !f || !chip) return;
  box.classList.remove('is-large');
  img.src = `data:${f.mime};base64,${f.data}`;
  name.textContent = f.name;
  box.hidden = false;
  const c = chip.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  const left = Math.max(8, Math.min(c.left, window.innerWidth - b.width - 8));
  box.style.left = `${left}px`;
  box.style.top = `${Math.max(8, c.top - b.height - 8)}px`;
}

export function hideAttachPreview() {
  const box = $('attachPreview');
  if (!box) return;
  box.hidden = true;
  box.classList.remove('is-large');
  const img = $('attachPreviewImg');
  if (img) img.onload = null;
}

/**
 * Close the preview the moment anything moves under it.
 *
 * It is shown on `mouseenter` and hidden on `mouseleave`, and a mouseleave is only
 * dispatched when the pointer *moves*. Scrolling with the wheel does not move the
 * pointer — the chip moves instead — so the picture stayed open with the chip long
 * gone, until the operator happened to hover another one (10 Nov). Any scroll or wheel
 * closes it; both listeners are passive and the call is cheap when it is already shut.
 *
 * Capture on the scroll listener because the transcript is its own scroller: scroll
 * does not bubble, so a listener on `window` would miss the one scroller that matters.
 */
export function installPreviewDismiss() {
  window.addEventListener('scroll', hideAttachPreview, { capture: true, passive: true });
  window.addEventListener('wheel', hideAttachPreview, { passive: true });
  // A resize or a layout change moves the chip without a scroll event at all.
  window.addEventListener('resize', hideAttachPreview, { passive: true });
}

/** Where the route reads a chat chip's picture from: inside the open project,
 *  never a path the page made up. The server checks the folder again. */
function chatImageUrl(chip) {
  // An attached picture: the bytes are on the message's own record, so the chip
  // carries the message id and the file's index instead of a second base64 copy.
  const msgId = chip?.dataset?.msg;
  if (msgId) {
    const message = state.messages.find((m) => m.id === msgId);
    const image = attachmentImage(message, Number(chip.dataset.file || 0));
    return image ? `data:${image.mime};base64,${image.data}` : '';
  }
  const project = currentProject();
  const dir = project?.directory;
  const rel = String(chip?.dataset?.src || '').replace(/^[\\/]+/, '');
  if (!dir || !rel) return '';
  return `/api/image?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(rel)}`;
}

/** The picture behind a chat chip, full size and centred, above the chip. */
export function showChatImagePreview(chip) {
  const box = $('attachPreview');
  const img = $('attachPreviewImg');
  const name = $('attachPreviewName');
  const src = chatImageUrl(chip);
  if (!box || !img || !name || !src) return;
  name.textContent = chip.dataset.alt || String(chip.dataset.src || '').split('/').pop() || '';
  box.classList.add('is-large');
  box.hidden = false;
  // The size is known only after the bytes arrive, so the place is computed
  // twice: now, and again when the picture has loaded.
  img.onload = () => { if (!box.hidden) placeChatPreview(chip); };
  img.src = src;
  placeChatPreview(chip);
}

function placeChatPreview(chip) {
  const box = $('attachPreview');
  if (!box || !chip) return;
  const c = chip.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  box.style.left = `${Math.round(Math.max(8, (window.innerWidth - b.width) / 2))}px`;
  box.style.top = `${Math.round(Math.max(8, c.top - b.height - 10))}px`;
}

/** Put the newest message in view, and the cards above it.
 *
 *  Two scrollers can both be live: the transcript scrolls itself, and in the narrow
 *  layout the *page* scrolls as well (one column). The transcript goes to its end,
 *  and the page goes to the top of the role cards — so sending shows the newest
 *  message *and* the cards the work will appear in. In the wide layout the page does
 *  not scroll, so only the transcript moves.
 */
function scrollChatToEnd(smooth = true) {
  const el = chatScroller();
  if (el) {
    if (smooth) animateScroll(el, el.scrollHeight, 220);
    else el.scrollTop = el.scrollHeight;
  }
  const cards = $('topologyWrap');
  if (!cards) return;
  if (document.documentElement.scrollHeight <= window.innerHeight + 2) return;
  const to = Math.max(0, window.scrollY + cards.getBoundingClientRect().top - 8);
  if (smooth) animateScroll(null, to, 220);
  else window.scrollTo(0, to);
}

// A conversation is the project's. With nothing open there is nothing to send
// to: the landing panel asks for a project instead.
async function ensureSession() {
  if (state.sessionId) return state.sessionId;
  throw new Error('open a project first');
}

export async function interrupt() {
  // One request stops the project. The first press is graceful: the AI finishes
  // the step it is in and ends. The second press — or a press while a card is
  // waiting, where there is no step to finish — is the old immediate cut.
  if (!state.sessionId) return;
  const hard = state.stopping || state.busyInfo?.state === 'waiting';
  try {
    if (hard) {
      // Cut now. The page does not announce "Stopped" here: the server does, when
      // the project is really quiet (`stop.done`). Saying it on the click is how a
      // stop that did not take still looked successful.
      await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/interrupt`);
      state.stopping = true;
      // The second press is "stop now". The page records it so the turn's end does not
      // close the operator's folds or redraw over what they are reading
      // (`closeReasoningFolds` in app.js).
      //
      // It does not freeze the chat. A repeated Stop is the operator telling the work to
      // end, not asking for the conversation to stand still: freezing it here meant the
      // chat quietly stopped being the chat — a yellow glow, "Chat paused · N updates
      // waiting", and nothing new on screen until they found Continue (21 Nov).
      state.hardStop = true;
    } else {
      const r = await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/stop`);
      state.stopping = Boolean(r?.stopping);
      // The one thing a gentle Stop can end with no turn behind it: a message queued
      // for a busy local server (21 Nov).
      if (r?.cancelledQueued) {
        toast('Message Cancelled', 'It will not be sent when the local server is free.');
      }
    }
    renderComposer();
    // The engine takes a moment to close the turns; refresh once now and again
    // after it has had time, so a stop that did not take does not hide the button.
    wired.refreshPending();
    setTimeout(refreshPending, 1500);
  } catch (err) {
    if (!hard && err.status === 409 && err.body?.waiting) {
      // A card is waiting: there is no step to finish. Stop it now.
      try {
        await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/interrupt`);
        state.stopping = false;
        renderComposer();
        wired.refreshPending();
        return;
      } catch { /* fall through to the toast below */ }
    }
    toast('Stop failed', err.message);
  }
}

/** The upper-right notice and the red glow while a stop is running. The server
 *  says whether one is in force, and whether it has stopped taking effect. */
function renderStopState() {
  const notice = $('stopNotice');
  if (notice) notice.hidden = !state.stopping;
  document.body.classList.toggle('is-stopping', state.stopping);
  const text = $('stopNoticeText');
  if (text) {
    text.textContent = state.stoppingReason
      ? `Still running — ${state.stoppingReason}. Click Stop again to cut it now.`
      : 'The AI will finish this step, then stop. Click Stop again to stop now.';
  }
  const btn = $('stopBtn');
  if (btn) {
    btn.classList.toggle('is-stopping', state.stopping);
    btn.title = state.stopping
      ? state.stoppingReason
        ? `Still running — ${state.stoppingReason}. Click again to cut it now.`
        : 'Stopping — the AI is finishing this step. Click again to stop immediately.'
      : 'Stop the current run';
  }
}

/** Interrupt any session, from the rail — the way out of a stalled run. */
export async function interruptSession(sessionId) {
  try {
    await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/interrupt`);
    state.busySessions.delete(sessionId);
    state.busySince.delete(sessionId);
    wired.renderTree();
    toast('Interrupted', 'The stuck request was cancelled.');
    wired.refreshPending();
  } catch (err) {
    toast('Could not interrupt', err.message);
  }
}

/** Can the browser size the composer from its text? Chrome 123 and later do, which
 *  is every WebView2 this app runs in. */
const fieldSized = typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content');

/**
 * The composer grows with what is typed in it, up to the ceiling the stylesheet
 * sets. Where the browser can do that itself (`field-sizing: content`) this clears
 * any inline height and stops — an inline height wins over the browser's own.
 *
 * The old way of measuring, `height:auto` → read `scrollHeight` → write it back,
 * looked harmless and was not. Between the two writes the composer is one line
 * tall, so the transcript above it is a line taller; the browser clamps the chat's
 * scroll offset to the shorter distance that taller box can now scroll, and the
 * clamp is *not* undone when the composer gets its height back. Measured on a
 * 131-message transcript: offset 3143 (the end) → 3110 while the box was 33px
 * short → still 3110 after it was restored, and still 3110 half a second later.
 * So typing past the first wrap left the conversation one line short of the end,
 * and the next thing that pinned the end (a render, a stream frame) put it back:
 * the small up-and-down the operator saw while typing, once per wrap and again
 * whenever something re-settled the chat.
 *
 * Engines without `field-sizing` go through that measurement still, with the
 * chat's offset held across it so the transient cannot clamp it.
 */
export function autoGrow(el) {
  if (!el) return;
  if (fieldSized) {
    if (el.style.height) el.style.height = '';
    return;
  }
  const chat = $('transcript');
  const top = chat ? chat.scrollTop : null;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  if (chat && top !== null && chat.scrollTop !== top) chat.scrollTop = top;
}
