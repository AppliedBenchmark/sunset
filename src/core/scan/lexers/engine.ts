// A configurable string-and-comment lexer shared by the C-like, Python, JSON, HCL and Ruby lexers.
// It never recurses: interpolation holes (`${…}`, f-string fields, …) live on an
// explicit stack, so deep nesting can't overflow, and every step advances or changes the stack
// in a way that is paid for by a later advance, so the run time stays linear in the input.
import type { Lexer } from '../../ports.ts';
import type { Span } from '../../types.ts';

/** How a string literal embeds expressions. */
export type Interp =
  | 'none'
  /** `${expr}` (JS templates, Bicep). */
  | 'dollar-brace'
  /** `${expr}` and `$name` (Kotlin, Dart, Scala). */
  | 'dollar'
  /** `{expr}` with `{{` as an escape (C# `$"…"`, Python f-strings). */
  | 'brace'
  /** `\(expr)` (Swift). */
  | 'paren'
  /** `{$expr}` and `$name` (PHP). */
  | 'php'
  /** `#{expr}` (Ruby). */
  | 'ruby'
  /** `${expr}` and `%{directive}`, with `$${` and `%%{` as escapes (HCL). */
  | 'hcl';

export interface StringStart {
  /** Offset of the first content character. */
  contentStart: number;
  /** The closing delimiter. Ignored for heredocs. */
  close: string;
  /** `backslash`: `\` skips the next character. `double`: a doubled closer is an escape. */
  escape: 'backslash' | 'double' | 'none';
  multiline: boolean;
  interp: Interp;
  /** For C# raw strings: the number of braces that open a hole. */
  holeBraces?: number;
  /** For heredocs: the line that ends the string, optionally indented. */
  heredoc?: string;
  /** For paired delimiters that nest, such as Ruby's `%w[…]`: the opening one. */
  nest?: string;
  /** For Ruby's `%w[…]` and `%i[…]`: the content is a list of words, each its own string. */
  words?: boolean;
}

export interface Flavor {
  /** `//` line comments and `/* … *\/` block comments. */
  slashComments: boolean;
  nestedComments: boolean;
  /** `#` line comments: anywhere outside strings, or PHP's form (not `#[`). */
  hashComments: 'none' | 'anywhere' | 'php';
  /** JavaScript regular-expression literals, so quotes inside them aren't taken as strings. */
  regexLiterals: boolean;
  /**
   * Quotes that open a literal even right after a word, where a quote is usually prose (`Don't`,
   * `13"`). In JavaScript, a backtick or `"` there is a tagged template (`` sql`…` ``) or minified
   * code (`return"x"`).
   */
  quotesAfterWord?: string;
  /** Only text between `<?php` and `?>` is code. */
  phpTags: boolean;
  /** A `#!` line at the very start is a comment, unless `[` follows (Rust's `#![attr]`). */
  hashbang?: boolean;
  /** Recognizes a string literal (prefix included) starting at `i`, or returns null. */
  string(text: string, i: number): StringStart | null;
}

interface CodeFrame {
  type: 'code';
  /** The character that ends this hole, or null for the top level. */
  closer: '}' | ')' | null;
  depth: number;
  /** How many closers end the hole (C# raw strings with `$$`). */
  closers: number;
}

interface StringFrame {
  type: 'string';
  s: StringStart;
  open: number;
  segStart: number;
  spans: Span[];
  interpolated: boolean;
  /** Nested opening delimiters not yet closed (see StringStart.nest). */
  depth: number;
}

type Frame = CodeFrame | StringFrame;

export function isIdentChar(code: number): boolean {
  return (
    (code >= 97 && code <= 122) || // a-z
    (code >= 65 && code <= 90) || // A-Z
    (code >= 48 && code <= 57) || // 0-9
    code === 95 || // _
    code === 36 // $
  );
}

function isIdentStart(code: number): boolean {
  return isIdentChar(code) && !(code >= 48 && code <= 57) && code !== 36;
}

const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

const REGEX_AFTER = new Set('(,=:[!&|?{};+-*%<>~^');

export function lexWith(flavor: Flavor, text: string): Span[] {
  const out: Span[] = [];
  const n = text.length;
  const stack: Frame[] = [{ type: 'code', closer: null, depth: 0, closers: 1 }];
  let i = 0;
  let html = flavor.phpTags;
  // For regex-literal detection: the last significant code character and word.
  let lastSig = '';
  let lastWord = '';

  if (flavor.hashbang && text.startsWith('#!') && !/^#!\s*\[/.test(text)) {
    i = text.indexOf('\n');
    if (i === -1) i = n;
    out.push({ start: 0, end: i, kind: 'comment' });
  }

  const emitSegment = (frame: StringFrame, end: number): void => {
    const push = (start: number, stop: number): void => {
      const span: Span = { start, end: stop, kind: 'string', open: frame.open };
      if (frame.interpolated) span.interpolated = true;
      frame.spans.push(span);
      out.push(span);
    };
    if (!frame.s.words) {
      push(frame.segStart, end);
      return;
    }
    for (const word of text.slice(frame.segStart, end).matchAll(/\S+/g)) {
      push(frame.segStart + word.index, frame.segStart + word.index + word[0].length);
    }
  };

  const openHole = (
    frame: StringFrame,
    segEnd: number,
    codeStart: number,
    closer: '}' | ')',
    closers = 1,
  ): number => {
    emitSegment(frame, segEnd);
    if (!frame.interpolated) {
      frame.interpolated = true;
      for (const span of frame.spans) span.interpolated = true;
    }
    stack.push({ type: 'code', closer, depth: 0, closers });
    lastSig = closer === '}' ? '{' : '(';
    lastWord = '';
    return codeStart;
  };

  /** A `$name` reference inside a string: ends the segment and starts a new one after it. */
  const simpleRef = (frame: StringFrame, i: number): number => {
    let j = i + 1;
    while (j < n && isIdentChar(text.charCodeAt(j)) && text.charCodeAt(j) !== 36) j++;
    emitSegment(frame, i);
    if (!frame.interpolated) {
      frame.interpolated = true;
      for (const span of frame.spans) span.interpolated = true;
    }
    frame.segStart = j;
    return j;
  };

  const atLineStart = (pos: number, contentStart: number): boolean =>
    pos === contentStart || text.charCodeAt(pos - 1) === 10;

  const stepString = (frame: StringFrame, i: number): number => {
    const s = frame.s;
    const c = text.charCodeAt(i);

    if (s.heredoc !== undefined && atLineStart(i, s.contentStart)) {
      let j = i;
      while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
      if (
        text.startsWith(s.heredoc, j) &&
        !isIdentChar(text.charCodeAt(j + s.heredoc.length) || 0)
      ) {
        emitSegment(frame, i);
        stack.pop();
        return j + s.heredoc.length;
      }
    }

    if (c === 10 && !s.multiline) {
      // Unterminated on this line: end the literal here so one stray quote can't swallow the file.
      emitSegment(frame, i);
      stack.pop();
      return i;
    }

    if (s.interp === 'paren' && c === 92 && text.charCodeAt(i + 1) === 40) {
      return openHole(frame, i, i + 2, ')');
    }
    if (s.escape === 'backslash' && c === 92) return i + 2;

    if (s.nest !== undefined) {
      if (text.startsWith(s.nest, i)) {
        frame.depth++;
        return i + s.nest.length;
      }
      if (frame.depth > 0 && text.startsWith(s.close, i)) {
        frame.depth--;
        return i + s.close.length;
      }
    }

    if (s.heredoc === undefined && text.startsWith(s.close, i)) {
      if (s.escape === 'double' && text.startsWith(s.close, i + s.close.length)) {
        return i + 2 * s.close.length;
      }
      emitSegment(frame, i);
      stack.pop();
      return i + s.close.length;
    }

    switch (s.interp) {
      case 'none':
      case 'paren':
        break;
      case 'dollar-brace':
        if (c === 36 && text.charCodeAt(i + 1) === 123) return openHole(frame, i, i + 2, '}');
        break;
      case 'dollar':
        if (c === 36) {
          const next = text.charCodeAt(i + 1);
          if (next === 123) return openHole(frame, i, i + 2, '}');
          if (isIdentStart(next)) return simpleRef(frame, i);
        }
        break;
      case 'brace':
        if (c === 123) {
          let k = 1;
          while (text.charCodeAt(i + k) === 123) k++;
          const need = s.holeBraces ?? 0;
          if (need > 0) {
            // C# raw string: exactly `need` braces open a hole; extra braces are content.
            if (k >= need) return openHole(frame, i + k - need, i + k, '}', need);
            return i + k;
          }
          if (k >= 2) return i + 2; // `{{` is a literal brace
          return openHole(frame, i, i + 1, '}');
        }
        if (c === 125 && text.charCodeAt(i + 1) === 125 && !s.holeBraces) return i + 2;
        break;
      case 'php':
        if (c === 123 && text.charCodeAt(i + 1) === 36) return openHole(frame, i, i + 1, '}');
        if (c === 36 && isIdentStart(text.charCodeAt(i + 1))) return simpleRef(frame, i);
        break;
      case 'ruby':
        if (c === 35 && text.charCodeAt(i + 1) === 123) return openHole(frame, i, i + 2, '}');
        break;
      case 'hcl':
        if ((c === 36 || c === 37) && text.charCodeAt(i + 1) === c) {
          if (text.charCodeAt(i + 2) === 123) return i + 3; // `$${` or `%%{` is literal
        }
        if ((c === 36 || c === 37) && text.charCodeAt(i + 1) === 123) {
          return openHole(frame, i, i + 2, '}');
        }
        break;
    }
    return i + 1;
  };

  /** Skips a block comment starting at `i` (on `/*`); returns the offset after it. */
  const blockComment = (i: number): number => {
    let depth = 1;
    let j = i + 2;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 42 && text.charCodeAt(j + 1) === 47) {
        depth--;
        j += 2;
        if (depth === 0 || !flavor.nestedComments) return j;
        continue;
      }
      if (flavor.nestedComments && c === 47 && text.charCodeAt(j + 1) === 42) {
        depth++;
        j += 2;
        continue;
      }
      j++;
    }
    return n;
  };

  const lineEnd = (i: number): number => {
    const j = text.indexOf('\n', i);
    return j === -1 ? n : j;
  };

  /** Skips a regex literal starting at `i` (on `/`); returns null if it isn't one. */
  const regexLiteral = (i: number): number | null => {
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 10) return null;
      if (c === 92) {
        j += 2;
        continue;
      }
      if (c === 91) inClass = true;
      else if (c === 93) inClass = false;
      else if (c === 47 && !inClass) {
        j++;
        while (j < n && isIdentChar(text.charCodeAt(j))) j++; // flags
        return j;
      }
      j++;
    }
    return null;
  };

  while (i < n) {
    const top = stack[stack.length - 1] as Frame;
    if (top.type === 'string') {
      i = stepString(top, i);
      continue;
    }

    if (html) {
      const tag = text.indexOf('<?', i);
      if (tag === -1) break;
      html = false;
      i = text.startsWith('<?php', tag) ? tag + 5 : tag + 2;
      continue;
    }

    const c = text.charCodeAt(i);

    // Whitespace.
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      i++;
      continue;
    }

    // Comments.
    if (flavor.slashComments && c === 47) {
      const next = text.charCodeAt(i + 1);
      if (next === 47) {
        const end = lineEnd(i);
        out.push({ start: i, end, kind: 'comment' });
        i = end;
        continue;
      }
      if (next === 42) {
        const end = blockComment(i);
        out.push({ start: i, end, kind: 'comment' });
        i = end;
        continue;
      }
    }
    if (
      c === 35 &&
      (flavor.hashComments === 'anywhere' ||
        (flavor.hashComments === 'php' && text.charCodeAt(i + 1) !== 91))
    ) {
      const end = lineEnd(i);
      out.push({ start: i, end, kind: 'comment' });
      i = end;
      continue;
    }

    if (flavor.phpTags && c === 63 && text.charCodeAt(i + 1) === 62 && top.closer === null) {
      html = true;
      i += 2;
      continue;
    }

    // Strings (checked before identifiers, since prefixes such as `r#"` or `f"` are letters).
    const prevIdent = i > 0 && isIdentChar(text.charCodeAt(i - 1));
    if (!prevIdent || flavor.quotesAfterWord?.includes(text[i] as string)) {
      const s = flavor.string(text, i);
      if (s) {
        stack.push({
          type: 'string',
          s,
          open: i,
          segStart: s.contentStart,
          spans: [],
          interpolated: false,
          depth: 0,
        });
        lastSig = '"';
        lastWord = '';
        i = s.contentStart;
        continue;
      }
    }

    if (isIdentChar(c)) {
      let j = i + 1;
      while (j < n && isIdentChar(text.charCodeAt(j))) j++;
      lastWord = text.slice(i, j);
      lastSig = 'a';
      i = j;
      continue;
    }

    if (flavor.regexLiterals && c === 47) {
      // A JSX closing tag (`</p>`) or the end of a self-closing one after an attribute (`{x}/>`).
      const jsxTagEnd = lastSig === '<' || (lastSig === '}' && text.charCodeAt(i + 1) === 62);
      const allowed =
        !jsxTagEnd && (lastSig === '' || REGEX_AFTER.has(lastSig) || REGEX_KEYWORDS.has(lastWord));
      if (allowed) {
        const end = regexLiteral(i);
        if (end !== null) {
          lastSig = 'a';
          lastWord = '';
          i = end;
          continue;
        }
      }
    }

    // Brackets that end an interpolation hole.
    if (top.closer !== null) {
      const opener = top.closer === '}' ? 123 : 40;
      const closer = top.closer === '}' ? 125 : 41;
      if (c === opener) top.depth++;
      else if (c === closer) {
        if (top.depth === 0) {
          stack.pop();
          let j = i + 1;
          for (let k = 1; k < top.closers && text.charCodeAt(j) === closer; k++) j++;
          const parent = stack[stack.length - 1] as StringFrame;
          parent.segStart = j;
          i = j;
          continue;
        }
        top.depth--;
      }
    }

    lastSig = text[i] as string;
    lastWord = '';
    i++;
  }

  const top = stack[stack.length - 1] as Frame;
  if (top.type === 'string') emitSegment(top, n);
  return out;
}

/**
 * Lexes `text[start, end)` on its own and appends the spans to `out`, with offsets in `text`.
 * Returns `out`. The spans are appended one at a time: `out.push(...spans)` overflows the stack
 * when there are more than about 100,000.
 */
export function lexPart(
  lexer: Lexer,
  text: string,
  start: number,
  end: number,
  out: Span[] = [],
): Span[] {
  for (const span of lexer.lex(text.slice(start, end))) {
    out.push({
      ...span,
      start: span.start + start,
      end: span.end + start,
      ...(span.open !== undefined && { open: span.open + start }),
    });
  }
  return out;
}

// ── Helpers for hand-written lexers ──────────────────────────────────────────────────────────

/** A space, a tab or a line break. */
export const isBlank = (c: string | undefined): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r';

/**
 * Skips a bracketed group starting at `i` (on `(` or `{`), counting nested brackets of its kind;
 * `escapeChar` skips the character after it. Returns the offset after the group.
 */
export function skipBalanced(text: string, i: number, escapeChar: string): number {
  const open = text[i];
  const close = open === '(' ? ')' : '}';
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === escapeChar) j++;
    else if (text[j] === open) depth++;
    else if (text[j] === close && --depth === 0) return j + 1;
  }
  return text.length;
}

// ── Helpers for flavors ──────────────────────────────────────────────────────────────────────

export function simple(
  contentStart: number,
  close: string,
  opts: Partial<Omit<StringStart, 'contentStart' | 'close'>> = {},
): StringStart {
  return {
    contentStart,
    close,
    escape: opts.escape ?? 'backslash',
    multiline: opts.multiline ?? false,
    interp: opts.interp ?? 'none',
    ...(opts.holeBraces !== undefined && { holeBraces: opts.holeBraces }),
    ...(opts.heredoc !== undefined && { heredoc: opts.heredoc }),
    ...(opts.nest !== undefined && { nest: opts.nest }),
    ...(opts.words && { words: true }),
  };
}

/** Counts how many times `ch` repeats from `i`. */
export function run(text: string, i: number, ch: string): number {
  let k = 0;
  while (text[i + k] === ch) k++;
  return k;
}

/**
 * Recognizes a heredoc opener such as `<<EOT`, `<<-EOT` or PHP's `<<<'EOT'` at `i`, given the
 * introducer. Returns the identifier, whether it was quoted with `'` (no interpolation), and the
 * offset of the first content line, or null.
 */
export function heredocStart(
  text: string,
  i: number,
  introducer: string,
): { id: string; literal: boolean; contentStart: number } | null {
  if (!text.startsWith(introducer, i)) return null;
  let j = i + introducer.length;
  if (text[j] === '-' || text[j] === '~') j++;
  // Only PHP allows blanks before the identifier; elsewhere `a << b` is a shift.
  if (introducer === '<<<') while (text[j] === ' ' || text[j] === '\t') j++;
  const quote = text[j] === "'" || text[j] === '"' ? text[j] : '';
  if (quote) j++;
  const idStart = j;
  while (j < text.length && isIdentChar(text.charCodeAt(j)) && text[j] !== '$') j++;
  if (j === idStart) return null;
  const id = text.slice(idStart, j);
  if (quote) {
    if (text[j] !== quote) return null;
    j++;
  }
  // On the last line, the body is empty: it runs to the end, so no later `<<` on the line is tried.
  const eol = text.indexOf('\n', j);
  return { id, literal: quote === "'", contentStart: eol === -1 ? text.length : eol + 1 };
}

/**
 * A `'` that may be a character literal or something else (a Rust lifetime, a Scala symbol):
 * a character literal is one character, or an escape, followed by `'`.
 */
export function charLiteral(text: string, i: number): StringStart | null {
  if (text[i + 1] === '\\') return simple(i + 1, "'");
  const code = text.charCodeAt(i + 1);
  const width = code >= 0xd800 && code <= 0xdbff ? 2 : 1;
  if (text[i + 1 + width] === "'" && text[i + 1] !== '\n') return simple(i + 1, "'");
  return null;
}
