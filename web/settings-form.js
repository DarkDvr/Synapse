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

/**
 * A slider with its value written beside the track.
 *
 * The chat's size used to be a number box with two arrows and a half-point step: a
 * change the eye cannot see, and a control that asks the operator to type a quantity
 * they do not know. A slider says where in the range you are, the value sits where
 * the eye already is, and the step is a whole point (10 Nov).
 *
 * The value is an `<output>` rather than a second input: it is the same number the
 * control already holds, said once, and `onSettingsInput` keeps it in step.
 */
export function setSlider(c, label, path, opts = {}) {
  const min = Number(opts.min);
  const max = Number(opts.max);
  const step = Number(opts.step) || 1;
  const unit = String(opts.unit || '');
  const raw = opts.value !== undefined ? opts.value : readPath(c, path);
  const n = Number(raw);
  const at = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
  const say = (v) => `${v}${unit ? ` ${unit}` : ''}`;
  // The filled part of the track: the thumb says where you are, and this says how
  // much of the range is behind you, which is what makes a slider read at a glance.
  const fill = Math.min(100, Math.max(0, ((at - min) / (max - min || 1)) * 100));
  return `
    <label class="set-field set-slider${opts.wide ? ' wide' : ''}" title="${esc(opts.hint || '')}">
      <span>${esc(label)}${opts.restart ? ' <em class="set-restart">Restart</em>' : ''}</span>
      <span class="slider-row">
        <input data-path="${path}" type="range" min="${min}" max="${max}" step="${step}" value="${esc(at)}"
          style="--fill:${fill}%" aria-label="${esc(label)}" aria-valuetext="${esc(say(at))}" />
        <output class="slider-value" data-says="${path}">${esc(say(at))}</output>
      </span>
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
