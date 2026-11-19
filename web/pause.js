// "Chat paused" — the freeze the operator cannot see, made impossible to miss.
//
// A selection inside the conversation holds the redraw back: the range lives in nodes that a
// redraw replaces, so the chat cannot be drawn while one rests. That was silent, and silent is
// worse than wrong — the conversation simply stopped being the conversation (19 Nov).
//
// Now the dock glows yellow, the same glow the Stop draws in red, and a bar at the top of the
// chat says why and offers the way out: one button clears the selection and the chat catches
// up. A question or a permission that arrives while the chat is paused is named in the bar,
// because those are the two things that cannot wait for the operator to finish reading.
//
// The bar is not a dialog and never takes focus: it is a sign on the door.

let node = null;
let title = null;
let detail = null;

/** Build the bar inside the dock. Called once, at boot, after the dock is in the page. */
export function installPause(dock, { onContinue } = {}) {
  if (!dock || node) return node;
  node = document.createElement('div');
  node.className = 'pause-notice';
  node.id = 'pauseNotice';
  node.hidden = true;
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  const mark = document.createElement('span');
  mark.className = 'pause-mark';
  mark.setAttribute('aria-hidden', 'true');
  const words = document.createElement('span');
  words.className = 'pause-text';
  title = document.createElement('strong');
  title.id = 'pauseTitle';
  detail = document.createElement('span');
  detail.id = 'pauseDetail';
  words.append(title, detail);
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'pause-go';
  go.id = 'pauseGo';
  go.textContent = 'Continue';
  go.title = 'Clear the selection and let the chat catch up';
  go.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (typeof onContinue === 'function') onContinue();
  });
  node.append(mark, words, go);
  dock.append(node);
  return node;
}

/**
 * Say why the chat is paused, and what is waiting for it.
 *
 * `reason` is `selection` (the operator is holding a selection) or `stopped` (they cut a turn
 * with the second Stop to read something). `updates` is how many draws were held, `waiting`
 * how many questions and permission cards are on screen waiting for an answer.
 */
export function showPause({ reason = 'selection', updates = 0, waiting = 0 } = {}) {
  if (!node) return;
  const stopped = reason === 'stopped';
  title.textContent = stopped ? 'Chat stopped' : 'Chat paused';
  const parts = [];
  parts.push(stopped ? 'held where you left it' : 'clear the selection to continue');
  if (updates > 0) parts.push(`${updates} update${updates === 1 ? '' : 's'} waiting`);
  if (waiting > 0) parts.push(`${waiting} question${waiting === 1 ? '' : 's'} waiting`);
  detail.textContent = ` — ${parts.join(' · ')}`;
  node.dataset.reason = reason;
  node.hidden = false;
  document.body.classList.add('is-paused');
}

/** The chat is drawing again: take the sign down. */
export function hidePause() {
  if (node) node.hidden = true;
  document.body.classList.remove('is-paused');
}

export const pauseShown = () => Boolean(node && !node.hidden);
