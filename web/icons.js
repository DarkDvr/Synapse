// The little line icons the Settings tabs use, and the wrapper that draws one.
//
// They were a 24-line object in the middle of app.js beside the pane that used
// them. Pure markup: a name in, an SVG string out, no state and no DOM.
export const ICONS = {
  sliders:
    '<path d="M2 5h6.4M11.4 5H14M2 11h3.4M8.4 11H14"/><circle cx="9.9" cy="5" r="1.5"/><circle cx="6.9" cy="11" r="1.5"/>',
  engine:
    '<rect x="3.6" y="3.6" width="8.8" height="8.8" rx="2"/><path d="M6.2 1.9v1.7M9.8 1.9v1.7M6.2 12.4v1.7M9.8 12.4v1.7M1.9 6.2h1.7M1.9 9.8h1.7M12.4 6.2h1.7M12.4 9.8h1.7"/>',
  plug: '<path d="M5.3 1.9v3.3M10.7 1.9v3.3"/><path d="M3.7 5.2h8.6v1.9a4.3 4.3 0 0 1-8.6 0z"/><path d="M8 11.4v2.6"/>',
  nodes:
    '<circle cx="8" cy="3.1" r="1.6"/><circle cx="3.5" cy="12.3" r="1.6"/><circle cx="12.5" cy="12.3" r="1.6"/><path d="M8 4.7v3M8 7.7 4.6 11M8 7.7 11.4 11"/>',
  tools:
    '<path d="M2.5 9.5h2.8l1 1.9h3.4l1-1.9h2.8"/><rect x="2.5" y="2.9" width="11" height="10.3" rx="2"/>',
  bell:
    '<path d="M8 2.1a3.7 3.7 0 0 0-3.7 3.7c0 3-1.2 4.1-1.2 4.1h9.8s-1.2-1.1-1.2-4.1A3.7 3.7 0 0 0 8 2.1z"/><path d="M6.6 12.4a1.5 1.5 0 0 0 2.8 0"/>',
  lines: '<path d="M2.7 4.1h10.6M2.7 8h10.6M2.7 11.9h6.2"/>',
  eye: '<path d="M1.7 8S4 3.9 8 3.9 14.3 8 14.3 8 12 12.1 8 12.1 1.7 8 1.7 8z"/><circle cx="8" cy="8" r="1.9"/>',
  eyeOff:
    '<path d="M2.3 9.3C3.6 6.4 5.6 5 8 5s4.4 1.4 5.7 4.3"/><path d="M4 11.2 2.7 12.9M8 10.3v2.3M12 11.2 13.3 12.9"/>',
  refresh:
    '<path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7"/><path d="M13.2 2.6V5.4h-2.8"/>',
  info: '<circle cx="8" cy="8" r="6.1"/><path d="M8 7.4v4.1"/><path d="M8 4.9h.01"/>',
  general:
    '<rect x="2.4" y="2.9" width="11.2" height="10.2" rx="2"/><path d="M2.4 6.2h11.2"/><path d="M5 4.6h.01M6.6 4.6h.01"/>',
  automation: '<path d="M8.6 1.6 3.2 9h3.4l-.8 5.4L11.2 7H7.8z"/>',
  shield: '<path d="M8 1.9 13 3.7v4.1c0 3.2-2.1 5.5-5 6.5-2.9-1-5-3.3-5-6.5V3.7z"/><path d="M5.9 7.9 7.4 9.4l2.8-2.9"/>',
};

export const setIcon = (name) =>
  `<svg class="set-ic" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" ` +
  `stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
