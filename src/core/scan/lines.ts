// Maps UTF-16 offsets to 1-based lines and columns. `\r\n` and `\n` both end a line; a `\r`
// before `\n` belongs to the line it ends, so columns are the same as in an LF file.
import type { Location, Span, Spans } from '../types.ts';

export class LineIndex {
  readonly starts: number[] = [0];
  readonly text: string;

  constructor(text: string) {
    this.text = text;
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
      this.starts.push(i + 1);
    }
  }

  get lineCount(): number {
    const last = this.starts[this.starts.length - 1] as number;
    return last === this.text.length && this.starts.length > 1
      ? this.starts.length - 1
      : this.starts.length;
  }

  /** 0-based line index containing `offset`. */
  lineOf(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  location(path: string, start: number, end: number): Location {
    const line = this.lineOf(start);
    const endLine = this.lineOf(Math.max(start, end));
    return {
      path,
      line: line + 1,
      column: start - (this.starts[line] as number) + 1,
      endLine: endLine + 1,
      endColumn: end - (this.starts[endLine] as number) + 1,
    };
  }
}

/** Orders locations by path, then line, then column. */
export function compareLocations(a: Location, b: Location): number {
  return (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line || a.column - b.column;
}

/**
 * The span containing [start, end), or null. With `start === end`, a span that starts there also
 * counts. Spans must be sorted and non-overlapping.
 */
export function spanAt(spans: Spans, start: number, end = start): Span | null {
  let lo = 0;
  let hi = spans.length - 1;
  let found: Span | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid] as Span;
    if (span.start <= start) {
      found = span;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found && end <= found.end && (start < found.end || found.start === start)) return found;
  return null;
}
