// A small markdown renderer.
//
// Hand-rolled because Synapse takes no dependencies, and deliberately
// escape-first: the source is HTML-escaped before any markdown rule runs, so a
// model cannot inject markup through its answer. Every tag in the output is one
// this file emitted itself.
//
// Supported: fenced code, headings, GFM tables, blockquotes, ordered/unordered
// lists (including task lists), horizontal rules, images, paragraphs; inline
// code, bold, italic, strikethrough and links. That is the range these models
// actually produce.

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);

const LIST_ITEM = /^\s*([-*+]|\d+\.)\s+/;
const TASK_ITEM = /^\[([ xX])\]\s+/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
// `>` is already escaped to `&gt;` by the time block rules run.
const QUOTE = /^\s*(?:>|&gt;)\s?/;
const FENCE = /^\s*```(\S*)\s*$/;

/** Inline rules. Input is already escaped. */
function inline(source) {
  // Pull inline code out first so its contents are not treated as markdown.
  const codes = [];
  let t = source.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // Images before links: otherwise the link rule eats the [alt](src) part and
  // leaves a stray "!".
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
    const safe = /^(https?:\/\/|data:image\/|mailto:|\/|#)/i.test(src) ? src : '#';
    if (safe === '#') return alt;
    return `<img src="${safe}" alt="${alt}" loading="lazy" />`;
  });

  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    // Only ever emit a link we would follow ourselves.
    const safe = /^(https?:\/\/|mailto:|\/|#)/i.test(href) ? href : '#';
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  t = t.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${codes[Number(n)]}</code>`);
  return t;
}

/** A GFM table delimiter row: `| --- | :-: | --: |`, pipes optional. */
const DELIM_CELL = /^\s*:?-+:?\s*$/;

/** Split a table row on pipes, ignoring pipes inside `code` and `\|`. */
function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '`') { inCode = !inCode; cur += c; }
    else if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; }
    else if (c === '|' && !inCode) { cells.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const isDelimRow = (line) => {
  if (!line.includes('|')) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => DELIM_CELL.test(c));
};

const alignOf = (cell) => {
  const t = cell.trim();
  if (t.startsWith(':') && t.endsWith(':') && t.length > 2) return 'center';
  if (t.endsWith(':')) return 'right';
  return 'left';
};

function renderTable(header, aligns, rows) {
  const n = header.length;
  const norm = (r) => {
    const x = r.slice(0, n);
    while (x.length < n) x.push('');
    return x;
  };
  const cell = (tag, text, i) =>
    `<${tag}${aligns[i] && aligns[i] !== 'left' ? ` style="text-align:${aligns[i]}"` : ''}>${inline(text)}</${tag}>`;
  const head = `<thead><tr>${norm(header).map((c, i) => cell('th', c, i)).join('')}</tr></thead>`;
  const body = rows.length
    ? `<tbody>${rows.map((r) => `<tr>${norm(r).map((c, i) => cell('td', c, i)).join('')}</tr>`).join('')}</tbody>`
    : '';
  return `<table class="md-table">${head}${body}</table>`;
}

/** Block rules. Input is already escaped. */
function blocks(source) {
  const lines = source.split('\n');
  const out = [];
  let para = [];

  const flush = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const lang = fence[1];
      const buf = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
      i += 1; // closing fence
      out.push(`<pre class="md-code"${lang ? ` data-lang="${lang}"` : ''}><code>${buf.join('\n')}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (RULE.test(line)) { flush(); out.push('<hr />'); i += 1; continue; }

    // A GFM table: a header row with pipes followed by a delimiter row. The
    // delimiter cannot be a RULE (it has pipes) or a LIST_ITEM, so checking
    // here is unambiguous.
    if (line.includes('|') && i + 1 < lines.length && isDelimRow(lines[i + 1])) {
      flush();
      const header = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]).map(alignOf);
      const rows = [];
      i += 2;
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        lines[i].includes('|') &&
        !FENCE.test(lines[i]) &&
        !isDelimRow(lines[i])
      ) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      out.push(renderTable(header, aligns, rows));
      continue;
    }

    if (QUOTE.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        buf.push(lines[i].replace(QUOTE, ''));
        i += 1;
      }
      out.push(`<blockquote>${blocks(buf.join('\n'))}</blockquote>`);
      continue;
    }

    if (LIST_ITEM.test(line)) {
      flush();
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && LIST_ITEM.test(lines[i])) {
        items.push(lines[i].replace(LIST_ITEM, ''));
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(
        `<${tag}>${items
          .map((t) => {
            const task = TASK_ITEM.exec(t);
            if (task) {
              const checked = task[1].toLowerCase() === 'x' ? ' checked' : '';
              return `<li class="md-task"><input type="checkbox" disabled${checked} />${inline(t.slice(task[0].length))}</li>`;
            }
            return `<li>${inline(t)}</li>`;
          })
          .join('')}</${tag}>`,
      );
      continue;
    }

    if (!line.trim()) { flush(); i += 1; continue; }

    para.push(line.trim());
    i += 1;
  }

  flush();
  return out.join('\n');
}

/** Render markdown to HTML. The result is safe to assign to innerHTML. */
export function renderMarkdown(source) {
  const escaped = escapeHtml(String(source ?? '').replace(/\r\n?/g, '\n'));
  return blocks(escaped);
}
