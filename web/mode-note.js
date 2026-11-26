// The yellow note a persona leaves in the chat when the mode changes.
//
// It is not a model message and it is not sent to the engine: the next brief
// carries the mode, and this only tells the operator what happened to the name.
// It stays until the next send or the next chat, and its Compact action uses the
// ordinary compaction flow.
import { state } from './state.js';
import { esc } from './format.js';

export function setModeNote(kind, persona = '') {
  state.modeNote = {
    at: Date.now(),
    kind: kind === 'on' ? 'on' : 'off',
    persona: String(persona || '').trim(),
  };
}

export function clearModeNote() {
  state.modeNote = null;
}

export function modeNoteHtml() {
  const note = state.modeNote;
  if (!note) return '';
  const name = note.persona;
  const off = note.kind === 'off';
  const text = off
    ? `${name ? `${name} was the Single-mode persona.` : 'The Single-mode persona was on.'} Compaction is recommended before continuing in Multi.`
    : `${name ? `${name} is back as the Single-mode persona.` : 'The Single-mode persona is back.'} Compaction is recommended for a clean context.`;
  const label = off ? 'persona off' : 'persona on';
  // An empty chat has no conversation to hand to the engine: keep the sentence,
  // but do not offer a button that would fail.
  const canCompact = (state.messages || []).some(
    (m) => m?.type === 'user' || m?.type === 'assistant' || m?.type === 'synthetic' || m?.error,
  );
  return `<div class="msg harness msg-mode-note" data-mode-note="1"><div class="msg-body">
        <span class="msg-role">Synapse · ${label}</span>
        <div class="msg-mode-text">${esc(text)}</div>
        ${canCompact ? '<button class="btn mode-note-compact" type="button" data-mode-compact="1">Compact</button>' : ''}
      </div></div>`;
}
