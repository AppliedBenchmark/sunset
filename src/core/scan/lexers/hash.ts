// The `#`-comment lexers: shell (also Dockerfile, Makefile and `.env`), TOML, INI, Ruby
// and R. In shell-like and key-value files, unquoted words are data, so they become `value` spans.
import type { Lexer } from '../../ports.ts';
import type { Language, Span } from '../../types.ts';
import {
  type Flavor,
  isBlank,
  lexWith,
  run,
  type StringStart,
  simple,
  skipBalanced,
} from './engine.ts';

interface HashOptions {
  /** Where `#` starts a comment: only at the start of a word (shell), or anywhere (TOML). */
  hash: 'word-start' | 'anywhere';
  /** INI: `;` starts a comment at the start of a word. */
  semicolon: boolean;
  /** Shell quoting (`'` raw and multi-line, `"` with `$` expansion) or TOML quoting. */
  quoting: 'shell' | 'toml' | 'ini';
  /** Characters that separate unquoted words, besides whitespace. */
  separators: string;
}

/**
 * A heredoc operator at `i` (on `<<`): `<<word` or `<<-word`, blanks allowed before the word
 * (POSIX 2.7.4, as bash, dash and zsh read it). Quoting any part of the word (`'EOF'`, `"EOF"`,
 * `\EOF`) means the body isn't expanded. Returns the delimiter and the offset after the word.
 */
function heredoc(text: string, i: number): { id: string; literal: boolean; end: number } | null {
  let j = i + 2;
  if (text[j] === '-') j++;
  while (text[j] === ' ' || text[j] === '\t') j++;
  let id = '';
  let literal = false;
  for (; j < text.length && !isBlank(text[j]) && !';|&()<>`'.includes(text[j] as string); j++) {
    const c = text[j] as string;
    if (c === '\\') {
      if (j + 1 >= text.length || isBlank(text[j + 1])) return null;
      literal = true;
      id += text[++j];
    } else if (c === "'" || c === '"') {
      let close = j + 1;
      while (close < text.length && text[close] !== c && text[close] !== '\n') close++;
      if (text[close] !== c) return null;
      literal = true;
      id += text.slice(j + 1, close);
      j = close;
    } else id += c;
  }
  if (id === '' && !literal) return null;
  // Shells read `<<20` as a heredoc too, but a digit there is almost always a shift outside
  // `$((…))`, such as `SIZE=1<<20` in a .env file or a Dockerfile ENV, which no shell expands.
  if (!literal && /^[0-9]/.test(id)) return null;
  return { id, literal, end: j };
}

/** Whether only blanks come before `i` on its line. */
function firstOnLine(text: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t' || text[j] === '\f')) j--;
  return j < 0 || text[j] === '\n' || text[j] === '\r';
}

function lexHash(opts: HashOptions, text: string): Span[] {
  const out: Span[] = [];
  const n = text.length;
  let i = 0;
  let wordStart = -1;
  let pendingHeredoc: { id: string; literal: boolean } | null = null;
  // Parentheses open since a `((`: inside `$((…))` and `((…))`, `<<` is a shift.
  let arith = 0;

  const endWord = (end: number): void => {
    if (wordStart !== -1 && end > wordStart) out.push({ start: wordStart, end, kind: 'value' });
    wordStart = -1;
  };

  const lineEnd = (from: number): number => {
    const j = text.indexOf('\n', from);
    return j === -1 ? n : j;
  };

  while (i < n) {
    const c = text[i] as string;

    if (c === '\n' && pendingHeredoc) {
      endWord(i);
      // The heredoc body starts on the next line and ends at a line holding only the identifier.
      const bodyStart = i + 1;
      let j = bodyStart;
      let end = n;
      let next = n;
      while (j < n) {
        const eol = lineEnd(j);
        if (text.slice(j, eol).replace(/\r$/, '').trim() === pendingHeredoc.id) {
          end = j;
          next = eol;
          break;
        }
        j = eol + 1;
      }
      const span: Span = { start: bodyStart, end, kind: 'value' };
      if (!pendingHeredoc.literal && text.slice(bodyStart, end).includes('$')) {
        span.interpolated = true;
      }
      out.push(span);
      pendingHeredoc = null;
      i = next;
      continue;
    }

    if (opts.quoting === 'shell') {
      if (c === '(' && (arith > 0 || text[i + 1] === '(')) arith++;
      else if (c === ')' && arith > 0) arith--;
    }
    if (isBlank(c) || (opts.separators.includes(c) && c !== '<')) {
      endWord(i);
      i++;
      continue;
    }

    // Words end at blanks and separators, so `wordStart === -1` means "at the start of a word".
    const commentStart =
      (c === '#' && (opts.hash === 'anywhere' || wordStart === -1)) ||
      (c === ';' && opts.semicolon && wordStart === -1) ||
      // Java's .properties files take `!` for a comment too, first on its line.
      (c === '!' && opts.quoting === 'ini' && wordStart === -1 && firstOnLine(text, i));
    if (commentStart) {
      endWord(i);
      const end = lineEnd(i);
      out.push({ start: i, end, kind: 'comment' });
      i = end;
      continue;
    }

    if (opts.quoting === 'shell' && c === '<' && text[i + 1] === '<') {
      if (text[i + 2] === '<') {
        // A here-string, `<<< word`: the word is lexed as usual.
        endWord(i);
        i += 3;
        continue;
      }
      const doc = arith === 0 ? heredoc(text, i) : null;
      if (doc) {
        endWord(i);
        pendingHeredoc = { id: doc.id, literal: doc.literal };
        // The rest of the line is lexed normally; the body starts on the next line.
        i = doc.end;
        continue;
      }
    }
    if (c === '<' && opts.separators.includes('<')) {
      endWord(i);
      i++;
      continue;
    }

    if (c === '"' || c === "'") {
      endWord(i);
      const shellDouble = c === '"' && opts.quoting === 'shell';
      i = shellDouble ? doubleQuoted(text, i, out) : quoted(opts, text, i, out);
      continue;
    }

    if (c === '\\' && opts.quoting === 'shell') {
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

/**
 * Lexes a quoted string starting at `i`, other than a shell double-quoted one; pushes its span and
 * returns the offset after it.
 */
function quoted(opts: HashOptions, text: string, i: number, out: Span[]): number {
  const n = text.length;
  const q = text[i] as string;
  const triple = opts.quoting === 'toml' && text.startsWith(q.repeat(3), i);
  const delim = triple ? q.repeat(3) : q;
  const multiline = triple || opts.quoting === 'shell';
  const escapes = q === '"' && opts.quoting !== 'ini';
  const start = i + delim.length;
  let j = start;
  while (j < n) {
    const c = text[j];
    if (c === '\n' && !multiline) break;
    if (escapes && c === '\\') {
      j += 2;
      continue;
    }
    if (text.startsWith(delim, j)) {
      pushString(out, start, j, i, false);
      return j + delim.length;
    }
    j++;
  }
  pushString(out, start, Math.min(j, n), i, false);
  return Math.min(j, n);
}

/**
 * The start of a parameter expansion whose word is a value (POSIX 2.6.2): `${NAME:-word}` and
 * `${NAME-word}` use it when NAME is unset, `:=` also assigns it, `:+` uses it when NAME is set.
 */
const VALUE_EXPANSION = /^\$\{(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+):?[-=+]/;

/**
 * Lexes a shell double-quoted string starting at `i`, one string segment per literal part, and
 * returns the offset after it. Expansions are code, but the word of `${MODEL:-gpt-4o}` is a literal
 * of the string too.
 */
function doubleQuoted(text: string, i: number, out: Span[]): number {
  const n = text.length;
  let start = i + 1;
  let interpolated = false;
  // How many `${NAME:-` words are open; a quote inside one doesn't end the string.
  let words = 0;
  let j = start;
  while (j < n) {
    const c = text[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (words > 0 && (c === '}' || c === '\n')) {
      // The word ends at its brace, or at the end of the line if the brace is missing.
      pushString(out, start, j, i, true);
      words = c === '}' ? words - 1 : 0;
      start = c === '}' ? j + 1 : j;
      j++;
      continue;
    }
    if (c === '"' && words === 0) {
      pushString(out, start, j, i, interpolated);
      return j + 1;
    }
    if (c === '$') {
      const value = VALUE_EXPANSION.exec(text.slice(j, j + 80));
      const next = text[j + 1];
      if (value || next === '(' || next === '{') {
        pushString(out, start, j, i, true);
        interpolated = true;
        if (value) {
          words++;
          j += value[0].length;
        } else j = skipBalanced(text, j + 1, '\\');
        start = j;
        continue;
      }
      if (next !== undefined && /[A-Za-z_0-9@*#?$!-]/.test(next)) interpolated = true;
    }
    j++;
  }
  pushString(out, start, n, i, interpolated);
  return n;
}

function pushString(out: Span[], start: number, end: number, open: number, interp: boolean): void {
  const span: Span = { start, end: Math.max(start, end), kind: 'string', open };
  if (interp) {
    span.interpolated = true;
    // Earlier segments of the same literal are interpolated too. Once one is, all before it are,
    // so the walk stops there and each segment is marked once.
    for (let k = out.length - 1; k >= 0 && out[k]?.open === open && !out[k]?.interpolated; k--) {
      (out[k] as Span).interpolated = true;
    }
  }
  out.push(span);
}

function hashLexer(languages: Language[], opts: HashOptions): Lexer {
  return { languages, lex: (text) => lexHash(opts, text) };
}

/**
 * A Ruby heredoc at `i` (on `<<`): `<<ID`, `<<-ID` or `<<~ID`, the ID bare or in `'`, `"` or
 * backticks; `'ID'` turns off interpolation. The body starts on the next line, and the rest of the
 * opening line isn't lexed.
 */
function rubyHeredoc(text: string, i: number): StringStart | null {
  let j = i + 2;
  const indented = text[j] === '-' || text[j] === '~';
  if (indented) j++;
  const q = text[j] === "'" || text[j] === '"' || text[j] === '`' ? text[j] : '';
  if (q) j++;
  const id = /^[A-Za-z_]\w*/.exec(text.slice(j, j + 128))?.[0];
  if (!id || (q && text[j + id.length] !== q)) return null;
  // `x <<value` appends; heredoc identifiers are capitalized by convention.
  if (!indented && !/^[A-Z_]/.test(id)) return null;
  const eol = text.indexOf('\n', j);
  const literal = q === "'";
  return simple(eol === -1 ? text.length : eol + 1, '', {
    multiline: true,
    escape: literal ? 'none' : 'backslash',
    interp: literal ? 'none' : 'ruby',
    heredoc: id,
  });
}

const PAIRS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}', '<': '>' };

/** Whether the code before `i` ends with an operand, making a `%` there the modulo operator. */
function afterOperand(text: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--;
  return j >= 0 && /[\w)\]}"'`]/.test(text[j] as string);
}

/**
 * A percent literal at `i` (on `%`): `%w[…]`, `%i(…)`, `%q{…}`, `%Q<…>`, `%(…)` and the like, whose
 * brackets nest; `%q`, `%w`, `%i` and `%s` don't interpolate. Ruby allows other punctuation as
 * delimiters too, but brackets are the usual ones, and a `%\` in a regex such as `/<%\s/` (which
 * this lexer doesn't skip) mustn't open a string.
 */
function percentLiteral(text: string, i: number): StringStart | null {
  let j = i + 1;
  const kind = text[j] !== undefined && 'qQwWiIsrx'.includes(text[j] as string) ? text[j++] : '';
  const open = text[j] as string;
  const close = PAIRS[open];
  // `x %(3)` is arithmetic.
  if (!close || (!kind && afterOperand(text, i))) return null;
  return simple(j + 1, close, {
    multiline: true,
    interp: kind && 'qwis'.includes(kind) ? 'none' : 'ruby',
    nest: open,
    words: !!kind && 'wWiI'.includes(kind),
  });
}

const ruby: Flavor = {
  slashComments: false,
  nestedComments: false,
  hashComments: 'anywhere',
  regexLiterals: false,
  phpTags: false,
  string(text, i) {
    const c = text[i];
    if (c === "'") return simple(i + 1, "'", { multiline: true });
    if (c === '"' || c === '`') return simple(i + 1, c, { multiline: true, interp: 'ruby' });
    if (c === '<' && text[i + 1] === '<') return rubyHeredoc(text, i);
    if (c === '%') return percentLiteral(text, i);
    return null;
  },
};

const RAW_DELIMITERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}', '|': '|' };

/**
 * R, after its parser (src/main/gram.y): `#` comments, `'` and `"` strings that may span lines, and
 * raw strings such as `r"(…)"` or `R'--[…]--'`.
 */
const r: Flavor = {
  slashComments: false,
  nestedComments: false,
  hashComments: 'anywhere',
  regexLiterals: false,
  phpTags: false,
  string(text, i) {
    const c = text[i];
    if (c === '"' || c === "'") return simple(i + 1, c, { multiline: true });
    const quote = text[i + 1];
    if ((c === 'r' || c === 'R') && (quote === '"' || quote === "'")) {
      const dashes = run(text, i + 2, '-');
      const close = RAW_DELIMITERS[text[i + 2 + dashes] as string];
      if (close) {
        return simple(i + 3 + dashes, close + '-'.repeat(dashes) + quote, {
          multiline: true,
          escape: 'none',
        });
      }
    }
    return null;
  },
};

export const shellLexer = hashLexer(['shell'], {
  hash: 'word-start',
  semicolon: false,
  quoting: 'shell',
  separators: ';|&()<>`',
});

export const HASH_LEXERS: readonly Lexer[] = [
  shellLexer,
  hashLexer(['toml'], {
    hash: 'anywhere',
    semicolon: false,
    quoting: 'toml',
    separators: '[]{},=',
  }),
  hashLexer(['ini'], { hash: 'word-start', semicolon: true, quoting: 'ini', separators: '=:' }),
  { languages: ['ruby'], lex: (text) => lexWith(ruby, text) },
  { languages: ['r'], lex: (text) => lexWith(r, text) },
];
