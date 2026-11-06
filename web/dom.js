// The two DOM helpers every screen needs.
//
// `$` was a one-liner at the top of app.js, which meant every module that came out
// of app.js had to be handed it or grow its own. It is its own module now, so a
// screen imports the same lookup instead of a copy.

/** The element with this id, or null. */
export const $ = (id) => document.getElementById(id);

/** Run `fn` once the calls stop for `ms`. */
export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
