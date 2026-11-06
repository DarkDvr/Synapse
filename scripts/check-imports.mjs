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
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
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

  const missing = [];
  for (const m of src.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (known.has(name)) continue;
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
