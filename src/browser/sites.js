// The sites SynaBrowse has been signed into.
//
// Not a permission list: the harness's switch is what lets a model browse at all, and the
// operator's answer to "which sites" was "the ones I am logged into". So this is a record,
// the shape of the Prohibited table: a host, when it was signed in, and when it was last
// used. It is written by the sign-in flow and by nothing else — no model can add an entry,
// and a model cannot read one either.
//
// What it is honest about: **when a session expires is the site's decision.** A profile
// keeps its cookie until it expires or is cleared; nothing here guesses a lifetime, which
// is why the table shows an age rather than a countdown. "Sign In… again" is the refresh.

/** A host, lowercased, with no scheme, path or leading dot — or ''. */
export function cleanHost(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const bare = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/^\.+|\.+$/g, '');
  if (!bare || /[\s]/.test(bare)) return '';
  return bare.replace(/:\d+$/, '');
}

/**
 * A saved list, read back safely: hosts only, newest first, one entry per host.
 * A config written by hand may carry anything; nothing here throws.
 */
export function normalizeSites(list) {
  const seen = new Map();
  for (const entry of Array.isArray(list) ? list : []) {
    const host = cleanHost(entry?.host ?? entry);
    if (!host) continue;
    const signedInAt = Number(entry?.signedInAt) || 0;
    const lastUsedAt = Number(entry?.lastUsedAt) || 0;
    const prior = seen.get(host);
    seen.set(host, {
      host,
      signedInAt: Math.max(signedInAt, prior?.signedInAt || 0),
      lastUsedAt: Math.max(lastUsedAt, prior?.lastUsedAt || 0),
    });
  }
  return [...seen.values()].sort((a, b) => (b.signedInAt || b.lastUsedAt) - (a.signedInAt || a.lastUsedAt));
}

/** Record a sign-in: the host is added or refreshed, and stays one row. */
export function addSite(sites, host, at = Date.now()) {
  const key = cleanHost(host);
  if (!key) return normalizeSites(sites);
  const rest = normalizeSites(sites).filter((entry) => entry.host !== key);
  const prior = normalizeSites(sites).find((entry) => entry.host === key);
  return normalizeSites([{ host: key, signedInAt: at, lastUsedAt: prior?.lastUsedAt || 0 }, ...rest]);
}

/** Note that the browser opened a host this profile has a session for. */
export function touchSite(sites, host, at = Date.now()) {
  const key = cleanHost(host);
  if (!key) return normalizeSites(sites);
  const list = normalizeSites(sites);
  const prior = list.find((entry) => entry.host === key);
  if (!prior) return list;
  return normalizeSites(list.map((entry) => (entry.host === key ? { ...entry, lastUsedAt: at } : entry)));
}

/** Forget a host: the row goes, and the caller clears its session from the profile. */
export function forgetSite(sites, host) {
  const key = cleanHost(host);
  return normalizeSites(sites).filter((entry) => entry.host !== key);
}
