// Read a web page as text a model can use, with no dependencies.
//
// Why not the engine's own webfetch: it returns the page, and a model given 300 KB
// of GitHub HTML spends its turn reading navigation. Measured on 2 Nov from this
// machine — github.com/DarkDvr/Synapse came back as 302 KB of HTML with 11 KB of
// text in it, and the interesting part (the README) was a fraction of that.
//
// So this module has two halves, tried in this order:
//
//  1. A *site adapter* where the site publishes clean data. GitHub has an API and
//     raw files; X/Twitter has an oEmbed endpoint. Those cost one small request and
//     return exactly the thing the model asked for.
//  2. A *reader* for everything else: fetch the page, throw away scripts, styles,
//     navigation and forms, prefer <article>/<main>, and turn what is left into
//     markdown-ish text.
//
// It refuses rather than pretends. Reddit answers a bot challenge, x.com a 403 and
// 4pda a Cloudflare interstitial; the error says which wall it hit and what would
// get past it, because a model that is told "blocked, needs a logged-in session"
// can ask the operator, and a model handed an empty page cannot.

// The saved session, when the operator has one for this site. `cookieFor` is
// one-way on purpose: a cookie saved for a domain goes to it or its subdomains and
// nowhere else (src/site-sessions.js).
import { cookieFor } from './site-sessions.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class FetchError extends Error {
  constructor(message, { status = 0, blocked = false } = {}) {
    super(message);
    this.name = 'FetchError';
    this.status = status;
    this.blocked = blocked;
  }
}

const DEFAULT_MAX_CHARS = 14000;

/** Pages that are a challenge or a login wall, not content. Ordered by how often
 *  they were actually seen: Cloudflare, Reddit, X, and a generic 403 body. */
const WALLS = [
  { re: /just a moment\.\.\.|cf-browser-verification|challenge-platform/i, why: "the site's bot check (Cloudflare)" },
  { re: /prove your humanity|whoa there, pardner|blocked by network security/i, why: "the site's bot check (Reddit)" },
  { re: /access to x\.com was denied|you don't have the user rights to view this page/i, why: "x.com refusing a signed-out session" },
  { re: /enable javascript and cookies to continue|please enable js/i, why: 'a page that needs JavaScript' },
];

/** Hosts known to wall a signed-out reader, with the sentence a model can act on.
 *  A page that renders to nothing is indistinguishable from a broken site otherwise. */
const WALLED_HOSTS = [
  [/^(www\.)?reddit\.com$/i, 'Reddit answers a bot challenge to anonymous readers'],
  [/^(www\.)?x\.com$|^(www\.)?twitter\.com$/i, 'x.com refuses signed-out readers'],
  [/4pda\.(to|ru)$/i, '4pda shows a Cloudflare check and hides posts from guests'],
];

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—',
  ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', copy: '©', reg: '®',
  trade: '™', middot: '·', bull: '•', deg: '°', times: '×', rarr: '→', larr: '←',
};

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeChar(Number(dec)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

const safeChar = (code) => {
  try {
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  } catch {
    return '';
  }
};

/** Collapse runs of blank lines and trim each line. */
function tidy(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function absolute(href, base) {
  try {
    return new URL(decodeEntities(href), base).href;
  } catch {
    return '';
  }
}

/** Inline markup → one line of markdown. */
function inline(html, base) {
  let s = String(html);
  s = s.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => {
    const url = absolute(href, base);
    const label = tidy(text.replace(/<[^>]+>/g, '')).replace(/\n+/g, ' ');
    return url && label ? `[${label}](${url})` : label;
  });
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  s = s.replace(/<img\b[^>]*alt="([^"]*)"[^>]*>/gi, '[$1]');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

/** HTML → markdown-ish text. Not a full converter: paragraphs, headings, lists,
 *  quotes, code and links, which is what prose on the web is made of. */
export function htmlToText(html, base = '') {
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|svg|canvas|template|iframe|object)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<(nav|header|footer|aside|form|button|select|dialog)\b[\s\S]*?<\/\1>/gi, ' ');

  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (m, n, body) => `\n\n${'#'.repeat(Number(n))} ${inline(body, base)}\n\n`);
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (m, body) => `\n\n\`\`\`\n${decodeEntities(body.replace(/<[^>]+>/g, '')).trim()}\n\`\`\`\n\n`);
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (m, body) => `\n\n> ${inline(body, base)}\n\n`);
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (m, body) => `\n- ${inline(body, base)}`);
  // Paragraphs and plain containers go through the inline converter *before* the
  // catch-all strips their tags — otherwise a link or a bold run inside a paragraph
  // is lost, which is most of what a page's prose actually carries.
  s = s.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (m, body) => `\n\n${inline(body, base)}\n\n`);
  s = s.replace(/<div\b[^>]*>([\s\S]*?)<\/div>/gi, (m, body) => `\n\n${inline(body, base)}\n\n`);
  s = s.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (m, body) => {
    const cells = [...String(body).matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => inline(c[1], base));
    return cells.length ? `\n| ${cells.join(' | ')} |` : '';
  });
  s = s.replace(/<\/(p|div|section|article|main|ul|ol|table|tr|h[1-6])>/gi, '\n\n');
  s = s.replace(/<(p|div|section|article|main|ul|ol|table|tr)\b[^>]*>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, ' ');
  return tidy(decodeEntities(s));
}

/** The page's own title, for a reader that wants to know what it opened. */
function pageTitle(html) {
  const og = /<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i.exec(html);
  if (og) return decodeEntities(og[1]).trim();
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return t ? tidy(decodeEntities(t[1])) : '';
}

/**
 * The readable half of a page.
 *
 * The container choice is deliberately simple and explained by what it is for: a
 * model wants the prose, not the site's chrome. `<article>` and `<main>` are the
 * web's own statement of "this is the content"; where a page has neither, the body
 * is used after the boilerplate tags and the obvious asides are gone.
 */
export function extractReadable(html, url = '') {
  const title = pageTitle(html);
  const candidates = [
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<[^>]+role="main"[^>]*>([\s\S]*?)<\/[^>]+>/i,
  ];
  let best = '';
  for (const re of candidates) {
    const m = re.exec(html);
    if (m && m[1].length > 200) {
      best = m[1];
      break;
    }
  }
  const body = best || (/<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] || html);
  return { title, text: htmlToText(body, url) };
}

function wallFor(html, status) {
  const head = String(html).slice(0, 20000);
  for (const wall of WALLS) if (wall.re.test(head)) return wall.why;
  if (status === 403) return 'a 403 from the site';
  return '';
}

/** The wall a host is known for, when the page itself says nothing useful. */
function hostWall(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return ''; }
  for (const [re, why] of WALLED_HOSTS) if (re.test(host)) return why;
  return '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One retry for a *network* failure, never for an answer.
 *
 * Measured on 2 Nov: `raw.githubusercontent.com` failed once with a bare
 * "fetch failed" and answered 200 on the next call 5 seconds later. A 403 or a 404
 * is the site's answer and retrying it is just rudeness; a dropped connection is
 * not an answer at all.
 */
async function withRetry(fn, attempts = 2) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (err instanceof FetchError || err?.name === 'AbortError' || err?.name === 'TimeoutError') break;
      if (i + 1 < attempts) await sleep(400);
    }
  }
  throw last;
}

// ── site adapters ───────────────────────────────────────────────────────

const GITHUB_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)(?:\/(issues|pull|blob|tree)(?:\/([^?#]*))?)?\/?/i;

async function github(url, { fetchImpl, timeoutMs }) {
  const m = GITHUB_RE.exec(url);
  if (!m) return null;
  const [, owner, repoRaw, kind, rest] = m;
  const repo = repoRaw.replace(/\.git$/, '');
  const api = async (path) => {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      headers: { 'user-agent': UA, accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new FetchError(`GitHub API answered HTTP ${res.status} for ${path}`, { status: res.status });
    return res.json();
  };
  const raw = async (ref, path) => {
    const res = await fetchImpl(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new FetchError(`raw.githubusercontent.com answered HTTP ${res.status}`, { status: res.status });
    return res.text();
  };

  if (kind === 'issues' && !rest) {
    const list = await api(`/repos/${owner}/${repo}/issues?state=open&per_page=15`);
    const rows = (Array.isArray(list) ? list : [])
      .map((i) => `- #${i.number} ${i.title} (${i.state}, ${i.comments} comment(s))`)
      .join('\n');
    return { title: `${owner}/${repo} — open issues`, text: tidy(`# Open issues\n\n${rows || '(none)'}\n\nOpen one by its URL to read the body.`), source: 'github:issues' };
  }

  if (kind === 'issues' || kind === 'pull') {
    const n = String(rest || '').split('/')[0];
    const issue = await api(`/repos/${owner}/${repo}/issues/${n}`);
    const body = [
      `# ${issue.title} (#${issue.number})`,
      `${issue.state}${issue.locked ? ' · locked' : ''} · ${issue.user?.login || 'unknown'} · ${issue.comments || 0} comment(s)`,
      ...(Array.isArray(issue.labels) ? [`Labels: ${issue.labels.map((l) => (typeof l === 'string' ? l : l.name)).join(', ')}`] : []),
      '',
      issue.body || '(no description)',
    ].join('\n');
    return { title: `${issue.title} · ${owner}/${repo}#${issue.number}`, text: tidy(body), source: 'github:issue' };
  }

  if (kind === 'blob' || kind === 'tree') {
    const [ref, ...pathParts] = String(rest || '').split('/');
    const path = pathParts.join('/');
    if (kind === 'blob' && ref && path) {
      const text = await raw(ref, path);
      return { title: `${owner}/${repo}/${path}`, text: tidy(text).slice(0, 60000), source: 'github:file' };
    }
    const listing = await api(`/repos/${owner}/${repo}/contents/${path || ''}?ref=${encodeURIComponent(ref || '')}`);
    const rows = (Array.isArray(listing) ? listing : [])
      .map((e) => `${e.type === 'dir' ? 'dir ' : 'file'}  ${e.name}${e.size ? `  (${e.size} B)` : ''}`)
      .join('\n');
    return { title: `${owner}/${repo}/${path || ''}`, text: `${rows}\n\n(listing only — open a file to read it)`, source: 'github:dir' };
  }

  // A repository page: the README and the facts, not the HTML around them.
  const info = await api(`/repos/${owner}/${repo}`);
  let readme = '';
  try {
    const md = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/readme`, {
      headers: { 'user-agent': UA, accept: 'application/vnd.github.raw' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (md.ok) readme = await md.text();
  } catch { /* a repo without a README is still worth reporting */ }
  const head = [
    `# ${info.full_name}`,
    info.description || '',
    '',
    `- language: ${info.language || 'unknown'}`,
    `- stars: ${info.stargazers_count} · forks: ${info.forks_count} · open issues: ${info.open_issues_count}`,
    `- licence: ${info.license?.spdx_id || 'none stated'}`,
    info.topics?.length ? `- topics: ${info.topics.join(', ')}` : '',
    `- default branch: ${info.default_branch}`,
    info.homepage ? `- homepage: ${info.homepage}` : '',
    '',
  ].filter(Boolean).join('\n');
  return { title: `${info.full_name} — ${info.description || 'GitHub repository'}`, text: tidy(`${head}\n${readme}`), source: 'github:repo' };
}

const X_STATUS_RE = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status(?:es)?\/(\d+)/i;

async function xPost(url, { fetchImpl, timeoutMs }) {
  const m = X_STATUS_RE.exec(url);
  if (!m) return null;
  const res = await fetchImpl(`https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=1`, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new FetchError(`x.com did not give this post to a signed-out reader (oEmbed HTTP ${res.status})`, { status: res.status, blocked: true });
  }
  const data = await res.json();
  return {
    title: `${data.author_name} (@${String(data.author_url || '').split('/').pop()})`,
    text: `${htmlToText(data.html || '')}\n\n(posted ${data.author_name || ''})`,
    source: 'x:oembed',
  };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Follow redirects by hand while a cookie is attached, so the cookie never travels
 * to a host it was not saved for. Without this, `redirect: 'follow'` would carry the
 * header to whatever site the first hop names — a credential leak dressed as a
 * convenience.
 */
async function fetchGuarded(startUrl, { fetchImpl, timeoutMs, headers, allowedHost, cookie }) {
  let url = startUrl;
  for (let hop = 0; hop <= 5; hop += 1) {
    const here = new URL(url).hostname;
    const res = await fetchImpl(url, {
      headers: { ...headers, cookie },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!REDIRECTS.has(res.status)) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    const next = new URL(location, url).href;
    const nextHost = new URL(next).hostname;
    if (!(nextHost === allowedHost || nextHost.endsWith(`.${allowedHost}`))) {
      throw new FetchError(
        `${startUrl} redirected to ${nextHost}, which is not the site the saved session belongs to (${allowedHost}), so the session was not sent there.`,
        { blocked: true },
      );
    }
    url = next;
    void here;
  }
  throw new FetchError(`${startUrl} redirected too many times.`);
}

/**
 * Fetch a URL as text.
 *
 * @param {string} url
 * @param {{timeoutMs?: number, maxChars?: number, fetchImpl?: typeof fetch, sessions?: object}} opts
 *   `fetchImpl` exists so the tests can serve fixtures instead of the network;
 *   `sessions` is the saved cookie map, and only the entry for this host is used.
 */
export async function webFetch(url, { timeoutMs = 20000, maxChars = DEFAULT_MAX_CHARS, fetchImpl = fetch, sessions = {} } = {}) {
  const target = String(url || '').trim();
  if (!target) throw new FetchError('empty URL');
  const withScheme = /^https?:\/\//i.test(target) ? target : `https://${target}`;

  const viaGithub = await withRetry(() => github(withScheme, { fetchImpl, timeoutMs })).catch((err) => {
    if (err instanceof FetchError) throw err;
    throw new FetchError(`could not read GitHub: ${err.message}`);
  });
  if (viaGithub) return finish(withScheme, viaGithub, maxChars);

  const viaX = await withRetry(() => xPost(withScheme, { fetchImpl, timeoutMs }));
  if (viaX) return finish(withScheme, viaX, maxChars);

  const headers = {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
  };
  // Only this host's own session, never a neighbour's.
  let saved = null;
  try { saved = cookieFor(new URL(withScheme).hostname, sessions); } catch { saved = null; }

  const res = saved
    ? await withRetry(() => fetchGuarded(withScheme, { fetchImpl, timeoutMs, headers, allowedHost: saved.host, cookie: saved.cookie }))
    : await withRetry(() => fetchImpl(withScheme, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    }));
  const type = String(res.headers.get('content-type') || '').toLowerCase();
  const body = await res.text();

  if (!res.ok) {
    const why = wallFor(body, res.status) || hostWall(withScheme);
    const withSession = saved ? ` Your saved session for ${saved.host} was sent and the site still refused it — it may have expired, or be tied to a different browser.` : '';
    throw new FetchError(
      why
        ? `${withScheme} is behind ${why}.${withSession || ' A signed-in browser session would be needed; this fetch has none.'}`
        : `${withScheme} answered HTTP ${res.status}`,
      { status: res.status, blocked: Boolean(why) },
    );
  }
  if (type.includes('application/json')) {
    return finish(withScheme, { title: withScheme, text: prettyJson(body), source: 'json' }, maxChars);
  }
  if (type.includes('text/plain')) {
    return finish(withScheme, { title: withScheme, text: tidy(body), source: 'text' }, maxChars);
  }

  const wall = wallFor(body, res.status);
  if (wall) {
    const withSession = saved ? ` Your saved session for ${saved.host} was sent and the site still refused it.` : '';
    throw new FetchError(
      `${withScheme} is behind ${wall}.${withSession || ' A signed-in browser session would be needed; this fetch has none.'}`,
      { status: res.status, blocked: true },
    );
  }

  const { title, text } = extractReadable(body, withScheme);
  if (!text || text.length < 80) {
    const host = hostWall(withScheme);
    throw new FetchError(
      host
        ? `${withScheme} renders to nothing for a signed-out reader: ${host}.${saved ? ' Your saved session was sent, so it has probably expired.' : ' This needs a browser session that is signed in; Synapse has none for this site.'}`
        : `${withScheme} returned a page with almost no readable text (${text.length} characters) — it is probably built by JavaScript.`,
      { blocked: Boolean(host) },
    );
  }
  return finish(withScheme, { title: title || withScheme, text, source: saved ? 'readability+session' : 'readability' }, maxChars);
}

function prettyJson(body) {
  try {
    return tidy(JSON.stringify(JSON.parse(body), null, 2));
  } catch {
    return tidy(body);
  }
}

function finish(url, { title, text, source }, maxChars) {
  const clean = tidy(text);
  const truncated = clean.length > maxChars;
  return {
    url,
    title: tidy(title || ''),
    source,
    text: truncated ? `${clean.slice(0, maxChars)}\n\n[…truncated at ${maxChars} characters]` : clean,
    chars: clean.length,
    truncated,
  };
}

/** One block of text for a model, with the provenance a reader needs to trust it. */
export function formatPage(page) {
  const head = [`# ${page.title || page.url}`, page.url, `(${page.source}, ${page.chars} characters${page.truncated ? ', truncated' : ''})`];
  return `${head.join('\n')}\n\n${page.text}`;
}
