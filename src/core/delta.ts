// The PR delta: the findings a pull request introduces. Each finding is fingerprinted by
// rule, entry, path and the text of its line with whitespace collapsed, and a head finding is new
// when its fingerprint isn't left in the base multiset. Moving a line, or editing other lines of
// the file, therefore doesn't make a finding "new"; editing the line itself does.
import type { ChangedFile } from './ports.ts';
import type { Finding, Location, ScanResult, UnresolvedReference } from './types.ts';

/** Findings and unresolved references the pull request added. */
export interface PrDelta {
  findings: readonly Finding[];
  unresolved: readonly UnresolvedReference[];
}

/** The text of a 1-based line of a file, on one side of the comparison. */
export type LineText = (path: string, line: number) => string;

export interface DeltaInput {
  /** The scan of the head revision (paths at head). */
  head: ScanResult;
  /** The scan of the base revision's copies of the changed files (paths at base). */
  base: ScanResult;
  changed: readonly ChangedFile[];
  headLine: LineText;
  baseLine: LineText;
}

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

type Item = Finding | UnresolvedReference;

const subject = (item: Item): string =>
  'entry' in item ? (item.entry?.id ?? item.modelId) : item.expression;

function fingerprint(item: Item, path: string, line: LineText, location: Location): string {
  return [item.rule, subject(item), path, normalize(line(location.path, location.line))].join(
    '\u0000',
  );
}

export function computeDelta(input: DeltaInput): PrDelta {
  const changed = new Map(input.changed.map((c) => [c.path, c]));
  // Base findings are compared under their head path, so a renamed file is the same file.
  const headPathOf = new Map<string, string>();
  for (const c of input.changed) {
    if (c.status !== 'added') headPathOf.set(c.previousPath ?? c.path, c.path);
  }

  const remaining = new Map<string, number>();
  const baseItems: Item[] = [...input.base.findings, ...input.base.unresolved];
  for (const item of baseItems) {
    const path = headPathOf.get(item.location.path);
    if (path === undefined) continue;
    const key = fingerprint(item, path, input.baseLine, item.location);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }

  const isNew = (item: Item): boolean => {
    // Files the pull request doesn't touch can't introduce anything.
    if (!changed.has(item.location.path)) return false;
    const key = fingerprint(item, item.location.path, input.headLine, item.location);
    const left = remaining.get(key) ?? 0;
    if (left === 0) return true;
    remaining.set(key, left - 1);
    return false;
  };

  return {
    findings: input.head.findings.filter(isNew),
    unresolved: input.head.unresolved.filter(isNew),
  };
}
