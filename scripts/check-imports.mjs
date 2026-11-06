#!/usr/bin/env node
// Which names does a web module use that another module exports and it never
// imported? That mistake is invisible to the suite and to `node --check`: the page
// loads, the module parses, and the first call throws a ReferenceError — which, in
// boot(), leaves a page that looks alive and is not.
//
//   node scripts/check-imports.mjs             # every file in web/
//   node scripts/check-imports.mjs web/ask-panel.js
//
// It is a heuristic, not a parser. Three things keep it quiet enough to be useful:
// comments and string literals are stripped first, a name the file *wires* at boot
// (`name: missing('name')`) is not a missing import, and a name that is a property
// (`state.send`) never matches because the dot is excluded.
//
// Written while splitting app.js (6 Nov) after two moves in a row shipped a missing
// import that only a browser caught.
import fs from 'node:fs';
import path from 'node:path';

const WEB = 'web';
const args = process.argv.slice(2);
const targets = args.length ? args : fs.readdirSync(WEB).filter((f) => f.endsWith('.js')).map((f) => path.join(WEB, f));

/** Drop comments and quoted strings so a name in prose is not a name in code. */
function codeOnly(src) {
  // Every replacement keeps its newlines: a template literal that spans ten lines must
  // still be ten lines, or the `^export` anchors below stop matching and the checker
  // reports exports that are plainly there (paid for once, 7 Nov).
  //
  // Templates go first and quotes may not cross a newline: a `'` inside a template
  // (`It's`) otherwise pairs with the next apostrophe hundreds of lines later and eats
  // everything between.
  const keepLines = (text) => '\n'.repeat((text.match(/\n/g) || []).length);
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' ' + keepLines(m))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => '``' + keepLines(m))
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
}

const exportsOf = new Map();
for (const f of fs.readdirSync(WEB).filter((f) => f.endsWith('.js'))) {
  const text = codeOnly(fs.readFileSync(path.join(WEB, f), 'utf8'));
  const names = new Set();
  for (const m of text.matchAll(/^export (?:async )?function ([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of text.matchAll(/^export (?:const|let) ([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  exportsOf.set(f, names);
}

let problems = 0;
for (const file of targets) {
  const raw = fs.readFileSync(file, 'utf8');
  const src = codeOnly(raw);
  const own = path.basename(file);

  const known = new Set();
  for (const m of src.matchAll(/^(?:export )?(?:async )?function ([A-Za-z_$][\w$]*)/gm)) known.add(m[1]);
  for (const m of src.matchAll(/^(?:export )?(?:const|let|var) ([A-Za-z_$][\w$]*)/gm)) known.add(m[1]);
  for (const m of src.matchAll(/^import \{([^}]+)\} from/gm)) {
    for (const part of m[1].split(',')) known.add(part.trim().split(' as ').pop().trim());
  }

  // The other half of the same mistake: importing a name the target does not export.
  // The browser answers that one with a module-graph SyntaxError and a dead page, and
  // nothing else in the suite notices (7 Nov: `isBusy` from projects.js).
  const badImports = [];
  for (const m of raw.matchAll(/import \{([^}]+)\} from '\.\/([^']+)';/g)) {
    const target = m[2];
    const exported = exportsOf.get(target);
    if (!exported) { badImports.push(`${target}  <- no such module`); continue; }
    for (const part of m[1].split(',')) {
      const name = part.trim().split(' as ').pop().trim();
      if (name && !exported.has(name)) badImports.push(`${name}  not exported by ${target}`);
    }
  }
  if (badImports.length) {
    problems += badImports.length;
    console.log(`${file}:`);
    for (const line of [...new Set(badImports)].sort()) console.log(`  ${line}`);
  }

  const missing = [];
  // Two shapes of use: a call (`name(`) and a bare value (`AUTOMATION_ROWS.map`, a
  // constant passed to a function). The value pass is the one that matters most — a
  // missing *function* import throws on the line that calls it, but a missing
  // constant throws wherever it is first touched, which is usually deep in a render
  // (7 Nov: `AUTOMATION_ROWS` in run-menu.js, which the call-only pass could not see).
  // Property accesses are excluded by the lookbehind, object keys by the `:` guard.
  const uses = [
    ...src.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g),
    ...src.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)(?!\s*[:(])/g),
  ];
  for (const m of uses) {
    const name = m[1];
    if (known.has(name)) continue;
    // `$` is a one-character name that also appears inside template expressions and
    // regexes; it is imported where it is used, and flagging it is pure noise.
    if (name === '$') continue;
    // A wired name is imported nowhere on purpose: app.js hands it over at boot.
    if (new RegExp(`\\b${name}: missing\\(`).test(raw)) continue;
    for (const [f, names] of exportsOf) {
      if (f === own) continue;
      if (names.has(name)) { missing.push(`${name}  <- ${f}`); break; }
    }
  }
  if (missing.length) {
    problems += missing.length;
    console.log(`${file}:`);
    for (const line of [...new Set(missing)].sort()) console.log(`  ${line}`);
  }
}

if (!problems) console.log(`nothing missing across ${targets.length} file(s)`);
process.exitCode = problems ? 1 : 0;
