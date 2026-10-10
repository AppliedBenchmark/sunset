// The Python lexer: `#` comments, string prefixes (r, b, f, u, t and combinations),
// triple quotes and nested f-strings.
import type { Lexer } from '../../ports.ts';
import type { Span } from '../../types.ts';
import { type Flavor, isBlank, lexWith, simple } from './engine.ts';

const PREFIX = /^[rRbBuUfFtT]{0,2}/;

const flavor: Flavor = {
  slashComments: false,
  nestedComments: false,
  hashComments: 'anywhere',
  regexLiterals: false,
  phpTags: false,
  string(text, i) {
    const prefix = PREFIX.exec(text.slice(i, i + 2))?.[0] ?? '';
    const j = i + prefix.length;
    const q = text[j];
    if (q !== '"' && q !== "'") return null;
    const lower = prefix.toLowerCase();
    // In raw strings a backslash still stops the quote from closing the literal, so the
    // `backslash` escape rule finds the right end for both kinds.
    const interp = lower.includes('f') || lower.includes('t') ? 'brace' : 'none';
    if (text.startsWith(q.repeat(3), j)) {
      return simple(j + 3, q.repeat(3), { multiline: true, interp });
    }
    return simple(j + 1, q, { interp });
  },
};

/**
 * A triple-quoted string that is a statement on its own (a docstring, or a string used as a block
 * comment) is documentation, not a value, so it becomes a comment span. Inside brackets or after a
 * `\` continuation, it is part of a statement: an argument, a list item.
 */
function docstringsToComments(text: string, spans: Span[]): Span[] {
  // Brackets open in the code before the span, and the last character of that code.
  let depth = 0;
  let last = '';
  let at = 0;
  return spans.map((span) => {
    // Up to the literal, or for a later segment of an f-string, up to the segment: the rest of the
    // interpolation before it.
    const code = span.open !== undefined && span.open >= at ? span.open : span.start;
    for (; at < code; at++) {
      const c = text[at] as string;
      if (c === '(' || c === '[' || c === '{') depth++;
      else if ((c === ')' || c === ']' || c === '}') && depth > 0) depth--;
      if (!isBlank(c)) last = c;
    }
    at = Math.max(at, span.end);
    if (span.kind !== 'string' || span.interpolated || span.open === undefined) return span;
    if (depth > 0 || last === '\\') return span;
    const open = span.open;
    const quote = text.slice(span.start - 3, span.start);
    if (quote !== '"""' && quote !== "'''") return span;
    // Only blanks before it on its line, and only blanks or a comment after it. Scanning just the
    // blanks keeps a long line of strings linear.
    let before = open - 1;
    while (before >= 0 && text[before] !== '\n' && /\s/.test(text[before] as string)) before--;
    if (before >= 0 && text[before] !== '\n') return span;
    let after = span.end + 3;
    while (after < text.length && text[after] !== '\n' && /\s/.test(text[after] as string)) after++;
    if (after < text.length && text[after] !== '\n' && text[after] !== '#') return span;
    return {
      start: open,
      end: span.end + 3 > text.length ? span.end : span.end + 3,
      kind: 'comment',
    };
  });
}

export const pythonLexer: Lexer = {
  languages: ['python'],
  lex: (text) => docstringsToComments(text, lexWith(flavor, text)),
};
