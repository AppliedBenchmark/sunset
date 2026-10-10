// Jupyter notebooks (nbformat 4, https://nbformat.readthedocs.io/en/latest/format_description.html).
// Only the cells' source is scanned: outputs and attachments hold what the code printed or drew,
// not what it calls. The reader decodes just the parts it needs and skips the rest of the JSON, and
// it keeps track of where each decoded character is in the file, so locations point into the .ipynb.
import { own } from '../own.ts';
import type { Lexer } from '../ports.ts';
import type { Language, Span } from '../types.ts';
import { lexPart } from './lexers/engine.ts';
import { lexerFor } from './lexers/index.ts';
import { ipythonLexer } from './lexers/ipython.ts';

export interface Cell {
  /** A code cell; markdown, raw and unknown cells are prose. */
  code: boolean;
  /** The source, decoded and joined. */
  text: string;
  /** Offsets in `text` where a run of characters starts, ascending. */
  at: number[];
  /** Where each run starts in the file. Within a run, both advance together. */
  file: number[];
}

export interface Notebook {
  /** The language to lex code cells in. */
  language: Language;
  cells: Cell[];
}

/** Kernel languages that have a lexer. Others, such as Julia, are lexed as Python. */
const KERNEL_LANGUAGES: Readonly<Record<string, Language>> = {
  python: 'python',
  javascript: 'javascript',
  typescript: 'javascript',
  java: 'java',
  kotlin: 'kotlin',
  scala: 'scala',
  'c#': 'csharp',
  csharp: 'csharp',
  go: 'go',
  rust: 'rust',
  swift: 'swift',
  c: 'c',
  'c++': 'c',
  cpp: 'c',
  dart: 'dart',
  ruby: 'ruby',
  bash: 'shell',
  sh: 'shell',
  zsh: 'shell',
  powershell: 'powershell',
  lua: 'lua',
  r: 'r',
};

/**
 * The lexer for code cells in `language`. Python cells may use IPython's syntax: shell commands
 * (`!pip install x`), line magics (`%env`) and cell magics (`%%bash`).
 */
export function cellLexer(language: Language): Lexer {
  return language === 'python' ? ipythonLexer : lexerFor(language);
}

/** The lexer language for a kernel's language name, such as `python`, `C#` or `C++17`. */
function kernelLanguage(name: string | null): Language {
  const key = (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[0-9.]+$/, '');
  return own(KERNEL_LANGUAGES, key) ?? 'python';
}

/** Decoded text, built from runs, with the file offset where each run starts. */
class Builder {
  private readonly parts: string[] = [];
  private length = 0;
  readonly at: number[] = [];
  readonly file: number[] = [];

  /** The next character appended comes from `offset` in the file. */
  mark(offset: number): void {
    const last = this.at.length - 1;
    if (last >= 0 && this.at[last] === this.length) this.file[last] = offset;
    else {
      this.at.push(this.length);
      this.file.push(offset);
    }
  }

  append(text: string): void {
    this.parts.push(text);
    this.length += text.length;
  }

  text(): string {
    return this.parts.join('');
  }
}

class NotNotebook extends Error {}

const QUOTE = 34;
const BACKSLASH = 92;

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/** A cursor over JSON text that reads the values it's asked for and skips the others. */
class JsonReader {
  private readonly text: string;
  private pos = 0;

  constructor(text: string) {
    this.text = text;
  }

  private fail(): never {
    throw new NotNotebook();
  }

  /** Skips whitespace; returns the next character's code, or NaN at the end. */
  peek(): number {
    let c = this.text.charCodeAt(this.pos);
    while (c === 32 || c === 10 || c === 13 || c === 9) c = this.text.charCodeAt(++this.pos);
    return c;
  }

  private expect(code: number): void {
    if (this.peek() !== code) this.fail();
    this.pos++;
  }

  /** After a member or an item: true at a comma, false at `close`. */
  private more(close: number): boolean {
    const c = this.peek();
    this.pos++;
    if (c === 44) return true;
    if (c !== close) this.fail();
    return false;
  }

  /** Reads an object, yielding each key; the caller reads or skips its value before the next. */
  *keys(): Generator<string, void, undefined> {
    this.expect(123); // {
    if (this.peek() === 125) {
      this.pos++;
      return;
    }
    do {
      if (this.peek() !== QUOTE) this.fail();
      const key = this.string();
      this.expect(58); // :
      yield key;
    } while (this.more(125));
  }

  /** Reads an array; `item` reads or skips each value. */
  array(item: () => void): void {
    this.expect(91); // [
    if (this.peek() === 93) {
      this.pos++;
      return;
    }
    do item();
    while (this.more(93));
  }

  /** Reads a string, or skips any other value and returns null. */
  optionalString(): string | null {
    if (this.peek() === QUOTE) return this.string();
    this.skip();
    return null;
  }

  private string(): string {
    const start = this.pos + 1;
    this.pos = this.skipString(this.pos);
    const raw = this.text.slice(start, this.pos - 1);
    if (!raw.includes('\\')) return raw;
    const out = new Builder();
    this.decode(start, out);
    return out.text();
  }

  /** Reads the string at the cursor into `out`. */
  stringInto(out: Builder): void {
    this.pos = this.decode(this.pos + 1, out);
  }

  /** Decodes string content from `start`; returns the offset after the closing quote. */
  private decode(start: number, out: Builder): number {
    const t = this.text;
    let run = start;
    out.mark(start);
    for (let i = start; ; ) {
      const c = t.charCodeAt(i);
      if (c === QUOTE) {
        out.append(t.slice(run, i));
        return i + 1;
      }
      if (c === BACKSLASH) {
        out.append(t.slice(run, i));
        const kind = t[i + 1] ?? '';
        if (kind === 'u') {
          const hex = t.slice(i + 2, i + 6);
          if (!/^[0-9A-Fa-f]{4}$/.test(hex)) this.fail();
          out.append(String.fromCharCode(Number.parseInt(hex, 16)));
          i += 6;
        } else {
          const decoded = own(ESCAPES, kind);
          if (decoded === undefined) this.fail();
          out.append(decoded);
          i += 2;
        }
        run = i;
        out.mark(i);
        continue;
      }
      // NaN: the text ended inside the string. JSON strings can't hold control characters.
      if (Number.isNaN(c) || c < 32) this.fail();
      i++;
    }
  }

  /** Skips the string whose opening quote is at `i`; returns the offset after its closing quote. */
  private skipString(i: number): number {
    const t = this.text;
    for (let from = i + 1; ; ) {
      const q = t.indexOf('"', from);
      if (q === -1) this.fail();
      let backslashes = 0;
      while (t.charCodeAt(q - 1 - backslashes) === BACKSLASH) backslashes++;
      if (backslashes % 2 === 0) return q + 1;
      from = q + 1;
    }
  }

  /** Skips one value. Objects and arrays are skipped by counting brackets, so depth is no limit. */
  skip(): void {
    const c = this.peek();
    const t = this.text;
    let i = this.pos;
    if (c === QUOTE) {
      this.pos = this.skipString(i);
      return;
    }
    if (c !== 123 && c !== 91) {
      // A number, true, false or null.
      while (i < t.length && !' \t\r\n,:]}'.includes(t[i] as string)) i++;
      if (i === this.pos) this.fail();
      this.pos = i;
      return;
    }
    let depth = 0;
    while (i < t.length) {
      const d = t.charCodeAt(i);
      if (d === QUOTE) {
        i = this.skipString(i);
        continue;
      }
      if (d === 123 || d === 91) depth++;
      else if ((d === 125 || d === 93) && --depth === 0) {
        this.pos = i + 1;
        return;
      }
      i++;
    }
    this.fail();
  }

  /** Fails unless only whitespace is left. */
  end(): void {
    if (!Number.isNaN(this.peek())) this.fail();
  }
}

/** A cell's source: a string, or a list of strings to join with nothing in between. */
function readSource(json: JsonReader): Builder {
  const out = new Builder();
  const c = json.peek();
  if (c === QUOTE) json.stringInto(out);
  else if (c === 91) {
    json.array(() => {
      if (json.peek() === QUOTE) json.stringInto(out);
      else json.skip();
    });
  } else json.skip();
  return out;
}

function readCell(json: JsonReader): Cell {
  let type: string | null = null;
  let source = new Builder();
  for (const key of json.keys()) {
    if (key === 'cell_type') type = json.optionalString();
    else if (key === 'source') source = readSource(json);
    else json.skip();
  }
  return { code: type === 'code', text: source.text(), at: source.at, file: source.file };
}

/** `metadata.kernelspec.language`, else `metadata.language_info.name`. */
function readLanguage(json: JsonReader): string | null {
  let kernel: string | null = null;
  let info: string | null = null;
  for (const key of objectKeys(json)) {
    if (key === 'kernelspec') kernel = stringField(json, 'language');
    else if (key === 'language_info') info = stringField(json, 'name');
    else json.skip();
  }
  return kernel ?? info;
}

/** The string `name` of the object at the cursor, if it has one. */
function stringField(json: JsonReader, name: string): string | null {
  let value: string | null = null;
  for (const key of objectKeys(json)) {
    if (key === name) value = json.optionalString();
    else json.skip();
  }
  return value;
}

/** The keys of the object at the cursor; any other value is skipped and has none. */
function objectKeys(json: JsonReader): Iterable<string> {
  if (json.peek() === 123) return json.keys();
  json.skip();
  return [];
}

/** Reads the cells of an nbformat 4 notebook, or returns null if `text` isn't one. */
export function readNotebook(text: string): Notebook | null {
  const json = new JsonReader(text);
  let cells: Cell[] | null = null;
  let language: string | null = null;
  try {
    for (const key of json.keys()) {
      if (key === 'cells') {
        const list: Cell[] = [];
        json.array(() => list.push(readCell(json)));
        cells = list;
      } else if (key === 'metadata') language = readLanguage(json);
      else json.skip();
    }
    json.end();
  } catch (error) {
    if (error instanceof NotNotebook) return null;
    throw error;
  }
  return cells === null ? null : { language: kernelLanguage(language), cells };
}

/** Between cells: a blank line, so that a directive on a cell's last line never reaches the next. */
const SEPARATOR = '\n\n';

/** Cells joined into one text. Offsets in the text map back to the notebook file. */
export class CellText {
  readonly text: string;
  /** The notebook file. */
  private readonly source: string;
  private readonly ranges: { start: number; end: number }[] = [];
  private readonly at: number[] = [];
  private readonly file: number[] = [];

  constructor(source: string, cells: readonly Cell[]) {
    this.source = source;
    let offset = 0;
    for (const cell of cells) {
      if (this.ranges.length > 0) offset += SEPARATOR.length;
      this.ranges.push({ start: offset, end: offset + cell.text.length });
      for (let k = 0; k < cell.at.length; k++) {
        this.at.push(offset + (cell.at[k] as number));
        this.file.push(cell.file[k] as number);
      }
      offset += cell.text.length;
    }
    this.text = cells.map((cell) => cell.text).join(SEPARATOR);
  }

  /** UTF-8 size of the cells' source, separators aside. */
  size(): number {
    const separators = Math.max(0, this.ranges.length - 1) * SEPARATOR.length;
    return new TextEncoder().encode(this.text).length - separators;
  }

  /** Lexes each cell on its own, so a string left open in one cell can't run into the next. */
  lex(lexer: Lexer): Span[] {
    return this.ranges.flatMap(({ start, end }) => lexPart(lexer, this.text, start, end));
  }

  /** Where `text[start, end)` is in the file. */
  toFile(start: number, end: number): { start: number; end: number } {
    const from = this.fileOffset(start);
    if (end <= start) return { start: from, end: from };
    // The last character may have been written as an escape, such as `\"` or `\u00e9`.
    const last = this.fileOffset(end - 1);
    const width =
      this.source.charCodeAt(last) !== BACKSLASH ? 1 : this.source[last + 1] === 'u' ? 6 : 2;
    return { start: from, end: last + width };
  }

  private fileOffset(offset: number): number {
    let lo = 0;
    let hi = this.at.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.at[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return (this.file[lo] ?? 0) + offset - (this.at[lo] ?? 0);
  }
}
