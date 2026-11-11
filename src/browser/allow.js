// What SynaBrowse may touch.
//
// The allowlist is the fence, and it is a list of hosts the operator added on purpose:
// a page on any other host is refused with a sentence, not a permission card, because a
// card in an unattended run is a stall. A host matches itself and its subdomains —
// `example.com` allows `www.example.com` — and nothing else: no wildcard in the middle,
// no lookalike, no `..` climbing out of one host into another.
//
// `*` allows everything, and exists for the operator who wants to try the tool before
// deciding what to allow.

/** The host of a URL, lowercased, or '' when it is not http(s). */
export function hostOf(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    if (!/^https?:$/.test(parsed.protocol)) return '';
    return parsed.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    // Not a URL at all: there is no host, and the caller only needs to know that.
    return '';
  }
}

/** Is this host on the list? A listed host covers its own subdomains. */
export function hostAllowed(host, allow = []) {
  if (!host) return false;
  const list = (Array.isArray(allow) ? allow : [])
    .map((entry) => String(entry || '').trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
  if (list.includes('*')) return true;
  return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/**
 * May this page be opened? Answers the host and, when it may not, the sentence the model
 * is told — it has to be able to say to itself why, and what to ask for.
 */
export function checkUrl(url, allow = []) {
  const host = hostOf(url);
  if (!host) return { ok: false, host, reason: 'that is not an http(s) address' };
  if (hostAllowed(host, allow)) return { ok: true, host, reason: '' };
  return {
    ok: false,
    host,
    reason:
      `${host} is not on SynaBrowse's allowlist, so the harness will not open it. ` +
      'Ask the operator to add it in Settings > Browser, or do the work another way.',
  };
}
