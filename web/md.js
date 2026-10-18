// A small markdown renderer.
//
// Hand-rolled because Synapse takes no dependencies, and deliberately
// escape-first: the source is HTML-escaped before any markdown rule runs, so a
// model cannot inject markup through its answer. Every tag in the output is one
// this file emitted itself.
//
// Supported: fenced code, headings, blockquotes, ordered/unordered lists,
// horizontal rules, paragraphs; inline code, bold, italic, strikethrough and
// links. That is the range these models actually produce.

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);

const LIST_ITEM = /^\s*([-*+]|\d+\.)\s+/;
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

  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    // Only ever emit a link we would follow ourselves.
    const safe = /^(https?:\/\/|mailto:|\/|#)/i.test(href) ? href : '#';
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  t = t.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${codes[Number(n)]}</code>`);
  return t;
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
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
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
