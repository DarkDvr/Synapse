// The four primitives every Settings pane is built from: a labelled input, a
// select, a checkbox and a group. They emit the markup the form's one change
// handler reads — `data-path` is the dotted path into the config object.
//
// Every control carries a plain-English tooltip: the config file is the source
// of truth, but this screen is where a number is actually chosen, and "what is
// this?" should not require reading the source. Units live in the label, and
// anything long is in minutes — nobody reads 1200 and thinks "twenty minutes".
//
// They lived in app.js beside the panes that used them. Moving them first is what
// lets the panes follow: a pane is a list of these, and nothing else.
import { esc } from './format.js';
import { readPath } from './settings-data.js';

export function setField(c, label, path, opts = {}) {
  const scale = Number(opts.scale) || 1;
  const raw = opts.value !== undefined ? opts.value : readPath(c, path);
  const shown = scale === 1 ? raw : Number(raw) / scale;
  const badge = opts.restart ? ' <em class="set-restart">Restart</em>' : '';
  return `
    <label class="set-field${opts.wide ? ' wide' : ''}" title="${esc(opts.hint || '')}">
      <span>${esc(label)}${badge}</span>
      <input data-path="${path}"${scale !== 1 ? ` data-scale="${scale}"` : ''} type="${opts.type || 'text'}" value="${esc(shown)}" ${opts.attr || ''} />
    </label>`;
}

export function setSelect(c, label, path, options, opts = {}) {
  const badge = opts.restart ? ' <em class="set-restart">Restart</em>' : '';
  // `opts.value` is for a setting the saved config may not hold yet (a key added in a
  // later version): the form then shows the default it would get, instead of the
  // first option, which would be saved as a choice nobody made.
  const current = opts.value !== undefined ? opts.value : readPath(c, path);
  return `
    <label class="set-field${opts.wide ? ' wide' : ''}" title="${esc(opts.hint || '')}">
      <span>${esc(label)}${badge}</span>
      <select data-path="${path}">
        ${options.map((o) => `<option value="${esc(o.v)}"${o.v === current ? ' selected' : ''}>${esc(o.l)}</option>`).join('')}
      </select>
    </label>`;
}

export const setCheck = (c, label, path, hint = '', on) => `
    <label class="set-check" title="${esc(hint)}">
      <input data-path="${path}" type="checkbox" ${(on ?? readPath(c, path)) ? 'checked' : ''} />
      <span>${esc(label)}</span>
    </label>`;

export const setGroup = (title, body, cols, hint = '') =>
  `<section class="set-group"><h4${hint ? ` title="${esc(hint)}"` : ''}>${title}</h4><div class="set-grid${cols === 3 ? ' cols-3' : ''}">${body}</div></section>`;
