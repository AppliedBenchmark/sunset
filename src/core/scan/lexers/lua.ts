// The Lua lexer, after the Lua 5.4 manual (3.1, Lexical Conventions): `--` comments, long comments
// `--[[ … ]]`, short strings in `'` or `"` with backslash escapes, and long strings `[[ … ]]`, with
// any number of `=` between the brackets (`[==[ … ]==]`).
import type { Lexer } from '../../ports.ts';
import type { Span } from '../../types.ts';

/** The level of an opening long bracket at `i` (`[[` is 0, `[==[` is 2), or -1. */
function longBracket(text: string, i: number): number {
  if (text[i] !== '[') return -1;
  let j = i + 1;
  while (text[j] === '=') j++;
  return text[j] === '[' ? j - i - 1 : -1;
}

function lexLua(text: string): Span[] {
  const out: Span[] = [];
  const n = text.length;
  let i = 0;
  // The interpreter skips a first line that starts with `#`, such as `#!/usr/bin/env lua`.
  if (text[0] === '#') {
    i = text.indexOf('\n');
    if (i === -1) i = n;
    out.push({ start: 0, end: i, kind: 'comment' });
  }

  /** The long bracket at `i` of `level`; returns its content's end and the offset after it. */
  const long = (i: number, level: number): { end: number; next: number } => {
    const close = `]${'='.repeat(level)}]`;
    const end = text.indexOf(close, i + level + 2);
    return end === -1 ? { end: n, next: n } : { end, next: end + close.length };
  };

  while (i < n) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') {
      const level = longBracket(text, i + 2);
      let end: number;
      if (level >= 0) end = long(i + 2, level).next;
      else {
        end = text.indexOf('\n', i);
        if (end === -1) end = n;
      }
      out.push({ start: i, end, kind: 'comment' });
      i = end;
      continue;
    }
    const level = longBracket(text, i);
    if (level >= 0) {
      let start = i + level + 2;
      // A line break right after the opening bracket isn't part of the string.
      if (text[start] === '\r') start++;
      if (text[start] === '\n') start++;
      const { end, next } = long(i, level);
      out.push({ start: Math.min(start, end), end, kind: 'string', open: i });
      i = next;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') {
        if (text[j] === '\\') {
          // `\z` skips the blanks after it, line breaks included.
          if (text[j + 1] === 'z') {
            j += 2;
            while (j < n && /\s/.test(text[j] as string)) j++;
            continue;
          }
          j++;
        }
        j++;
      }
      const end = Math.min(j, n);
      out.push({ start: i + 1, end, kind: 'string', open: i });
      i = text[end] === c ? end + 1 : end;
      continue;
    }
    i++;
  }
  return out;
}

export const luaLexer: Lexer = { languages: ['lua'], lex: lexLua };
