// The PowerShell lexer, after about_Comments and about_Quoting_Rules: `#` and `<# … #>` comments
// where a token starts, verbatim `'…'` strings (`''` is a quote), expandable `"…"` strings (with
// backtick escapes, `""`, `$name`, `${name}` and `$(…)`), and `@'…'@` and `@"…"@` here-strings.
// Like a shell, PowerShell takes unquoted command arguments as strings, so other words are values.
import type { Lexer } from '../../ports.ts';
import type { Span } from '../../types.ts';
import { isBlank, skipBalanced } from './engine.ts';

/** Characters that end a word, besides blanks: `$s =@"` starts a here-string after `=`. */
const SEPARATORS = ';|&(){}[],=+>';

function lexPowerShell(text: string): Span[] {
  const out: Span[] = [];
  const n = text.length;
  let i = 0;
  let wordStart = -1;

  const endWord = (end: number): void => {
    if (wordStart !== -1 && end > wordStart) out.push({ start: wordStart, end, kind: 'value' });
    wordStart = -1;
  };

  while (i < n) {
    const c = text[i] as string;

    if (isBlank(c) || SEPARATORS.includes(c)) {
      endWord(i);
      i++;
      continue;
    }

    // A comment only where a token starts: `Foo#Bar` is one word.
    if (wordStart === -1 && (c === '#' || (c === '<' && text[i + 1] === '#'))) {
      let end: number;
      if (c === '#') {
        end = text.indexOf('\n', i);
        if (end === -1) end = n;
      } else {
        end = text.indexOf('#>', i + 2);
        end = end === -1 ? n : end + 2;
      }
      out.push({ start: i, end, kind: 'comment' });
      i = end;
      continue;
    }

    if (wordStart === -1 && c === '@' && (text[i + 1] === '"' || text[i + 1] === "'")) {
      const end = hereString(text, i, out);
      if (end !== null) {
        i = end;
        continue;
      }
    }

    if (c === "'" || c === '"') {
      endWord(i);
      i = c === "'" ? verbatim(text, i, out) : expandable(text, i, out);
      continue;
    }

    // A backtick escapes the next character; before a line break, it continues the line.
    if (c === '`') {
      const next = text[i + 1] === '\r' ? i + 2 : i + 1;
      if (text[next] === '\n') {
        endWord(i);
        i = next + 1;
        continue;
      }
      if (wordStart === -1) wordStart = i;
      i += 2;
      continue;
    }

    if (wordStart === -1) wordStart = i;
    i++;
  }
  endWord(Math.min(i, n));
  return out;
}

/** A `'…'` string at `i`, where `''` is a quote. Returns the offset after it. */
function verbatim(text: string, i: number, out: Span[]): number {
  let j = i + 1;
  for (;;) {
    const q = text.indexOf("'", j);
    if (q === -1) {
      out.push({ start: i + 1, end: text.length, kind: 'string', open: i });
      return text.length;
    }
    if (text[q + 1] !== "'") {
      out.push({ start: i + 1, end: q, kind: 'string', open: i });
      return q + 1;
    }
    j = q + 2;
  }
}

/**
 * A `"…"` string at `i`, one string segment per literal part: `$(…)` and `${…}` are code.
 * Returns the offset after it.
 */
function expandable(text: string, i: number, out: Span[]): number {
  const n = text.length;
  const segments: Span[] = [];
  let start = i + 1;
  let interpolated = false;
  let j = start;
  const segment = (end: number): void => {
    segments.push({ start, end, kind: 'string', open: i });
  };
  while (j < n) {
    const c = text[j];
    if (c === '`') {
      j += 2;
      continue;
    }
    if (c === '"') {
      if (text[j + 1] === '"') {
        j += 2;
        continue;
      }
      break;
    }
    if (c === '$') {
      const next = text[j + 1];
      if (next === '(' || next === '{') {
        segment(j);
        j = skipBalanced(text, j + 1, '`');
        start = j;
        interpolated = true;
        continue;
      }
      if (next !== undefined && /[A-Za-z_?^$]/.test(next)) interpolated = true;
    }
    j++;
  }
  segment(Math.min(j, n));
  for (const span of segments) {
    if (interpolated) span.interpolated = true;
    out.push(span);
  }
  return Math.min(j + 1, n);
}

/**
 * A here-string at `i` (on `@`): `@'` or `@"` ending its line, and everything up to a line that
 * starts with `'@` or `"@`. Returns the offset after it, or null if `i` doesn't start one.
 */
function hereString(text: string, i: number, out: Span[]): number | null {
  const quote = text[i + 1] as string;
  let j = i + 2;
  while (text[j] === ' ' || text[j] === '\t' || text[j] === '\r') j++;
  if (text[j] !== '\n') return null;
  const start = j + 1;
  let line = start;
  while (line < text.length) {
    // The closing mark starts its line; PowerShell allows no blanks before it.
    if (text[line] === quote && text[line + 1] === '@') {
      // The line break before the closing mark is part of the mark, not of the string.
      const end = Math.max(start, text[line - 2] === '\r' ? line - 2 : line - 1);
      pushHere(text, start, end, i, quote, out);
      return line + 2;
    }
    const eol = text.indexOf('\n', line);
    if (eol === -1) break;
    line = eol + 1;
  }
  pushHere(text, start, Math.max(start, text.length), i, quote, out);
  return text.length;
}

function pushHere(
  text: string,
  start: number,
  end: number,
  open: number,
  quote: string,
  out: Span[],
): void {
  const span: Span = { start, end, kind: 'string', open };
  if (quote === '"' && /\$[A-Za-z_({]/.test(text.slice(start, end))) span.interpolated = true;
  out.push(span);
}

export const powershellLexer: Lexer = { languages: ['powershell'], lex: lexPowerShell };
