// The stream model: one text buffer and the pane that shows it.
//
// This file used to hold the whole slide machinery — a feed-forward spring, an
// adoption pass, a trim buffer. All of that moved into thinking-pane.js on 9 Nov,
// rewritten from scratch after the pane could not be trusted. What is left is the
// one shape both use: a stream.
export function newStream(kind) {
  return {
    kind,
    text: '',
    shown: 0,
    offset: 0,
    target: 0,
    velocity: 0,
    ended: false,
    folded: false,
    trimmed: false,
    dirty: false,
    settled: true,
    snap: false,
    total: 0,
  };
}
