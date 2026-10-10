// The HTML lexer, also for the templates of Vue, Svelte and Astro components. After the HTML
// syntax (https://html.spec.whatwg.org/multipage/syntax.html): `<!-- … -->` comments, attribute
// values as strings, and `<script>` contents as JavaScript. Text is prose and `<style>` is CSS, so
// neither has spans. Components add `{…}` attribute values (Svelte, Astro) and Astro's `---`
// component script, which are JavaScript too.
import type { Lexer } from '../../ports.ts';
import type { Span } from '../../types.ts';
import { javascript } from './c-like.ts';
import { lexPart } from './engine.ts';

const isBlank = (c: string | undefined): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

const START_TAG = /<([A-Za-z][^\s/>]*)/y;
const FENCE = /^\s*---[ \t]*\r?\n/;

function lexHtml(text: string): Span[] {
  const out: Span[] = [];
  const n = text.length;
  let i = 0;

  // Astro's component script, fenced by `---` lines at the start.
  const fence = FENCE.exec(text);
  if (fence) {
    const start = fence[0].length;
    const close = /^---[ \t]*$/m.exec(text.slice(start));
    const end = close ? start + close.index : n;
    lexPart(javascript, text, start, end, out);
    i = close ? end + close[0].length : n;
  }

  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;
    i = lt;
    if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4);
      const end = close === -1 ? n : close + 3;
      out.push({ start: i, end, kind: 'comment' });
      i = end;
      continue;
    }
    START_TAG.lastIndex = i;
    const tag = START_TAG.exec(text);
    if (!tag) {
      // An end tag, a doctype, or a `<` in text.
      i++;
      continue;
    }
    i = attributes(text, i + tag[0].length, out);
    const name = (tag[1] as string).toLowerCase();
    if (name === 'script' || name === 'style') {
      // Raw text: it ends at the first `</script` or `</style`, whatever it is inside.
      const close = new RegExp(`</${name}[\\s/>]`, 'gi');
      close.lastIndex = i;
      const end = close.exec(text)?.index ?? n;
      if (name === 'script') lexPart(javascript, text, i, end, out);
      i = end;
    }
  }
  return out;
}

/** Lexes a start tag's attributes from `i`; returns the offset after the tag. */
function attributes(text: string, i: number, out: Span[]): number {
  const n = text.length;
  let j = i;
  while (j < n) {
    const c = text[j];
    if (c === '>') return j + 1;
    if (c === '{') {
      // Svelte's `{name}` and `{...props}`.
      j = expression(text, j, out);
      continue;
    }
    if (c !== '=') {
      j++;
      continue;
    }
    j++;
    while (isBlank(text[j])) j++;
    const q = text[j];
    if (q === '"' || q === "'") {
      const close = text.indexOf(q, j + 1);
      const end = close === -1 ? n : close;
      out.push({ start: j + 1, end, kind: 'string', open: j });
      j = end + 1;
    } else if (q === '{') {
      j = expression(text, j, out);
    } else {
      // Unquoted: up to a blank or the end of the tag.
      const start = j;
      while (j < n && !isBlank(text[j]) && text[j] !== '>') j++;
      if (j > start) out.push({ start, end: j, kind: 'value' });
    }
  }
  return n;
}

/**
 * A `{…}` JavaScript expression at `i` (Svelte, Astro). Braces inside its strings don't count.
 * Returns the offset after the closing brace.
 */
function expression(text: string, i: number, out: Span[]): number {
  const n = text.length;
  let depth = 0;
  let j = i;
  for (; j < n; j++) {
    const c = text[j];
    if (c === '"' || c === "'" || c === '`') {
      for (j++; j < n && text[j] !== c; j++) if (text[j] === '\\') j++;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) break;
  }
  lexPart(javascript, text, i + 1, Math.min(j, n), out);
  return Math.min(j + 1, n);
}

export const htmlLexer: Lexer = { languages: ['html'], lex: lexHtml };
