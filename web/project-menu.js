// The project menu: rename, move, open the folder, delete — the ⋯ on a row.
//
// One menu for the ⋯ button, a right-click and Shift+F10, because a project has one
// set of actions and three ways to ask for them. Deleting a project is the only
// destructive thing in the rail, so it asks, and it says what will happen to the
// folder rather than to the conversation.
//
// Four things come from app.js and are wired at boot: the dialog, opening a chat,
// the empty view, and the slug a project name becomes.
import { state } from './state.js';
import { esc, fmtBytes } from './format.js';
import { $ } from './dom.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { loadProjects, openProjectChat, openProjectFolder } from './projects.js';
import { chatBody } from './mode.js';
import { projectOf } from './run-view.js';
import { ago } from './format.js';

const missing = (name) => () => {
  throw new Error(`project-menu.js: ${name} was not wired at boot`);
};
const wired = {
  openDialog: missing('openDialog'),
  openSession: missing('openSession'),
  showNothing: missing('showNothing'),
  slug: missing('slug'),
};

/** Hand this module the four things that live in app.js. Called once, at boot. */
export function projectMenuWiring(fns) {
  Object.assign(wired, fns);
}

// ── the project menu ────────────────────────────────────────────
// One menu, opened from the row's "⋯", a right-click, or Shift+F10. The rail
// keeps only a name and a state dot; Browse, Cmd, Rename and Delete live here so
// they stop competing with the name for width.
export let menuProjectId = null;

export function closeProjectMenu() {
  menuProjectId = null;
  const el = $('projectMenu');
  if (el) el.hidden = true;
}

export function openProjectMenu(id, x, y) {
  const p = state.projects.find((q) => q.id === id);
  const el = $('projectMenu');
  if (!p || !el) return;
  menuProjectId = id;
  // The rail is the registry order, so the ends are where a move stops. The menu
  // disables the impossible one rather than letting a click do nothing.
  const at = state.projects.findIndex((q) => q.id === id);
  const first = at <= 0;
  const last = at < 0 || at >= state.projects.length - 1;
  el.innerHTML = `
    <button type="button" class="project-menu-item" data-menu-action="browse" role="menuitem">Browse</button>
    <button type="button" class="project-menu-item" data-menu-action="cmd" role="menuitem">Cmd</button>
    <span class="project-menu-sep" aria-hidden="true"></span>
    <button type="button" class="project-menu-item" data-menu-action="up" role="menuitem"${first ? ' disabled' : ''}>Move Up</button>
    <button type="button" class="project-menu-item" data-menu-action="down" role="menuitem"${last ? ' disabled' : ''}>Move Down</button>
    <span class="project-menu-sep" aria-hidden="true"></span>
    <button type="button" class="project-menu-item" data-menu-action="rename" role="menuitem">Rename</button>
    <button type="button" class="project-menu-item is-danger" data-menu-action="delete" role="menuitem">Delete…</button>`;
  el.hidden = false;
  el.style.left = '0px';
  el.style.top = '0px';
  const box = el.getBoundingClientRect();
  el.style.left = `${Math.min(Math.max(8, x), window.innerWidth - box.width - 8)}px`;
  el.style.top = `${Math.min(Math.max(8, y), window.innerHeight - box.height - 8)}px`;
  el.querySelector('button')?.focus();
}

export function projectMenuAction(id, action) {
  if (!id) return;
  if (action === 'browse') openProjectFolder(id, 'browse');
  else if (action === 'cmd') openProjectFolder(id, 'cmd');
  else if (action === 'up') moveProject(id, -1);
  else if (action === 'down') moveProject(id, 1);
  else if (action === 'rename') renameProject(id);
  else if (action === 'delete') removeProject(id);
}

/** Move a project up or down the rail. The order lives in the registry file. */
export async function moveProject(id, delta) {
  // Where every row was, so the rows that swap slide into place instead of
  // teleporting. Two lines of transforms, no dependency, and the motion is
  // skipped for anyone who asked for less of it.
  const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const before = new Map(
    [...document.querySelectorAll('[data-project-row]')].map((row) => [
      row.dataset.projectRow,
      row.getBoundingClientRect().top,
    ]),
  );
  try {
    await api('POST', `/api/projects/${encodeURIComponent(id)}/move`, { delta });
    // Re-read rather than rearranging the local list: the rail is the registry,
    // and the reload brings every row and its state back with it.
    await loadProjects({ keepOpen: true });
  } catch (err) {
    toast('Could Not Move The Project', err.message);
    return;
  }
  if (calm) return;
  for (const row of document.querySelectorAll('[data-project-row]')) {
    const was = before.get(row.dataset.projectRow);
    if (was === undefined) continue;
    const dy = was - row.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    row.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], {
      duration: 160,
      easing: 'cubic-bezier(.2, .8, .2, 1)',
    });
  }
}

/**
 * Delete a project: its folder, its plan and its chat, together.
 *
 * There used to be a pre-check here that refused while the project held
 * sessions, and that was the product's last lie: the server deletes the chat
 * with the project, so the dialog protected nothing and made a delete
 * impossible. The one consent that remains is real — the built app in `bin\`
 * is a deliverable, so deleting it is a separate tick.
 */
export async function removeProject(id) {
  const p = state.projects.find((x) => x.id === id);
  if (!p) return;
  // The folder goes with the project, so the dialog has to say what is in it. The
  // server answers from the disk rather than from the list's memory of it.
  let info = null;
  try {
    info = await api('GET', `/api/projects/${encodeURIComponent(id)}/delete-info`);
  } catch (err) {
    toast('Could Not Look At The Project', err.message);
    return;
  }
  const bin = info?.bin || { files: 0, bytes: 0 };
  const deliverables = bin.files > 0;
  const ok = await wired.openDialog({
    title: 'Delete Project',
    message:
      info?.exists === false
        ? `"${p.name}" is no longer a folder on disk. Remove the project from Synapse?`
        : `"${p.name}", its conversation and everything in its folder are deleted. The folder goes to the Recycle Bin, so it can be restored from there.`,
    confirmLabel: 'Delete',
    danger: true,
    fields: deliverables
      ? [
          {
            name: 'deliverables',
            type: 'check',
            value: false,
            label: `Delete the ${bin.files === 1 ? 'file' : `${bin.files} files`} in bin\\ as well`,
            hint:
              `${fmtBytes(bin.bytes)} of deliverables — the built app — in ${info.directory}\\bin. ` +
              'They go to the Recycle Bin with the rest of the folder; nothing is deleted for good.',
          },
        ]
      : [],
    afterRender: deliverables
      ? () => {
          const box = $('dialogBody').querySelector('input[data-flag="deliverables"]');
          const btn = $('dialogOk');
          const gate = () => { btn.disabled = !box?.checked; };
          box?.addEventListener('change', gate);
          gate();
        }
      : undefined,
  });
  if (!ok) return;
  try {
    const res = await api('DELETE', `/api/projects/${encodeURIComponent(id)}`, {
      binConfirmed: Boolean(ok.deliverables),
    });
    // The chat belongs to the project just deleted: closing it is the point of
    // the action, not a second piece of news. Empty the view first, so
    // loadProjects does not add "Chat Closed" on top of "Project Deleted".
    if (projectOf(state.sessionId)?.id === id) wired.showNothing();
    await loadProjects();
    if (res?.recycled) toast('Project Deleted', `"${p.name}" and its folder are in the Recycle Bin.`);
    else toast('Project Removed', `"${p.name}" was no longer a folder on disk.`);
  } catch (err) {
    toast('Could Not Delete The Project', recycleReason(err.message));
  }
}

/** The server's words for a folder that would not go to the bin, in the operator's terms. */
export function recycleReason(message) {
  const text = String(message || 'the server did not say why');
  if (/denied/i.test(text)) return 'Windows would not let go of that folder — a file inside it may be open in another program. Close it and try again.';
  if (/in use|being used by another process/i.test(text)) return 'A file in that folder is open in another program. Close it and try again.';
  if (/not found|cannot find/i.test(text)) return 'The folder had already been moved or deleted.';
  return text;
}

export async function createChat(projectId) {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return;
  if (project.exists === false) {
    toast('Folder missing', `${project.directory} does not exist, so no chat can run there.`);
    return;
  }
  try {
    const { session } = await api('POST', '/api/sessions', chatBody(project.id));
    await loadProjects();
    await wired.openSession(session.id);
  } catch (err) {
    toast('Could not open the chat', err.message);
  }
}

export async function renameProject(id) {
  const p = state.projects.find((x) => x.id === id);
  if (!p) return;
  const res = await wired.openDialog({
    title: 'Rename project',
    message: `The label only — the folder stays ${p.directory}.`,
    fields: [{ name: 'name', label: 'Project name', value: p.name }],
    confirmLabel: 'Rename',
    afterRender: () => $('dlg-name')?.select(),
  });
  if (!res) return;
  const name = res.name?.trim();
  if (!name || name === p.name) return;
  try {
    await api('PATCH', `/api/projects/${encodeURIComponent(id)}`, { name });
    await loadProjects();
  } catch (err) {
    toast('Could not rename the project', err.message);
  }
}

/**
 * The folder-history dialog's body: the path, the numbers as chips, and the old
 * goal as a quotation.
 *
 * The goal is shown in full and clamped by CSS to three lines *with an ellipsis*,
 * its text in the tooltip. It used to be sliced to 160 characters by the server,
 * which cut it mid-sentence with no ellipsis — the operator's word for it was "text
 * cuts off", and it read as a rendering fault rather than a summary.
 */
export function clashBody(info) {
  const mins = info.plan.mtime ? Math.max(1, Math.round((Date.now() - info.plan.mtime) / 60000)) : null;
  const ago = mins === null
    ? null
    : mins < 90 ? `${mins} min ago` : mins < 60 * 36 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
  const chips = [
    `${info.plan.tasks} task${info.plan.tasks === 1 ? '' : 's'}`,
    `${info.plan.done} done`,
    info.files ? `${info.files} file${info.files === 1 ? '' : 's'}` : null,
    ago ? `last touched ${ago}` : null,
  ].filter(Boolean);
  return (
    `<p class="clash-path" title="${esc(info.directory)}">${esc(info.directory)}</p>` +
    `<div class="clash-chips">${chips.map((c) => `<span class="clash-chip">${esc(c)}</span>`).join('')}</div>` +
    (info.plan.goal
      ? `<p class="clash-label">Its goal was</p>` +
        `<blockquote class="clash-goal" title="${esc(info.plan.goal)}">${esc(info.plan.goal)}</blockquote>`
      : '') +
    `<p class="clash-note">Re-using continues that plan where it left off. ` +
    `Deleting removes the folder and everything inside it — that cannot be undone.</p>`
  );
}

export async function addProject() {
  const base = state.workspace || '';
  const res = await wired.openDialog({
    title: 'Add a project',
    message: 'A project is a folder. Its one conversation runs there, and Synapse creates the folder when it does not exist yet.',
    fields: [
      { name: 'name', label: 'Project name', placeholder: 'calendar' },
      { name: 'directory', label: 'Folder', placeholder: base ? `${base}\\calendar` : 'C:\\path\\to\\project' },
    ],
    confirmLabel: 'Add Project',
    afterRender: () => {
      const nameEl = $('dlg-name');
      const dirEl = $('dlg-directory');
      if (!nameEl || !dirEl) return;
      let touched = false;
      const suggest = () => (base ? `${base}\\${wired.slug(nameEl.value)}` : '');
      dirEl.addEventListener('input', () => { touched = true; });
      nameEl.addEventListener('input', () => { if (!touched) dirEl.value = suggest(); });
    },
  });
  if (!res) return;

  const name = res.name?.trim();
  let directory = res.directory?.trim();
  if (!directory) directory = base ? `${base}\\${wired.slug(name)}` : '';
  if (!directory) {
    toast('A folder is required', 'Give the project a folder to run in.');
    return;
  }
  try {
    // Look before creating. A folder that was a project once still holds everything
    // — and a reused name ("Test Project 1") resolves to the very same path — so
    // the operator is asked, not told, and nothing is created or deleted until
    // they answer.
    const info = await api('POST', '/api/projects/inspect', { directory });
    if (info.plan) {
      const choice = await wired.openDialog({
        title: 'This folder was a project before',
        message: '',
        confirmLabel: 'Delete Folder And Start Fresh',
        danger: true,
        extra: { label: 'Re-Use It', result: 'reuse' },
        okResult: 'wipe',
        dismissable: false,
        tone: 'clash',
        afterRender: () => { $('dialogBody').innerHTML = clashBody(info); },
      });
      if (!choice) return; // cancelled: nothing created, nothing deleted
      if (choice === 'wipe') {
        await api('POST', '/api/projects/wipe', { directory });
        toast('Folder Wiped', `"${directory}" is empty — starting fresh.`);
      }
    }
    const made = await api('POST', '/api/projects', { name: name || undefined, directory });
    await loadProjects();
    toast('Project added', directory);
    // A project is one conversation: adding it opens it, and the first open makes
    // the chat. There is no separate "start a session" step to remember.
    const created = made?.project || state.projects.find((p) => p.directory.toLowerCase() === directory.toLowerCase());
    if (created) await openProjectChat(created.id);
  } catch (err) {
    toast('Could not add the project', err.message);
  }
}
