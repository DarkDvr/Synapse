#!/usr/bin/env node
// Render an HTML file or URL, measure it, and answer questions about it — with Edge.
//
// Why a script and not a pile of flags in the skill text: browser discovery,
// quoting, a throwaway profile, a local server and waiting for the file to land are
// all things a model gets wrong once and then works around badly. One command, one
// JSON line per width, one picture to look at.
//
//   shot.mjs <file|url> [--widths 1280,390] [--height 900]
//   shot.mjs <file|url> --eval "document.body.scrollWidth"
//   shot.mjs <file|url> --do "click:#start; wait:600" --widths 390
//
// Four things here exist because of how Timer Test 1 went wrong:
//
//  * **It refuses what it cannot do.** An option it does not know used to fall
//    through to the target, so `--help` photographed a file called `--help`, wrote
//    `--help-1280.png` — a picture of the browser's error page — and exited 0.
//    Three runs believed it had worked.
//  * **It serves the page itself.** Agents kept writing their own static servers
//    (`qc-serve.js`, `python -m http.server`) and leaving them running, because
//    `file://` cannot test localStorage or a reload. The server lives in this
//    process and dies with it.
//  * **It measures, so nobody has to guess.** Each width comes back with a report:
//    what overflows, contrast below WCAG, controls too small to hit, whether the
//    page painted anything at all. A model cannot misread "2.3:1".
//  * **One picture, not five.** Two widths become one contact sheet, so the narrow
//    and wide versions are compared in a single look instead of two.
//
// Everything goes through the DevTools protocol, screenshots included, for one
// reason: `--window-size` does not set the *layout* viewport in headless Edge. A
// "390px" shot was laid out at 492px and cropped to 390 — so every mobile review
// judged a page that was never 390 wide. `Emulation.setDeviceMetricsOverride` sets
// the viewport for real.
//
// No dependencies: Node ships `fetch` and `WebSocket`, and Edge already exists on a
// Windows box. If it is not found we exit 2 and say so rather than pretend.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Edge, and only Edge. The machine's default browser is Brave, and touching Brave
// resets the operator's profile; Chrome is not chosen on their behalf either. One
// named engine, or a clear refusal.
const BROWSERS = [
  process.env.VISUAL_REVIEW_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

const fail = (code, message) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

// Even an explicit override may not point at Brave: the point of the rule is that
// an agent in a hurry cannot opt back in.
if (/brave/i.test(process.env.VISUAL_REVIEW_BROWSER || '')) {
  fail(
    2,
    "Brave is never launched: touching it resets the operator's profile. Point VISUAL_REVIEW_BROWSER at Edge, or unset it.",
  );
}

const USAGE = `Usage: shot.mjs <file|url> [options]

  --widths 1280,390     widths to capture (default 1280)
  --height 900          viewport height
  --out DIR             where the PNGs go (default .synapse/design/shots)
  --do "steps"          before the capture, per width:
                          click:#start   wait:600   key:s   eval:<js>
  --expect "sel|regex"   fail unless that element's RENDERED text matches
  --audit               print the layout findings and exit 1 if there are any
                          (every run reports them in "layout" either way)
  --diff MOCK.png       compare the render against a saved mock, at the mock's own
                          size; reports the percentage and the regions that differ
  --diff-threshold N    per-pixel difference that counts as a change (default 16)
  --fail-over PCT       exit 1 when more than PCT percent of the picture differs
  --file                keep the page on file:// (default: serve it over http)
  --no-sheet            do not build the contact sheet
  --eval "<js>"         answer one expression instead of taking a picture
  --help                this text`;

function parseArgs(argv) {
  const out = {
    target: '',
    outDir: path.resolve('.synapse/design/shots'),
    widths: [1280],
    height: 900,
    evalExpr: '',
    expect: [],
    audit: false,
    steps: [],
    serve: true,
    sheet: true,
    diff: '',
    diffThreshold: 16,
    failOver: null,
    widthsGiven: false,
    help: false,
    unknown: '',
    extra: [],
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.outDir = path.resolve(argv[++i] || '');
    else if (a === '--eval') out.evalExpr = String(argv[++i] || '');
    // A rendered string is the only honest test of a control: an attribute can say
    // "en-GB" and the browser still draws 12-hour US time. See --expect below.
    else if (a === '--expect') out.expect.push(String(argv[++i] || ''));
    else if (a === '--do') {
      out.steps = String(argv[++i] || '')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === '--widths') {
      out.widths = String(argv[++i] || '')
        .split(',')
        .map((w) => Number.parseInt(w, 10))
        .filter((w) => Number.isFinite(w) && w > 0);
      out.widthsGiven = true;
    } else if (a === '--height') out.height = Number.parseInt(argv[++i], 10) || 900;
    else if (a === '--audit') out.audit = true;
    else if (a === '--diff') out.diff = String(argv[++i] || '');
    else if (a === '--diff-threshold') out.diffThreshold = Number.parseInt(argv[++i], 10);
    else if (a === '--fail-over') out.failOver = Number.parseFloat(argv[++i]);
    else if (a === '--file') out.serve = false;
    else if (a === '--no-sheet') out.sheet = false;
    else if (a === '--help' || a === '-h') out.help = true;
    // An option this script does not have is not a file to photograph.
    else if (a.startsWith('-') && a !== '-') out.unknown = a;
    else rest.push(a);
  }
  out.target = rest[0] || '';
  out.extra = rest.slice(1);
  if (!out.widths.length) out.widths = [1280];
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (args.unknown) fail(1, `shot.mjs: no such option: ${args.unknown}\n${USAGE}`);
if (args.extra.length) fail(1, `shot.mjs: one target at a time, got "${args.extra.join('", "')}"\n${USAGE}`);
if (!args.target) fail(1, USAGE);
// A malformed --expect is a typo, not a page problem: refuse it before a browser
// is launched, the same way an unknown option is refused.
for (const want of args.expect) {
  const at = want.indexOf('|');
  if (at < 1 || !want.slice(at + 1).trim()) {
    fail(1, `shot.mjs: --expect needs "selector|regex", got "${want}"\n${USAGE}`);
  }
}

const isUrl = /^[a-z]+:\/\//i.test(args.target);
const localFile = isUrl ? '' : path.resolve(args.target);
// A file that is not there cannot be rendered. Saying so is the whole point: the
// browser would happily render its own error page and call that a screenshot.
if (!isUrl && !fs.existsSync(localFile)) fail(1, `shot.mjs: no such file: ${localFile}`);

// --diff compares a render against a saved mock. The mock is read before a browser
// starts, because a wrong path is a typo and not a page: the same rule as an
// unknown option. Its pixel size is the size the build must be rendered at —
// two pictures taken at different widths compare two layouts, not one design.
let mock = null;
if (args.diff) {
  if (args.evalExpr) fail(1, 'shot.mjs: --diff compares a render, so it cannot be combined with --eval');
  const mockPath = path.resolve(args.diff);
  if (!fs.existsSync(mockPath)) fail(1, `shot.mjs: no such file: ${mockPath}`);
  try {
    mock = pngSize(mockPath);
  } catch (err) {
    fail(1, `shot.mjs: --diff needs a PNG: ${err.message}`);
  }
  mock.path = mockPath;
  mock.threshold = Number.isFinite(args.diffThreshold) && args.diffThreshold >= 0 ? args.diffThreshold : 16;
  if (args.widthsGiven && args.widths.some((w) => w !== mock.width)) {
    fail(
      1,
      `shot.mjs: --diff compares at the mock's size (${mock.width}px); --widths asked for ${args.widths.join(',')}`,
    );
  }
  args.widths = [mock.width];
  args.height = mock.height;
}
if (args.failOver !== null && !(args.failOver >= 0)) {
  fail(1, 'shot.mjs: --fail-over needs a percentage, e.g. --fail-over 2');
}

const browser = BROWSERS.find((p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
});
if (!browser) {
  fail(2, 'No Edge found. Review the HTML/CSS structurally and say you did not see it rendered.');
}

/**
 * Serve the page's own folder, so the page has a real http origin.
 *
 * `file://` is not a web page: localStorage is per-file and often blocked, a
 * reload behaves differently, and relative fetches fail. That is why agents kept
 * writing their own servers — and leaving them running. This one is in-process and
 * closes when the script does.
 */
async function serveFolder(file) {
  const dir = path.dirname(file);
  const page = path.basename(file);
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.woff2': 'font/woff2',
    '.ico': 'image/x-icon',
  };
  const server = http.createServer((req, res) => {
    const asked = decodeURIComponent(String(req.url || '/').split('?')[0]);
    const rel = asked === '/' || asked === '' ? page : asked.replace(/^\/+/, '');
    const file2 = path.join(dir, rel);
    if (!file2.toLowerCase().startsWith(dir.toLowerCase())) {
      res.writeHead(403);
      res.end('outside the folder');
      return;
    }
    fs.readFile(file2, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': types[path.extname(file2).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/${encodeURIComponent(page)}`,
    close: () => new Promise((res) => server.close(res)),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * What is wrong with this page, in numbers.
 *
 * Runs inside the loaded page at the width that was asked for. Everything a model
 * would otherwise have to *guess* from a picture: an element wider than the
 * viewport, text below WCAG contrast, a control too small to hit, a page that
 * painted nothing.
 */
const REPORT_JS = `(() => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const out = {
    status: (performance.getEntriesByType('navigation')[0] || {}).responseStatus ?? null,
    viewport: { w: vw, h: window.innerHeight },
    doc: { scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight },
    painted: { elements: 0, textChars: 0, images: 0 },
    overflow: [],
    overlaps: [],
    small: [],
    contrast: [],
    focusables: 0,
  };
  const desc = (el) => {
    const cls = String(el.className || '').trim().split(/\\s+/).filter(Boolean).slice(0, 2).join('.');
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '');
  };
  const style = (el) => getComputedStyle(el);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = style(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
  };
  const all = Array.from(document.querySelectorAll('body *'));
  out.painted.elements = all.filter(visible).length;
  out.painted.textChars = (document.body.innerText || '').trim().length;
  out.painted.images = Array.from(document.images).filter(visible).length;

  for (const el of all) {
    if (out.overflow.length >= 6) break;
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) {
      out.overflow.push({ el: desc(el), left: Math.round(r.left), right: Math.round(r.right) });
    }
  }

  // Two controls on top of each other are invisible to an overflow test: neither
  // leaves the viewport, and the picture looks like a layout somebody chose. This
  // is the check the Designer had to invent by hand after two rejections — Save
  // sitting on the Amount input at 1024. Ancestors and descendants are skipped (a
  // label inside its row is not a collision), and so are fixed/absolute boxes,
  // which are supposed to sit over the flow.
  const boxes = all.filter((el) => {
    if (!visible(el)) return false;
    if (el === document.body || el === document.documentElement) return false;
    const s = style(el);
    if (s.position === 'fixed' || s.position === 'absolute') return false;
    if (el.closest('details:not([open])')) return false;
    const own = (el.textContent || '').trim();
    const interactive = el.matches('button,a[href],input,select,textarea,[role="button"]');
    return interactive || own.length > 0;
  });
  const hits = new Set();
  for (let i = 0; i < boxes.length && out.overlaps.length < 6; i += 1) {
    const a = boxes[i];
    const ra = a.getBoundingClientRect();
    if (ra.width < 4 || ra.height < 4) continue;
    for (let j = i + 1; j < boxes.length && out.overlaps.length < 6; j += 1) {
      const b = boxes[j];
      if (a.contains(b) || b.contains(a)) continue;
      const rb = b.getBoundingClientRect();
      if (rb.width < 4 || rb.height < 4) continue;
      // Siblings share an edge by design; only real intersection counts.
      const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (x <= 1 || y <= 1) continue;
      const key = desc(a) + '|' + desc(b);
      if (hits.has(key)) continue;
      hits.add(key);
      out.overlaps.push({ a: desc(a), b: desc(b), w: Math.round(x), h: Math.round(y) });
    }
  }

  const clickable = all.filter(
    (el) => visible(el) && el.matches('button,a[href],input,select,textarea,[role="button"],[tabindex]:not([tabindex="-1"])'),
  );
  out.focusables = clickable.length;
  const off = (el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true';
  for (const el of clickable) {
    if (out.small.length >= 6) break;
    if (off(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 44 || r.height < 44) out.small.push({ el: desc(el), w: Math.round(r.width), h: Math.round(r.height) });
  }

  const lum = (rgb) => {
    const c = rgb.map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const parse = (value) => {
    const m = String(value || '').match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map((n) => Number(n.trim()));
    return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 };
  };
  const bgOf = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const c = parse(style(node).backgroundColor);
      if (c && c.a > 0.9) return c.rgb;
      node = node.parentElement;
    }
    return [255, 255, 255];
  };
  // Dimming is often done with opacity rather than a paler colour, and an element
  // at 40% is as hard to read as one painted grey. Fold the ancestors' opacity in.
  const fadedBy = (el) => {
    let a = 1;
    let node = el;
    while (node && node !== document.documentElement) {
      a *= Number(style(node).opacity);
      node = node.parentElement;
    }
    return Number.isFinite(a) ? a : 1;
  };
  for (const el of all) {
    if (out.contrast.length >= 6) break;
    if (!visible(el)) continue;
    // A control that cannot be used is exempt from the contrast rule: a greyed-out
    // Reset is *meant* to be hard to read.
    if (off(el)) continue;
    // One character counts: a shortcut chip reading "S" is a label too.
    const ownText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length >= 1);
    if (!ownText) continue;
    const fg = parse(style(el).color);
    if (!fg) continue;
    const bg = bgOf(el);
    const faded = fadedBy(el);
    const painted = fg.rgb.map((v, i) => v * faded + bg[i] * (1 - faded));
    const l1 = lum(painted);
    const l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = Number.parseFloat(style(el).fontSize) || 16;
    const bold = (Number.parseInt(style(el).fontWeight, 10) || 400) >= 700;
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    if (ratio < need) {
      out.contrast.push({
        el: desc(el),
        text: (el.textContent || '').trim().slice(0, 28),
        ratio: Math.round(ratio * 100) / 100,
        need,
        faded: faded < 1 ? Math.round(faded * 100) / 100 : undefined,
      });
    }
  }
  // ── layout: the things a picture cannot prove ──────────────────────────
  // A designer looks at the render and reads "centred", "the same size", "one
  // column", "one line". Those are numbers, not opinions, and three of them are the
  // defects the operator had to point at by hand (1 Nov): Stop 4px shorter than
  // Pause, two labels on one line with different baselines, and a header block
  // indented 12px from every row under it. Measure them instead of looking.
  const findings = [];
  const seen = new Set();
  // One line per defect, not one per element it happens to repeat on: an archive
  // list of 500 rows has the same 1px step in every row, and 500 findings is a
  // report nobody reads. Six of each kind is enough to see the pattern.
  const add = (f) => {
    const key = f.check + '|' + f.el + '|' + (f.vs || '');
    if (seen.has(key)) return;
    if (findings.filter((x) => x.check === f.check).length >= 6) return;
    if (findings.length >= 24) return;
    seen.add(key);
    findings.push(f);
  };
  const r1 = (n) => Math.round(n * 10) / 10;
  const num = (v) => Number.parseFloat(v) || 0;
  const textRects = (el) => {
    const rects = [];
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !String(n.textContent || '').trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const rect of range.getClientRects()) if (rect.width > 0.5 && rect.height > 0.5) rects.push(rect);
    }
    return rects;
  };
  const union = (rects) => {
    if (!rects.length) return null;
    return rects.reduce((a, r) => ({
      left: Math.min(a.left, r.left), right: Math.max(a.right, r.right),
      top: Math.min(a.top, r.top), bottom: Math.max(a.bottom, r.bottom),
    }), { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
  };
  // The baseline, in the only way a browser will tell you: an empty inline-block is
  // placed so its bottom edge sits on the baseline of the line it is in.
  const baselineOf = (el) => {
    const first = Array.from(el.childNodes).find((n) => n.nodeType === 3 && String(n.textContent || '').trim());
    if (!first) return null;
    const probe = document.createElement('span');
    probe.setAttribute('style', 'display:inline-block;width:0;height:0;vertical-align:baseline');
    first.parentNode.insertBefore(probe, first.nextSibling);
    const b = probe.getBoundingClientRect().bottom;
    probe.remove();
    return b;
  };

  const controlSel = 'button,a[href],input[type=button],input[type=submit],[role="button"]';
  const controls = all.filter((el) => visible(el) && el.matches(controlSel));

  // What is on top at an element's centre. Inside a dialog that is the element (or a
  // child of it); behind a dialog it is the backdrop, which makes it a different
  // "layer". Two controls either side of an overlay share a y and are not a row —
  // measured on Synapse's own Settings, whose footer button lined up with the
  // sidebar's when the pane grew. It is the browser's own hit test, so no page has
  // to name its overlay anything in particular.
  const layerOf = (el) => {
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(vw - 1, r.left + r.width / 2));
    const y = Math.max(0, Math.min(vh - 1, r.top + r.height / 2));
    let top = null;
    try { top = document.elementFromPoint(x, y); } catch { return null; }
    if (!top || top === el || el.contains(top)) return null;
    return top;
  };

  // 1. Controls in one row: one height, one top. A row is a set of controls that
  //    overlap vertically *and* sit within a button-gap of each other — the sidebar's
  //    project button and the main pane's New Project share a y by accident, and two
  //    panes are not a toolbar. An icon button half the height of the text button
  //    beside it is a different control, not a mis-sized one: heights within 40% of
  //    each other are the ones that read as "should match".
  const rows = [];
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    const layer = layerOf(el);
    const row = rows.find((x) => {
      if (x.layer !== layer) return false;
      const o = x.box;
      const overlap = Math.min(o.bottom, r.bottom) - Math.max(o.top, r.top);
      if (overlap <= Math.min(o.height, r.height) * 0.5) return false;
      const gap = Math.max(0, Math.max(o.left, r.left) - Math.min(o.right, r.right));
      return gap <= 24;
    });
    if (row) row.items.push(el);
    else rows.push({ layer, box: { top: r.top, bottom: r.bottom, height: r.height, left: r.left, right: r.right }, items: [el] });
  }
  for (const row of rows) {
    if (row.items.length < 2) continue;
    const first = row.items[0].getBoundingClientRect();
    for (const el of row.items.slice(1)) {
      const r = el.getBoundingClientRect();
      const dh = r1(Math.abs(r.height - first.height));
      const dt = r1(Math.abs(r.top - first.top));
      const ratio = Math.max(r.height, first.height) / Math.max(1, Math.min(r.height, first.height));
      const sameFamily = ratio <= 1.4;
      if ((sameFamily && dh >= 2) || (dh < 2 && dt >= 2)) {
        add({
          check: 'controls-row',
          el: desc(el),
          vs: desc(row.items[0]),
          px: { dHeight: dh, dTop: dt },
          detail: 'height ' + r1(r.height) + ' vs ' + r1(first.height) + ', tops ' + dt + 'px apart',
        });
      }
    }
  }

  // 2. A control's label sits in the middle of the box it draws. Half a pixel is
  //    padding; more than one is a visible lean, which is what "not quite centred"
  //    is when you look at it.
  for (const el of controls) {
    // An icon beside the label is a group, not one centred word: skip those.
    if (el.children.length) continue;
    const t = union(textRects(el));
    if (!t) continue;
    const b = el.getBoundingClientRect();
    const cs = style(el);
    const inner = {
      left: b.left + num(cs.paddingLeft) + num(cs.borderLeftWidth),
      right: b.right - num(cs.paddingRight) - num(cs.borderRightWidth),
      top: b.top + num(cs.paddingTop) + num(cs.borderTopWidth),
      bottom: b.bottom - num(cs.paddingBottom) - num(cs.borderBottomWidth),
    };
    const dx = r1((t.left + t.right) / 2 - (inner.left + inner.right) / 2);
    const dy = r1((t.top + t.bottom) / 2 - (inner.top + inner.bottom) / 2);
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      add({
        check: 'control-label',
        el: desc(el),
        text: String(el.textContent || '').trim().slice(0, 24),
        px: { dx, dy },
        detail: 'label ' + Math.abs(dx) + 'px ' + (dx < 0 ? 'left' : 'right') + ' of centre, ' +
          Math.abs(dy) + 'px ' + (dy < 0 ? 'high' : 'low'),
      });
    }
  }

  // 3. Text on one line shares one baseline — not one box. Two 12px runs, one in a
  //    mono and one in a sans, have line boxes that agree and baselines that do not;
  //    that 1px step under "182.0 MB / Open page" is this check. Only runs of the
  //    same size are compared: a small unit beside a big number is a deliberate pair,
  //    and a control's own label is centred by rule, not by baseline.
  const leaves = all.filter((el) => visible(el) && el.children.length === 0 && String(el.textContent || '').trim());
  const byParent = new Map();
  for (const el of leaves) {
    if (!el.parentElement) continue;
    const list = byParent.get(el.parentElement) || [];
    list.push(el);
    byParent.set(el.parentElement, list);
  }
  for (const list of byParent.values()) {
    if (list.length < 2 || list.length > 8) continue;
    const metas = [];
    for (const el of list) {
      if (el.matches(controlSel)) continue; // a button's label is a different rule
      // A flex or grid box lays its children out as items, so an inline-block
      // inserted after the text becomes an item of its own and reports the container's
      // edge instead of the baseline (measured: a flex anchor beside a block span on
      // one line read 5px apart while their text rects were identical). Those are
      // skipped rather than mis-measured.
      if (/^(inline-)?(flex|grid)$/.test(style(el).display)) continue;
      const rect = union(textRects(el));
      if (!rect) continue;
      const base = baselineOf(el);
      if (base === null || !Number.isFinite(base)) continue;
      metas.push({ el, rect, base, size: r1(num(style(el).fontSize)) });
    }
    for (let i = 0; i < metas.length; i += 1) {
      for (let j = i + 1; j < metas.length; j += 1) {
        const a = metas[i];
        const b = metas[j];
        if (Math.abs(a.size - b.size) > 0.25) continue; // not the same run of type
        const overlap = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        const smaller = Math.min(a.rect.bottom - a.rect.top, b.rect.bottom - b.rect.top);
        if (overlap <= smaller * 0.4) continue; // different lines, nothing to compare
        const d = r1(Math.abs(a.base - b.base));
        if (d > 0.6) {
          add({
            check: 'baseline',
            el: desc(a.el),
            vs: desc(b.el),
            px: { apart: d },
            detail: d + 'px apart on one line',
          });
        }
      }
    }
  }

  // 4. Rows that begin with a label put their content in one column. This is the
  //    "extra margin on the left" the operator saw: the header used flex with a
  //    12px gap where every row under it used a 96px grid column.
  const isLabel = (el) => {
    const t = String(el.textContent || '').trim();
    if (!t || t.length > 16) return false;
    if (style(el).textTransform === 'uppercase') return true;
    return t === t.toUpperCase() && /[A-Z]/.test(t) && /^[A-Z0-9][A-Z0-9 ._-]*$/.test(t);
  };
  const blocks = all.filter((el) => {
    if (!visible(el)) return false;
    const rows2 = Array.from(el.children).filter((k) => k.children.length >= 2 && isLabel(k.children[0]));
    return rows2.length >= 2;
  });
  for (const box of blocks) {
    const rows2 = Array.from(box.children)
      .filter((k) => k.children.length >= 2 && isLabel(k.children[0]))
      .map((k) => ({ el: k, x: r1(k.children[1].getBoundingClientRect().left) }));
    const xs = rows2.map((s) => s.x);
    const spread = Math.max(...xs) - Math.min(...xs);
    if (spread < 2 || spread > 40) continue; // one column, or an indent by design
    // The column is the value most rows agree on. On a tie the leftmost wins: the
    // left edge is the column, and an indent is the row that moved right (measured
    // on mock-1: a header using flex + a 12px gap sat 12px right of every grid row).
    const counts = new Map();
    for (const x of xs) counts.set(x, (counts.get(x) || 0) + 1);
    let common = xs[0];
    for (const [x, n] of counts) {
      const best = counts.get(common) || 0;
      if (n > best || (n === best && x < common)) common = x;
    }
    for (const s of rows2) {
      if (Math.abs(s.x - common) < 2) continue;
      add({
        check: 'column',
        el: desc(s.el),
        px: { x: s.x, rest: common },
        detail: 'content starts at ' + s.x + 'px; the other rows in this block start at ' + common + 'px',
      });
    }
  }

  out.layout = {
    checked: { controls: controls.length, textRuns: leaves.length, blocks: blocks.length },
    findings,
  };
  return out;
})()`;

/** One browser, one width, one job. Resolves with whatever `job(send)` returns. */function withPage(width, job, url = target) {
  const profile = path.join(os.tmpdir(), `visual-review-${process.pid}-${width}-${Date.now()}`);
  const portFile = path.join(profile, 'DevToolsActivePort');
  return new Promise((resolve, reject) => {
    const child = spawn(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        `--user-data-dir=${profile}`,
        '--remote-debugging-port=0',
        `--window-size=${width},${args.height}`,
        'about:blank',
      ],
      { windowsHide: true, stdio: 'ignore' },
    );
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* already gone */ }
      setTimeout(() => {
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked temp dir */ }
      }, 300);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('the browser did not answer within 60s')), 60000);
    timer.unref?.();

    (async () => {
      // The port the browser actually chose is written into the profile; polling
      // for it is the only honest way to know when it is ready.
      let port = 0;
      let waited = 0;
      while (!port && waited < 20000) {
        try {
          port = Number(String(fs.readFileSync(portFile, 'utf8')).split(/\r?\n/)[0]) || 0;
        } catch { /* not written yet */ }
        if (!port) {
          await sleep(120);
          waited += 120;
        }
      }
      if (!port) throw new Error('the browser never reported a debugging port');
      let list = [];
      for (let i = 0; i < 40 && !list.length; i += 1) {
        list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => []);
        if (!list || !list.length) await sleep(120);
      }
      const page = (list || []).find((t) => t.type === 'page');
      if (!page?.webSocketDebuggerUrl) throw new Error('the browser opened no page to drive');

      const ws = new WebSocket(page.webSocketDebuggerUrl);
      let id = 0;
      const pending = new Map();
      let loadResolve = null;
      const send = (method, params = {}) =>
        new Promise((res, rej) => {
          const n = (id += 1);
          pending.set(n, { res, rej });
          ws.send(JSON.stringify({ id: n, method, params }));
        });
      ws.addEventListener('message', (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.id && pending.has(msg.id)) {
          const { res, rej } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message));
          else res(msg.result);
        }
        if (msg.method === 'Page.loadEventFired') loadResolve?.();
      });
      await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', () => rej(new Error('could not open the debugger socket')), { once: true });
      });

      await send('Page.enable');
      await send('Runtime.enable');
      // The whole point: the layout viewport is what we asked for, so a 390px
      // review is a review of a 390px page.
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height: args.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const loaded = new Promise((res) => {
        loadResolve = res;
        setTimeout(res, 15000);
      });
      await send('Page.navigate', { url });
      await loaded;
      // A page that lays itself out in a script, or waits on a font, needs one
      // more turn of the loop before it is the page a person would see.
      await sleep(250);

      const out = await job(send, ws);
      try { ws.close(); } catch { /* closing */ }
      clearTimeout(timer);
      finish(resolve, out);
    })().catch((err) => {
      clearTimeout(timer);
      finish(reject, err);
    });
  });
}

const jsonLit = (v) => JSON.stringify(String(v));

/** Answer one expression inside the page. */
async function evalIn(send, expression) {
  const out = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text || 'the expression threw');
  return out.result?.value ?? null;
}

/**
 * The steps before a capture, so a *state* can be photographed instead of guessed:
 * `click:#start; wait:600; key:s`. Keys are synthetic events on `document`, which is
 * what a page's own shortcut handler listens for — not a real keyboard.
 */
async function runSteps(send, steps) {
  for (const step of steps) {
    const at = step.indexOf(':');
    const verb = at === -1 ? step : step.slice(0, at);
    const arg = at === -1 ? '' : step.slice(at + 1).trim();
    if (verb === 'wait') {
      await sleep(Math.min(30000, Number(arg) || 0));
    } else if (verb === 'click') {
      const hit = await evalIn(
        send,
        `(() => { const el = document.querySelector(${jsonLit(arg)}); if (!el) return 'none'; el.click(); return 'ok'; })()`,
      );
      if (hit === 'none') throw new Error(`the step "click:${arg}" found nothing on the page to click`);
      await sleep(60);
    } else if (verb === 'key') {
      await evalIn(
        send,
        `(() => { const o = { key: ${jsonLit(arg)}, bubbles: true }; document.dispatchEvent(new KeyboardEvent('keydown', o)); document.dispatchEvent(new KeyboardEvent('keyup', o)); return 'ok'; })()`,
      );
      await sleep(60);
    } else if (verb === 'eval') {
      await evalIn(send, arg);
    } else {
      throw new Error(`the step "${step}" is not one of click:, wait:, key:, eval:`);
    }
  }
}

/** A full-page PNG at exactly `width`, however tall the page turned out to be. */
async function shoot(width) {
  // A diff's own render must never land on the mock's name: shot.mjs writes
  // `<base>-<width>.png`, which is exactly what a mock shot by this tool is called.
  const out = path.join(args.outDir, mock ? `${base}-${width}-build.png` : `${base}-${width}.png`);
  try { fs.rmSync(out, { force: true }); } catch { /* nothing to remove */ }
  const result = await withPage(width, async (send) => {
    await runSteps(send, args.steps);
    // The check first: a page that painted nothing is the one answer that must not
    // come back as a picture.
    let report = null;
    try {
      report = await evalIn(send, REPORT_JS);
    } catch { /* a page that kills its own script still gets photographed */ }
    // --expect: is that element showing the string we meant it to show? The
    // attribute is not the answer — a date control can carry lang="en-GB" and
    // still draw "10/22/2026 04:00 PM" — so this reads the rendered text.
    for (const want of args.expect) {
      const at = want.indexOf('|');
      if (at < 1) throw new Error(`--expect needs "selector|regex", got "${want}"`);
      const sel = want.slice(0, at).trim();
      const re = want.slice(at + 1).trim();
      const seen = await evalIn(
        send,
        `(() => { const el = document.querySelector(${jsonLit(sel)}); if (!el) return null; const v = 'value' in el && el.value ? el.value : el.textContent; return String(v || '').trim(); })()`,
      );
      if (seen === null) throw new Error(`--expect: nothing matches ${sel} at ${width}px`);
      let ok = false;
      try { ok = new RegExp(re).test(seen); } catch { ok = seen.includes(re); }
      if (!ok) throw new Error(`--expect: ${sel} reads "${seen}" at ${width}px, which does not match ${re}`);
    }
    const metrics = await send('Page.getLayoutMetrics');
    const content = metrics.cssContentSize || metrics.contentSize || { width, height: args.height };
    // A diff compares like with like: the mock's frame is the height, not the
    // page's own height, or the two pictures would not line up by a pixel.
    const height = mock ? mock.height : Math.max(args.height, Math.ceil(content.height || 0));
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    return { png: Buffer.from(shot.data, 'base64'), report };
  });
  fs.writeFileSync(out, result.png);
  const size = fs.statSync(out).size;
  if (!size) throw new Error(`the browser captured an empty image for ${width}px`);
  if (result.report) {
    const { status, painted } = result.report;
    if (Number.isFinite(status) && status >= 400) {
      throw new Error(`the page answered ${status} at ${width}px — nothing was rendered`);
    }
    if (!painted || painted.elements === 0 || (painted.textChars === 0 && painted.images === 0)) {
      throw new Error(`the page rendered nothing at ${width}px (0 visible elements, no text, no images)`);
    }
  }
  return {
    target,
    width,
    height: args.height,
    path: out.replace(/\\/g, '/'),
    bytes: size,
    report: result.report,
  };
}

/** The findings, in the words a person would use. stderr, so stdout stays the JSON. */
function printAudit(shot) {
  const layout = shot.report?.layout;
  if (!layout) return 0;
  const list = layout.findings || [];
  if (!list.length) {
    const c = layout.checked || {};
    process.stderr.write(
      `layout: nothing to fix at ${shot.width}px (${c.controls || 0} control(s), ${c.textRuns || 0} text run(s), ${c.blocks || 0} block(s))\n`,
    );
    return 0;
  }
  process.stderr.write(`layout: ${list.length} finding(s) at ${shot.width}px\n`);
  for (const f of list) {
    const vs = f.vs ? ` (vs ${f.vs})` : '';
    process.stderr.write(`  ${String(f.check).padEnd(13)} ${f.el}${vs}: ${f.detail}\n`);
  }
  return list.length;
}

/**
 * Both widths in one picture.
 *
 * Two PNGs cost two reads and invite two separate judgements; side by side in one
 * frame, "the narrow one drops the label" is visible at a glance. The images are
 * scaled to a common height and labelled with the width they were laid out at.
 */
async function buildSheet(shots) {
  const cells = shots
    .map(
      (s) =>
        `<figure><figcaption>${s.width}px</figcaption><img alt="${s.width}px" src="data:image/png;base64,${fs
          .readFileSync(s.path)
          .toString('base64')}"></figure>`,
    )
    .join('');
  const html = `<!doctype html><meta charset="utf-8"><title>contact sheet</title>
<style>
  body { margin:0; padding:16px; background:#101114; color:#c9cdd4;
         font:600 12px/1.4 system-ui, sans-serif; letter-spacing:.04em;
         display:flex; gap:16px; align-items:flex-start; }
  figure { margin:0; }
  figcaption { margin-bottom:6px; text-transform:uppercase; }
  img { display:block; height:820px; width:auto; border:1px solid #2a2d35; border-radius:4px; background:#000; }
</style>${cells}`;
  const tmp = path.join(os.tmpdir(), `visual-review-sheet-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(tmp, html, 'utf8');
  const out = path.join(args.outDir, `${base}-sheet.png`);
  try {
    const width = Math.min(4000, 1400 + 100 * shots.length);
    const png = await withPage(
      width,
      async (send) => {
        const metrics = await send('Page.getLayoutMetrics');
        const content = metrics.cssContentSize || metrics.contentSize || { width, height: 900 };
        const shot = await send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: Math.ceil(content.width || width), height: Math.ceil(content.height || 900), scale: 1 },
        });
        return Buffer.from(shot.data, 'base64');
      },
      pathToFileURL(tmp).href,
    );
    fs.writeFileSync(out, png);
    return { path: out.replace(/\\/g, '/'), bytes: fs.statSync(out).size };
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* temp */ }
  }
}

/**
 * A PNG's pixel size, from its header alone: 24 bytes, no decoder. The colour
 * handling is the browser's job — this only has to know the frame to render at.
 */
function pngSize(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error(`${file} is not a PNG`);
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height) throw new Error(`${file} has no pixel size`);
  return { width, height };
}

// The comparison runs inside the page, for the same reason the contact sheet does:
// the browser already decodes PNGs, and a canvas gives us the pixels without a
// dependency. `A` is the mock, `B` the build, `T` the per-channel difference that
// counts. An unchanged pixel is the build dimmed to a ghost; a changed one is red.
// Regions are found on a 16px grid and merged into rectangles, because "42% differs"
// without saying where is a number nobody can act on.
const DIFF_BODY = `
  const load = (src) => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('an image would not load'));
    img.src = src;
  });
  const grab = (img) => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, W, H);
    return x.getImageData(0, 0, W, H).data;
  };
  window.__diff = (async () => {
    const [a, b] = await Promise.all([load(A), load(B)]);
    const A0 = grab(a), B0 = grab(b);
    const hot = new Uint8Array(W * H);
    let different = 0;
    for (let p = 0, i = 0; p < W * H; p += 1, i += 4) {
      const d = Math.max(
        Math.abs(A0[i] - B0[i]), Math.abs(A0[i + 1] - B0[i + 1]),
        Math.abs(A0[i + 2] - B0[i + 2]), Math.abs(A0[i + 3] - B0[i + 3]),
      );
      if (d > T) { hot[p] = 1; different += 1; }
    }
    const out = new Uint8ClampedArray(B0.length);
    for (let p = 0, i = 0; p < W * H; p += 1, i += 4) {
      if (hot[p]) { out[i] = 255; out[i + 1] = 62; out[i + 2] = 48; out[i + 3] = 255; }
      else {
        out[i] = Math.round(B0[i] * 0.28 + 9 * 0.72);
        out[i + 1] = Math.round(B0[i + 1] * 0.28 + 10 * 0.72);
        out[i + 2] = Math.round(B0[i + 2] * 0.28 + 13 * 0.72);
        out[i + 3] = 255;
      }
    }
    document.getElementById('c').getContext('2d').putImageData(new ImageData(out, W, H), 0, 0);
    const C = 16;
    const cols = Math.ceil(W / C), rows = Math.ceil(H / C);
    const cells = new Uint8Array(cols * rows);
    for (let p = 0; p < W * H; p += 1) {
      if (!hot[p]) continue;
      const k = Math.floor(Math.floor(p / W) / C) * cols + Math.floor((p % W) / C);
      cells[k] = 1;
    }
    const free = (y, x1, x2) => {
      for (let x = x1; x <= x2; x += 1) { const k = y * cols + x; if (!cells[k] || seen[k]) return false; }
      return true;
    };
    const seen = new Uint8Array(cols * rows);
    const boxes = [];
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        if (!cells[y * cols + x] || seen[y * cols + x]) continue;
        let x2 = x;
        while (x2 + 1 < cols && cells[y * cols + x2 + 1] && !seen[y * cols + x2 + 1]) x2 += 1;
        let y2 = y;
        while (y2 + 1 < rows && free(y2 + 1, x, x2)) y2 += 1;
        for (let yy = y; yy <= y2; yy += 1) for (let xx = x; xx <= x2; xx += 1) seen[yy * cols + xx] = 1;
        boxes.push({
          x: x * C, y: y * C,
          w: Math.min(W, (x2 + 1) * C) - x * C,
          h: Math.min(H, (y2 + 1) * C) - y * C,
        });
      }
    }
    boxes.sort((m, n) => n.w * n.h - m.w * m.h);
    return {
      different,
      percent: Math.round((different / (W * H)) * 10000) / 100,
      threshold: T,
      regions: boxes.length,
      boxes: boxes.slice(0, 12),
    };
  })();
`;

/**
 * One picture of where the build left the mock.
 *
 * The mock is a saved PNG and the build is a page; both are compared at the
 * mock's own width and height, because two pictures of different sizes compare
 * two layouts. The output is the build as a ghost with the differing pixels in
 * red, the mock's size, so the two can be flipped between. The number and the
 * regions are on stdout, because "looks close" is not a measurement.
 */
async function diffAgainst(shot, mockFile) {
  const W = mockFile.width;
  const H = mockFile.height;
  const dataUrl = (file) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
  const script = [
    `const W = ${W}, H = ${H}, T = ${mockFile.threshold};`,
    `const A = ${JSON.stringify(dataUrl(mockFile.path))}, B = ${JSON.stringify(dataUrl(shot.path))};`,
    DIFF_BODY,
  ].join('\n');
  const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#0b0c0f;overflow:hidden}
canvas{display:block}
</style><canvas id="c" width="${W}" height="${H}"></canvas><script>${script}</script>`;
  const tmp = path.join(os.tmpdir(), `visual-review-diff-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(tmp, html, 'utf8');
  const out = path.join(args.outDir, `${base}-${shot.width}-diff.png`);
  try {
    const result = await withPage(
      W,
      async (send) => {
        const stats = await evalIn(send, 'window.__diff');
        const png = await send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: W, height: H, scale: 1 },
        });
        return { stats, png: Buffer.from(png.data, 'base64') };
      },
      pathToFileURL(tmp).href,
    );
    fs.writeFileSync(out, result.png);
    return {
      ...result.stats,
      reference: mockFile.path.replace(/\\/g, '/'),
      path: out.replace(/\\/g, '/'),
      bytes: fs.statSync(out).size,
    };
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* temp */ }
  }
}

/** Load the page at `width` and answer `expr` from inside it. */
async function evaluate(width, expr) {
  return withPage(width, async (send) => {
    await runSteps(send, args.steps);
    try {
      return { value: await evalIn(send, expr), error: null };
    } catch (err) {
      return { value: null, error: err.message };
    }
  });
}

const base = isUrl
  ? path.basename(decodeURIComponent(new URL(args.target).pathname)).replace(/\.[^.]+$/, '') || 'shot'
  : path.basename(localFile).replace(/\.[^.]+$/, '') || 'shot';

fs.mkdirSync(args.outDir, { recursive: true });

let server = null;
let target = args.target;
try {
  if (localFile && args.serve) {
    server = await serveFolder(localFile);
    target = server.url;
  } else if (localFile) {
    target = pathToFileURL(localFile).href;
  }

  if (args.evalExpr) {
    for (const width of args.widths) {
      const answer = await evaluate(width, args.evalExpr);
      process.stdout.write(
        `${JSON.stringify({ target, width, height: args.height, value: answer.value, error: answer.error })}\n`,
      );
    }
  } else {
    const shots = [];
    for (const width of args.widths) {
      const shot = await shoot(width);
      shots.push(shot);
      process.stdout.write(`${JSON.stringify(shot)}\n`);
      if (args.audit && printAudit(shot)) process.exitCode = 1;
    }
    if (mock) {
      for (const shot of shots) {
        const d = await diffAgainst(shot, mock);
        process.stdout.write(`${JSON.stringify({ target, width: shot.width, height: shot.height, diff: d })}\n`);
        process.stderr.write(
          `diff: ${d.percent}% of ${mock.width}x${mock.height} differs at ${shot.width}px (${d.regions} region(s)) -> ${d.path}\n`,
        );
        if (args.failOver !== null && d.percent > args.failOver) {
          process.stderr.write(`diff: ${d.percent}% is over the ${args.failOver}% limit\n`);
          process.exitCode = 1;
        }
      }
    }
    if (args.sheet && shots.length > 1) {
      const sheet = await buildSheet(shots);
      process.stdout.write(`${JSON.stringify({ target, sheet: sheet.path, bytes: sheet.bytes })}\n`);
    }
  }
} catch (err) {
  fail(1, `Screenshot failed: ${err.message}`);
} finally {
  if (server) await server.close().catch(() => {});
}
