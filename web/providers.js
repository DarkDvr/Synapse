// Settings → Providers: the list, the add menu, and the editor for one provider.
//
// This is the only editable list in the window, and it is the one pane that needs
// the app's own state machine rather than just the draft: every edit flushes the
// fields into the draft and re-renders the window, and removing a provider that a
// role is using asks first. Those four calls are wired in at boot
// (`providersWiring`) instead of imported, because they belong to app.js and
// importing them would be a cycle.
import { state } from './state.js';
import { esc } from './format.js';
import { $ } from './dom.js';
import { api } from './api.js';
import { setIcon } from './icons.js';
import { slugify, maskSecret, modelLines, isLocalServer, providerBadge } from './settings-data.js';
import { providerOrderOf } from './provider-list.js';

const wired = {
  collectSettings: () => null,
  renderSettings: () => {},
  openDialog: async () => false,
  toast: () => {},
};

/** Hand the pane the four things that live in app.js. Called once, at boot. */
export function providersWiring(fns) {
  Object.assign(wired, fns);
}

// ── providers: the only editable list in this window ────────────
// maskSecret, slugify, modelLines and parseModelLines moved to ./settings-data.js;
// their notes went with them.

function providerEditor(providers, index) {
  const p = providers[index];
  if (!p) return '';
  const key = String(p.apiKey || '');
  const revealed = Boolean(state.setKeyRevealed);
  const fromEnv = /^env:/i.test(key);
  const typed = Boolean(key) && !fromEnv;              // typed in this window, never sent by the server
  const stored = Boolean(p.apiKeySet) && !p.apiKeyRemoved;
  const shown = typed ? (revealed ? key : maskSecret(key)) : fromEnv ? key : stored ? p.apiKeyMasked || '' : '';
  const canReveal = typed;
  const taken = providers.filter((q, i) => i !== index).map((q) => q.id || slugify(q.name));
  const previewId = p.id || slugify(p.name || '') || 'provider';
  const clash = !p.id && taken.includes(previewId);
  const fetchNote = state.setProvFetch;
  const roles = Object.entries(state.setDraft?.roles || {})
    .filter(([, r]) => String(r?.ref || '').startsWith(`${p.id || previewId}/`))
    .map(([role]) => role);

  return `
  <section class="prov-edit" data-prov-edit-form>
    <div class="set-grid">
      <label class="set-field" title="A local server runs on this machine. llama.cpp Server is one of those too: the same kind of server, which reports its window at /props. An OpenAI-compatible endpoint can be anything that speaks the same API, including a paid service.">
        <span>Type</span>
        <select data-prov="type">
          <option value="local"${p.type === 'local' || !p.type ? ' selected' : ''}>Local provider (LM Studio)</option>
          <option value="llamacpp"${p.type === 'llamacpp' ? ' selected' : ''}>Local provider (llama.cpp)</option>
          <option value="openai"${p.type && p.type !== 'local' && p.type !== 'llamacpp' ? ' selected' : ''}>OpenAI Compatible</option>
        </select>
        <small class="prov-hint">${
          p.type === 'llamacpp'
            ? 'A llama.cpp server on this machine; its window comes from /props.'
            : p.type === 'openai'
              ? 'Reached over the network; its window is the one you type.'
              : 'A local server that reports its window at /api/v0/models.'
        }</small>
      </label>
      <label class="set-field" title="The name on the badge beside this provider's models in every role's menu.">
        <span>Name</span>
        <input data-prov="name" value="${esc(p.name || '')}" placeholder="DeepSeek" />
        <small class="prov-hint">Model prefix: <code>${esc(previewId)}</code> — the word before the slash in
          <code>${esc(previewId)}/model</code>. It comes from the name, and a provider the engine already serves
          keeps its models only when the two match (name it <code>OpenCode</code> for <code>opencode</code>).</small>
      </label>
      <label class="set-field wide" title="The server's address, including /v1 when it needs one. Nothing is contacted until you press Refresh List or run a turn.">
        <span>Server URL</span>
        <input data-prov="baseURL" value="${esc(p.baseURL || '')}" placeholder="http://localhost:1234/v1" spellcheck="false" />
      </label>
      ${p.type === 'local' ? `<label class="set-field" title="Which endpoint Refresh List asks for the model list. Chat goes through the OpenAI-compatible URL either way; the other endpoint is tried automatically if this one fails.">
        <span>Format</span>
        <select data-prov="format">
          <option value="openai"${p.format !== 'ollama' ? ' selected' : ''}>OpenAI API (/models)</option>
          <option value="ollama"${p.format === 'ollama' ? ' selected' : ''}>Ollama (/api/tags)</option>
        </select>
        <small class="prov-hint">Either endpoint answers the other; this only decides which is asked first.</small>
      </label>` : ''}
      <div class="set-field wide" title="Sent as a bearer token. A key typed here is stored beside the app's data (not in the config file); env:NAME reads the environment when Synapse starts.">
        <span>API Key</span>
        <div class="set-key">
          <input data-prov="apiKey" value="${esc(shown)}" data-masked="${typed && !revealed ? '1' : '0'}" type="text" spellcheck="false"
                 placeholder="${isLocalServer(p) ? 'Empty for local servers' : 'sk-…'}" autocomplete="off" />
          ${canReveal ? `<button type="button" class="input-eye" data-prov-eye aria-label="${revealed ? 'Hide the key' : 'Show the key'}" title="${revealed ? 'Hide the key' : 'Show the key'}">${setIcon(revealed ? 'eyeOff' : 'eye')}</button>` : ''}
        </div>
        <small class="prov-hint">${
          p.apiKeyRemoved
            ? 'The stored key is removed when you save.'
            : fromEnv
              ? `Read from the environment when Synapse starts — the config file keeps the variable's name, not the key. Type over it to store a key beside the app instead.`
              : stored
                ? `Stored beside the app's data, not in the config file — type over it to replace it.`
                : 'Kept beside the app\'s data, never in the config file. Only needed for a service.'
        }</small>
        ${stored || fromEnv ? `<div class="prov-tools"><button type="button" class="btn btn-danger btn-sm" data-prov-remove>Remove Key</button></div>` : ''}
      </div>
      <div class="set-field wide">
        <span>Models</span>
        <textarea data-prov="models" rows="4" spellcheck="false">${esc(modelLines(p.models, !isLocalServer(p)))}</textarea>
        <div class="prov-tools">
          <button type="button" class="btn btn-secondary btn-sm" data-prov-fetch>Refresh List</button>
          <span class="prov-fetch-state${fetchNote ? (fetchNote.ok ? ' is-ok' : ' is-bad') : ''}">${esc(fetchNote?.text || '')}</span>
        </div>
        <small class="prov-hint">${
          isLocalServer(p)
            ? 'One per line: <code>id | name</code>. The window is read from the server.'
            : 'One per line: <code>id | name | context | output</code>. Only the id is required.'
        }</small>
      </div>
    </div>
    <p class="prov-badge-line">
      Model refs use <code>${esc(p.id || previewId)}/…</code>.
      ${(p.models || []).length ? '' : '<span class="prov-warn">No models yet — saved, but not registered with the engine until it has one.</span>'}
      ${clash ? '<span class="prov-warn">That id is already used — pick another name.</span>' : ''}
      ${roles.length ? `<span class="prov-inuse">In use by ${esc(roles.join(', '))}.</span>` : ''}
    </p>
  </section>`;
}

export function settingsProviders(c) {
  const providers = c.engine?.opencode?.providers || [];
  const selected = Number.isInteger(state.setProvSelected) ? state.setProvSelected : -1;
  const order = providerOrderOf(c);
  const indexById = new Map(providers.map((p, i) => [String(p.id || slugify(p.name)), i]));
  const moves = (id, at) => `
          <button type="button" class="role-btn ic-move" data-prov-up="${esc(id)}" title="Move Up"
                  aria-label="Move ${esc(id)} up"${at === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" class="role-btn ic-move" data-prov-down="${esc(id)}" title="Move Down"
                  aria-label="Move ${esc(id)} down"${at === order.length - 1 ? ' disabled' : ''}>↓</button>`;
  const rowFor = (id, at) => {
    const i = indexById.get(id);
    if (i === undefined) return '';
    const p = providers[i];
    const used = Object.entries(c.roles || {}).filter(([, r]) => String(r?.ref || '').startsWith(`${p.id || slugify(p.name)}/`));
    const count = (p.models || []).length;
    return `<div class="prov-row${i === selected ? ' is-active' : ''}" data-prov-row="${i}" role="button" tabindex="0"
                 aria-label="Edit ${esc(p.name || 'provider')}">
        <span class="prov-type">${esc(providerBadge(p))}</span>
        <span class="prov-name">${esc(p.name || 'Untitled provider')}</span>
        <span class="prov-url">${esc(p.baseURL || 'no server URL yet')}</span>
        <span class="prov-meta">${count} model${count === 1 ? '' : 's'}${used.length ? ` · ${used.length} role${used.length === 1 ? '' : 's'}` : ''}</span>
        <span class="prov-acts">${moves(id, at)}
          <button type="button" class="role-btn ic-edit" data-prov-edit="${i}" title="Edit ${esc(p.name || 'this provider')}" aria-label="Edit ${esc(p.name || 'this provider')}">✎</button>
          <button type="button" class="role-btn prov-del" data-prov-del="${i}" title="Remove ${esc(p.name || 'this provider')}" aria-label="Remove ${esc(p.name || 'this provider')}">✕</button>
        </span>
      </div>`;
  };
  const rows = order.map((id, at) => rowFor(id, at)).join('');

  return `
    <section class="set-group"><h4>Providers <em class="set-restart">Restart</em></h4>
      <div class="prov-add">
        <button type="button" class="btn btn-provider btn-sm" data-prov-add>+ Add Provider</button>
        <div class="prov-add-menu" id="provAddMenu" hidden>
          <button type="button" data-prov-new="local">Local Provider</button>
          <button type="button" data-prov-new="llamacpp">Local Provider (llama.cpp)</button>
          <button type="button" data-prov-new="openai">OpenAI Compatible</button>
        </div>
      </div>
      <div class="prov-list">
        ${rows}
      </div>
      <hr class="prov-divider" />
      ${providerEditor(providers, selected)}
      <p class="set-note">A new or changed provider appears in the model menu after a restart. Keys typed here are stored beside the app's data, never in the config.</p>
    </section>`;
}

// ── providers: the editor's own small state machine ─────────────

/** The provider the editor is pointed at, read from the draft. app.js needs it too:
 *  its input handler writes a field straight into that object, and the eye button
 *  asks whether there is one to reveal. */
export function providerAt(index) {
  const list = state.setDraft?.engine?.opencode?.providers;
  return Array.isArray(list) && list[index] ? list[index] : null;
}

/**
 * Move a provider up or down the list the model menu follows.
 *
 * The order is saved with the settings (`engine.opencode.providerOrder`), so this
 * is a config change like any other: the footer offers Apply/Save and the menu
 * picks it up when the settings are saved. The edit form is flushed into the
 * draft first, or a value typed but not yet collected would be lost by the
 * re-render.
 */
export function moveProvider(id, delta) {
  const c = wired.collectSettings();
  if (!c) return;
  const order = providerOrderOf(c);
  const at = order.indexOf(String(id || ''));
  const to = at + delta;
  if (at < 0 || to < 0 || to >= order.length) return;
  order.splice(to, 0, order.splice(at, 1)[0]);
  c.engine.opencode = c.engine.opencode || {};
  c.engine.opencode.providerOrder = order;
  wired.renderSettings();
}

export function addProvider(type) {
  const c = wired.collectSettings();
  if (!c) return;
  c.engine.opencode = c.engine.opencode || {};
  const list = Array.isArray(c.engine.opencode.providers) ? c.engine.opencode.providers : (c.engine.opencode.providers = []);
  list.push({
    id: '',
    type,
    // Three kinds, two behaviours: a `llamacpp` server *is* a local server, it just
    // answers /props rather than LM Studio's /api/v0/models. Named for the dialect
    // so it fits every wrapper of it, not one product.
    name: type === 'local' ? 'Local Server' : type === 'llamacpp' ? 'Local Server' : 'OpenAI Compatible',
    format: 'openai',
    baseURL: type === 'llamacpp' ? 'http://localhost:8080/v1' : '',
    apiKey: '',
    models: [],
  });
  state.setProvSelected = list.length - 1;
  state.setKeyRevealed = false;
  state.setProvFetch = null;
  wired.renderSettings();
  $('settingsBody').querySelector('[data-prov="name"]')?.focus();
}

export async function removeProvider(index) {
  const p = providerAt(index);
  if (!p) return;
  const c = state.setDraft;
  const used = Object.entries(c.roles || {}).filter(([, r]) =>
    String(r?.ref || '').startsWith(`${p.id || slugify(p.name)}/`),
  );
  if (used.length) {
    const ok = await wired.openDialog({
      title: 'Remove Provider',
      message:
        `${p.name || 'This provider'} is in use by ${used.map(([role]) => role).join(', ')}. ` +
        `Removing it leaves those roles pointing at models that will no longer exist, until you pick another on the card.`,
      confirmLabel: 'Remove',
      danger: true,
      okResult: true,
    });
    if (!ok) return;
  }
  c.engine.opencode.providers.splice(index, 1);
  state.setProvSelected = null;
  state.setKeyRevealed = false;
  state.setProvFetch = null;
  wired.renderSettings();
}

export async function refreshProviderModels(index) {
  const p = providerAt(index);
  if (!p) return;
  const stateEl = $('settingsBody').querySelector('.prov-fetch-state');
  if (stateEl) { stateEl.className = 'prov-fetch-state'; stateEl.textContent = 'Asking the server…'; }
  const r = await api('POST', '/api/providers/models', {
    id: p.id,
    baseURL: p.baseURL,
    apiKey: p.apiKey,
    format: p.format,
    type: p.type,
  }).catch((err) => ({
    ok: false,
    models: [],
    error: err.message,
  }));
  if (!r.ok) {
    state.setProvFetch = { ok: false, text: r.error || 'The server did not answer.' };
    wired.renderSettings();
    return;
  }
  const previous = new Map((p.models || []).map((m) => [m.id, m]));
  const had = p.models || [];
  // Refresh *replaces* the list: the server is the truth about what it serves, so
  // a model it no longer reports is gone from the row, not kept beside the new
  // ones. What survives by id keeps the settings only the operator knows — the
  // output budget — and takes the window the server just measured, because a
  // runtime reports the context it has *loaded* and that changes on a reload.
  p.models = r.models
    .map((m) => {
      const old = previous.get(m.id) || {};
      return {
        id: m.id,
        name: m.name || old.name || m.id,
        ...(m.context || old.context ? { context: m.context || old.context } : {}),
        ...(old.output ? { output: old.output } : {}),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const added = r.models.filter((m) => !previous.has(m.id)).length;
  const removed = had.filter((m) => !r.models.some((x) => x.id === m.id)).length;
  const withWindow = p.models.filter((m) => m.context).length;
  state.setProvFetch = {
    ok: true,
    text:
      `${r.models.length} on the server · ${added} new · ${removed} removed` +
      (withWindow < p.models.length ? ` · ${p.models.length - withWindow} without a reported window` : ''),
  };
  wired.renderSettings();
}

export function selectProvider(index) {
  wired.collectSettings();
  state.setProvSelected = index;
  state.setKeyRevealed = false;
  state.setProvFetch = null;
  wired.renderSettings();
}
