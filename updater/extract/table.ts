// Reads the `| a | b |` tables of a normalized snapshot (Markdown pages, and HTML pages after
// htmlToText). Parsers key on the header cells, so the helpers here keep the raw row line for
// excerpts and give clean cell text for values.

export interface TableRow {
  /** Raw cells, trimmed, with `\|` unescaped. */
  cells: string[];
  /** The row's line as it is in the snapshot: an excerpt that carries every cell. */
  line: string;
  /** 0-based line number in the snapshot. */
  index: number;
}

export interface Table {
  /** Header cells, cleaned with `cellText`. */
  headers: string[];
  rows: TableRow[];
  /** The nearest Markdown heading above the table (`## …` text), or null. */
  heading: string | null;
  /** Every heading above the table, outermost first. */
  headings: string[];
  /** 0-based line number of the header row. */
  index: number;
}

const SEPARATOR = /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?$/;
const HEADING = /^(#{1,6})\s+(.*)$/;

/** Splits a `| a | b |` line into cells, honouring `\|` escapes. */
export function splitRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && body[i + 1] === '|') {
      current += '|';
      i++;
    } else if (ch === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** A cell's plain text: Markdown emphasis and code marks removed, whitespace collapsed. */
export function cellText(cell: string): string {
  return cell
    .replace(/\*\*|__/g, '')
    .replace(/`/g, '')
    .replace(/\\([\\`*_{}[\]()#+.!-])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the cell starts with a code span, bold or not (`**\`id\`**`). */
export function startsWithCode(cell: string): boolean {
  return /^(?:\*\*|__)?`/.test(cell);
}

/**
 * True when a cell's plain text is one token shaped like a model ID (`gpt-4o`, `o3`): a parser
 * that reads IDs only from code spans reports such a cell rather than dropping it.
 */
export function looksLikeId(text: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(text) && /[\d-]/.test(text);
}

/** Every backtick-quoted span in a cell, in order (`a` or `b` → [a, b]). */
export function codeSpans(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => (m[1] as string).trim());
}

/**
 * Every table in the text. A table starts at a `|` line followed by a separator line; when a page
 * has no separator (htmlToText output), the first `|` line of a block is the header.
 */
export function tables(text: string): Table[] {
  const lines = text.split('\n');
  const out: Table[] = [];
  const headings: { level: number; text: string }[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const heading = HEADING.exec(line);
    if (heading) {
      const level = (heading[1] as string).length;
      while (headings.length && (headings.at(-1) as { level: number }).level >= level) {
        headings.pop();
      }
      headings.push({ level, text: (heading[2] as string).trim() });
      i++;
      continue;
    }
    if (!line.startsWith('|')) {
      i++;
      continue;
    }
    const start = i;
    const next = lines[i + 1] ?? '';
    const headers = splitRow(line).map(cellText);
    i += SEPARATOR.test(next) ? 2 : 1;
    const rows: TableRow[] = [];
    while (i < lines.length && (lines[i] as string).startsWith('|')) {
      const row = lines[i] as string;
      if (!SEPARATOR.test(row)) rows.push({ cells: splitRow(row), line: row, index: i });
      i++;
    }
    out.push({
      headers,
      rows,
      heading: headings.at(-1)?.text ?? null,
      headings: headings.map((h) => h.text),
      index: start,
    });
  }
  return out;
}

/**
 * The column index of each wanted header (compared after `cellText`, case-insensitively), or
 * null when the table lacks one of them.
 */
export function columns<K extends string>(
  table: Table,
  wanted: Record<K, string>,
): Record<K, number> | null {
  const lower = table.headers.map((h) => h.toLowerCase());
  const out = {} as Record<K, number>;
  for (const [key, header] of Object.entries(wanted) as [K, string][]) {
    const index = lower.indexOf(header.toLowerCase());
    if (index < 0) return null;
    out[key] = index;
  }
  return out;
}

/**
 * A problem for every table that has one of the `anchors` columns but isn't read: otherwise a
 * renamed column would drop the table's models without a word. `skip` names columns of tables
 * known not to list models.
 */
export function unreadTables(
  all: readonly Table[],
  read: (table: Table) => boolean,
  anchors: readonly string[],
  skip: readonly string[] = [],
): string[] {
  const has = (table: Table, names: readonly string[]) =>
    table.headers.some((h) => names.some((name) => h.toLowerCase() === name.toLowerCase()));
  return all
    .filter((table) => has(table, anchors) && !has(table, skip) && !read(table))
    .map(
      (table) =>
        `a table${table.heading ? ` under "${table.heading}"` : ''} has columns the parser doesn't know: ${table.headers.join(' | ')}`,
    );
}
