// The C-like lexers: JS/TS (incl. JSX/TSX), Java, Kotlin, C#, Go, Rust, Swift, C/C++,
// PHP, Scala, Dart and Bicep. They share one engine and differ in their string syntax.
import type { Lexer } from '../../ports.ts';
import type { Language } from '../../types.ts';
import {
  charLiteral,
  type Flavor,
  heredocStart,
  isIdentChar,
  lexWith,
  run,
  type StringStart,
  simple,
} from './engine.ts';

const base: Omit<Flavor, 'string'> = {
  slashComments: true,
  nestedComments: false,
  hashComments: 'none',
  regexLiterals: false,
  phpTags: false,
  // JavaScript (ECMA-262, "Hashbang Comments"), Rust (the Reference's "Shebang") and other script
  // runners allow one. Where a language doesn't, a file can't validly start with `#!` anyway.
  hashbang: true,
};

function lexer(languages: Language[], flavor: Partial<Flavor> & Pick<Flavor, 'string'>): Lexer {
  const full: Flavor = { ...base, ...flavor };
  return { languages, lex: (text) => lexWith(full, text) };
}

export const javascript = lexer(['javascript'], {
  regexLiterals: true,
  quotesAfterWord: '"`',
  string(text, i) {
    const c = text[i];
    if (c === '"' || c === "'") return simple(i + 1, c);
    if (c === '`') return simple(i + 1, '`', { multiline: true, interp: 'dollar-brace' });
    return null;
  },
});

const java = lexer(['java'], {
  string(text, i) {
    if (text.startsWith('"""', i)) return simple(i + 3, '"""', { multiline: true });
    const c = text[i];
    if (c === '"' || c === "'") return simple(i + 1, c);
    return null;
  },
});

const kotlin = lexer(['kotlin'], {
  nestedComments: true,
  string(text, i) {
    if (text.startsWith('"""', i)) {
      return simple(i + 3, '"""', { multiline: true, escape: 'none', interp: 'dollar' });
    }
    if (text[i] === '"') return simple(i + 1, '"', { interp: 'dollar' });
    if (text[i] === "'") return simple(i + 1, "'");
    return null;
  },
});

const csharp = lexer(['csharp'], {
  string(text, i) {
    let j = i;
    const dollars = run(text, j, '$');
    j += dollars;
    const quotes = run(text, j, '"');
    if (quotes >= 3) {
      return simple(j + quotes, '"'.repeat(quotes), {
        multiline: true,
        escape: 'none',
        interp: dollars > 0 ? 'brace' : 'none',
        holeBraces: dollars,
      });
    }
    // `@"…"`, `$@"…"` and `@$"…"`: verbatim, `""` escapes a quote.
    const verbatim =
      (text[j] === '@' && text[j + 1] === '"') ||
      (dollars === 0 && text[i] === '@' && text[i + 1] === '$' && text[i + 2] === '"');
    if (verbatim) {
      const interp = dollars > 0 || text[i + 1] === '$';
      const contentStart = text.indexOf('"', i) + 1;
      return simple(contentStart, '"', {
        escape: 'double',
        multiline: true,
        interp: interp ? 'brace' : 'none',
      });
    }
    if (text[j] === '"' && dollars <= 1) {
      return simple(j + 1, '"', { interp: dollars === 1 ? 'brace' : 'none' });
    }
    if (dollars === 0 && text[i] === "'") return simple(i + 1, "'");
    return null;
  },
});

const go = lexer(['go'], {
  string(text, i) {
    const c = text[i];
    if (c === '`') return simple(i + 1, '`', { multiline: true, escape: 'none' });
    if (c === '"' || c === "'") return simple(i + 1, c);
    return null;
  },
});

const rust = lexer(['rust'], {
  nestedComments: true,
  string(text, i) {
    let j = i;
    if (text[j] === 'b' || text[j] === 'c') j++;
    if (text[j] === 'r') {
      const hashes = run(text, j + 1, '#');
      if (text[j + 1 + hashes] === '"') {
        return simple(j + 2 + hashes, `"${'#'.repeat(hashes)}`, {
          multiline: true,
          escape: 'none',
        });
      }
      return null;
    }
    if (text[j] === '"') return simple(j + 1, '"', { multiline: true });
    if (text[j] === "'") return charLiteral(text, j);
    return null;
  },
});

const swift = lexer(['swift'], {
  nestedComments: true,
  string(text, i) {
    const hashes = run(text, i, '#');
    const j = i + hashes;
    const triple = text.startsWith('"""', j);
    if (text[j] !== '"') return null;
    const delim = triple ? '"""' : '"';
    if (hashes > 0) {
      return simple(j + delim.length, delim + '#'.repeat(hashes), {
        multiline: triple,
        escape: 'none',
      });
    }
    return simple(j + delim.length, delim, { multiline: triple, interp: 'paren' });
  },
});

const C_PREFIXES = ['u8', 'u', 'U', 'L', ''];

const c = lexer(['c'], {
  string(text, i) {
    for (const prefix of C_PREFIXES) {
      if (!text.startsWith(prefix, i)) continue;
      const j = i + prefix.length;
      if (text[j] === 'R' && text[j + 1] === '"') {
        // The delimiter before `(` is at most 16 characters.
        const paren = text.slice(j + 2, j + 19).indexOf('(');
        const delim = paren === -1 ? '' : text.slice(j + 2, j + 2 + paren);
        if (paren !== -1 && !/[\s\\)]/.test(delim)) {
          return simple(j + 3 + paren, `)${delim}"`, { multiline: true, escape: 'none' });
        }
        return null;
      }
      if (text[j] === '"') return simple(j + 1, '"');
      if (text[j] === "'") return simple(j + 1, "'");
    }
    return null;
  },
});

const php = lexer(['php'], {
  hashComments: 'php',
  phpTags: true,
  string(text, i) {
    const c = text[i];
    if (c === "'") return simple(i + 1, "'", { multiline: true });
    if (c === '"' || c === '`') return simple(i + 1, c, { multiline: true, interp: 'php' });
    const doc = heredocStart(text, i, '<<<');
    if (doc) {
      return simple(doc.contentStart, '', {
        multiline: true,
        escape: doc.literal ? 'none' : 'backslash',
        interp: doc.literal ? 'none' : 'php',
        heredoc: doc.id,
      });
    }
    return null;
  },
});

const scala = lexer(['scala'], {
  nestedComments: true,
  string(text, i) {
    // An interpolator is an identifier directly followed by a quote: s"…", f"…", raw"…", sql"…".
    let j = i;
    while (j < text.length && isIdentChar(text.charCodeAt(j)) && text[j] !== '$') j++;
    const prefix = text.slice(i, j);
    const interp = prefix ? 'dollar' : 'none';
    const escapes = prefix === 'raw' ? 'none' : 'backslash';
    if (text.startsWith('"""', j)) {
      return simple(j + 3, '"""', { multiline: true, escape: 'none', interp });
    }
    if (text[j] === '"') return simple(j + 1, '"', { escape: escapes, interp });
    if (!prefix && text[i] === "'") return charLiteral(text, i);
    return null;
  },
});

const dart = lexer(['dart'], {
  string(text, i) {
    const raw = text[i] === 'r';
    const j = raw ? i + 1 : i;
    const q = text[j];
    if (q !== '"' && q !== "'") return null;
    const opts = raw
      ? ({ escape: 'none', interp: 'none' } as const)
      : ({ escape: 'backslash', interp: 'dollar' } as const);
    if (text.startsWith(q.repeat(3), j)) {
      return simple(j + 3, q.repeat(3), { ...opts, multiline: true });
    }
    return simple(j + 1, q, opts);
  },
});

const bicep = lexer(['bicep'], {
  string(text, i): StringStart | null {
    if (text.startsWith("'''", i)) {
      return simple(i + 3, "'''", { multiline: true, escape: 'none' });
    }
    if (text[i] === "'") return simple(i + 1, "'", { interp: 'dollar-brace' });
    return null;
  },
});

export const C_LIKE_LEXERS: readonly Lexer[] = [
  javascript,
  java,
  kotlin,
  csharp,
  go,
  rust,
  swift,
  c,
  php,
  scala,
  dart,
  bicep,
];
