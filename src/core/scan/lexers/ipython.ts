// The lexer for the code cells of a Python notebook: Python, plus the syntax IPython adds to it, as
// IPython's input transformer reads it (IPython/core/inputtransformer2.py):
// - A cell magic on the first line of a cell runs the rest of the cell in another program, so the
//   rest is lexed in that program's language: `%%bash`, `%%script ruby`, `%%js`. `%%writefile <path>`
//   writes it to a file, so it is lexed in the language of the path, or is one value. `%%time`,
//   `%%timeit`, `%%capture`, `%%prun` and `%%debug` run it as a cell.
// - A line that starts a statement with `!` (`!pip install x`), or assigns one (`files = !ls`), is a
//   shell command.
// - A line magic (`%env MODEL=x`, `%run eval.py x`) takes arguments like a command line, except
//   `%time`, `%timeit`, `%prun` and `%debug`, which take Python code.
// A `!` or `%` line runs to the end of the line, and on through lines that end in `\`.
import { own } from '../../own.ts';
import type { Lexer } from '../../ports.ts';
import type { Language, Span, Spans } from '../../types.ts';
import { languageOf } from '../classify.ts';
import { isIdentChar, lexPart } from './engine.ts';
import { shellLexer } from './hash.ts';
import { lexerFor } from './index.ts';
import { pythonLexer } from './python.ts';

/** Programs that `%%script` can run a cell in, and IPython's cell magics named after them. */
const PROGRAMS: Readonly<Record<string, Language>> = {
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  python: 'python',
  python2: 'python',
  python3: 'python',
  pypy: 'python',
  ruby: 'ruby',
  node: 'javascript',
  pwsh: 'powershell',
  R: 'r',
};

/** Other cell magics whose body is in another language: `%%!` and `%%sx` run it in a shell. */
const CELL_MAGICS: Readonly<Record<string, Language>> = {
  '!': 'shell',
  sx: 'shell',
  system: 'shell',
  javascript: 'javascript',
  js: 'javascript',
  html: 'html',
  HTML: 'html',
};

/** Magics whose body, or argument, is Python code. */
const CODE_MAGICS: ReadonlySet<string> = new Set(['time', 'timeit', 'capture', 'prun', 'debug']);

/** The words of a magic's arguments, as a shell splits them, without their quotes. */
const words = (args: string): string[] =>
  [...args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');

/** The program of `%%script [options] <program>`: the first word that isn't an option. */
function scriptProgram(args: string): string {
  const list = words(args);
  for (let k = 0; k < list.length; k++) {
    const word = list[k] as string;
    if (word === '--out' || word === '--err' || word === '--proc') k++;
    else if (!word.startsWith('-')) return word.slice(word.lastIndexOf('/') + 1);
  }
  return '';
}

interface CellMagic {
  name: string;
  /** Where its arguments are, on its line. */
  argsStart: number;
  argsEnd: number;
  /** Where the next line starts. */
  body: number;
}

/** The cell magic on the first line from `start` that isn't blank, if it starts with `%%`. */
function cellMagic(text: string, start: number): CellMagic | null {
  for (let i = start; i < text.length; ) {
    const eol = text.indexOf('\n', i);
    const end = eol === -1 ? text.length : eol;
    const line = text.slice(i, end);
    if (line.trim() !== '') {
      const magic = /^[ \t]*%%(\S*)/.exec(line);
      if (!magic) return null;
      return {
        name: magic[1] as string,
        argsStart: i + magic[0].length,
        argsEnd: end,
        body: Math.min(end + 1, text.length),
      };
    }
    i = end + 1;
  }
  return null;
}

/** A blank that may indent a line of Python. */
const isIndent = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\f';

/** Where the line at `i` ends, following lines that end in `\`. */
function continuedLineEnd(text: string, i: number, end: number): number {
  let eol = text.indexOf('\n', i);
  while (eol !== -1 && eol < end && text[eol - 1] === '\\') eol = text.indexOf('\n', eol + 1);
  return eol === -1 || eol > end ? end : eol;
}

/**
 * Whether a quote at `i` opens a string, as the Python lexer decides: not right after a word, unless
 * the word is a prefix such as `f` or `rb`.
 */
function opensString(text: string, i: number): boolean {
  let k = i;
  while (k > 0 && i - k < 3 && isIdentChar(text.charCodeAt(k - 1))) k--;
  if (k === i) return true;
  return (
    i - k <= 2 && /^[rRbBuUfFtT]+$/.test(text.slice(k, i)) && !isIdentChar(text.charCodeAt(k - 1))
  );
}

/** Skips the string whose quote is at `i`; returns the offset after it. */
function skipString(text: string, i: number, end: number): number {
  const q = text[i] as string;
  const triple = text[i + 1] === q && text[i + 2] === q;
  for (let j = triple ? i + 3 : i + 1; j < end; j++) {
    const c = text[j];
    if (c === '\\') j++;
    else if (triple ? text.startsWith(q.repeat(3), j) : c === q) return j + (triple ? 3 : 1);
    // A string in single quotes ends at the end of its line, as the lexer reads it.
    else if (c === '\n' && !triple) return j;
  }
  return end;
}

/**
 * The escapes in Python code `[start, end)`: a line that starts a statement with `!` or `%`, or
 * whose first `=` is followed by one. Each runs from its `!` or `%` to the end of its line.
 */
function escapedLines(text: string, start: number, end: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let depth = 0;
  // At the start of a statement: no brackets open, after a line that doesn't end in `\`.
  let statement = true;
  // Whether the statement has had its first `=`.
  let assigned = false;
  let i = start;
  while (i < end) {
    if (statement) {
      statement = false;
      assigned = false;
      while (i < end && isIndent(text[i])) i++;
      if ((text[i] === '!' && text[i + 1] !== '=') || text[i] === '%') {
        const stop = continuedLineEnd(text, i, end);
        out.push({ start: i, end: stop });
        i = stop;
        continue;
      }
    }
    const c = text[i];
    if (c === '\n') {
      statement = depth === 0;
      i++;
    } else if (c === '\\') {
      // A `\` before the end of a line continues the statement on the next line.
      i += text[i + 1] === '\r' ? 3 : 2;
    } else if (c === '#') {
      const eol = text.indexOf('\n', i);
      i = eol === -1 || eol > end ? end : eol;
    } else if ((c === '"' || c === "'") && opensString(text, i)) {
      i = skipString(text, i, end);
    } else if (c === '(' || c === '[' || c === '{') {
      depth++;
      i++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (c === '=' && depth === 0 && !assigned && isAssignment(text, i)) {
      assigned = true;
      let j = i + 1;
      while (j < end && isIndent(text[j])) j++;
      const escaped =
        (text[j] === '!' && text[j + 1] !== '=') ||
        (text[j] === '%' && isIdentChar(text.charCodeAt(j + 1)));
      if (escaped) {
        const stop = continuedLineEnd(text, j, end);
        out.push({ start: j, end: stop });
        i = stop;
      } else i = j;
    } else i++;
  }
  return out;
}

/** Whether the `=` at `i` assigns, rather than being part of `==`, `!=`, `<=`, `+=` and the like. */
const isAssignment = (text: string, i: number): boolean =>
  text[i + 1] !== '=' && !/[=!<>:+\-*/%&|^@~]/.test(text[i - 1] ?? '');

/** A `!` command or a `%` line magic, `[start, end)`. */
function lexEscaped(text: string, start: number, end: number, out: Span[]): void {
  if (text[start] === '!') {
    lexPart(shellLexer, text, text[start + 1] === '!' ? start + 2 : start + 1, end, out);
    return;
  }
  const magic = /^%+(\w*)/.exec(text.slice(start, Math.min(end, start + 64))) as RegExpExecArray;
  const lexer = CODE_MAGICS.has(magic[1] as string) ? pythonLexer : shellLexer;
  lexPart(lexer, text, start + magic[0].length, end, out);
}

/** Python code `[start, end)` of a cell, with its `!` and `%` lines. */
function lexCode(text: string, start: number, end: number, out: Span[]): Span[] {
  let from = start;
  for (const line of escapedLines(text, start, end)) {
    lexPart(pythonLexer, text, from, line.start, out);
    lexEscaped(text, line.start, line.end, out);
    from = line.end;
  }
  return lexPart(pythonLexer, text, from, end, out);
}

function lexCell(text: string): Spans {
  const out: Span[] = [];
  let start = 0;
  let magic = cellMagic(text, start);
  // `%%time` and the like run the rest as a cell, which may start with a cell magic itself. Their
  // arguments are Python too: `%%timeit` takes a setup statement.
  while (magic && CODE_MAGICS.has(magic.name)) {
    lexPart(pythonLexer, text, magic.argsStart, magic.argsEnd, out);
    start = magic.body;
    magic = cellMagic(text, start);
  }
  if (!magic) return lexCode(text, start, text.length, out);
  const { name, body } = magic;
  const args = text.slice(magic.argsStart, magic.argsEnd);
  if (name === 'writefile' || name === 'file') {
    const path = words(args).find((word) => !word.startsWith('-'));
    const language = path ? languageOf(path) : null;
    if (language) return lexPart(lexerFor(language), text, body, text.length, out);
    const end = text.trimEnd().length;
    if (end > body) out.push({ start: body, end, kind: 'value' });
    return out;
  }
  const language =
    own(PROGRAMS, name === 'script' ? scriptProgram(args) : name) ?? own(CELL_MAGICS, name);
  // Other cell magics, such as `%%sql`, keep the Python reading of the cell.
  return lexPart(
    language ? lexerFor(language) : pythonLexer,
    text,
    language ? body : start,
    text.length,
    out,
  );
}

export const ipythonLexer: Lexer = { languages: ['python'], lex: lexCell };
