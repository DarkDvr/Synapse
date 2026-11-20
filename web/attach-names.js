// Names for pictures pasted from the clipboard.
//
// A screenshot on the clipboard arrives as `image.png`, and six of them are six identical
// names: a post cannot say "see pic 2" and mean anything, and a model reading the message
// sees six `image.png` files it cannot tell apart either. The pasted ones are named pic1,
// pic2, ... in the order they were added — short, ordered, and the same word the operator
// already uses in the sentence.
//
// A file the operator picked from disk keeps its own name: `mock-2.html` is a fact about
// the file, and renaming it would be the harness editing the operator's words.

/** The names a clipboard or a screenshot produces, never a name a person chose.
 *  `picN` is in the list as well, so renumbering after a removal closes the gap
 *  instead of leaving pic1 and pic3. */
const GENERIC = /^(?:(?:image|pasted-image|blob|clipboard|screenshot|attachment)|pic\d+)(?:[ _-]?(?:\(\d+\)|\d+))?(?:\.(?:png|jpe?g|webp|gif|bmp))?$/i;

/** Is this name one the machine made up? */
export function isPastedImageName(name) {
  return GENERIC.test(String(name || '').trim());
}

/**
 * Rename the pasted pictures in `list` to pic1..picN, in place and in order.
 *
 * Numbering counts only the pasted ones, so attaching `logo.png` first does not push the
 * first screenshot to pic2. Called after an attachment is added and after one is removed,
 * so the numbers stay contiguous: the chips and the sentence agree.
 */
export function namePasted(list = []) {
  let n = 0;
  for (const file of Array.isArray(list) ? list : []) {
    const name = String(file?.name || '');
    if (!isPastedImageName(name)) continue;
    n += 1;
    const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] || 'png').toLowerCase();
    file.name = `pic${n}.${ext}`;
  }
  return list;
}
