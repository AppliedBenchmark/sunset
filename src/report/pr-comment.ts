// The sticky PR comment: what the pull request introduced, and why the check fails when it fails
// because of findings that were already in the code. src/app/pr-delta.ts computes the delta, and
// the Action upserts the comment found by its hidden marker. GitHub rejects bodies over 65,536 characters,
// so rows are dropped past that and the comment points to the job summary.
import type { PrDelta } from '../core/delta.ts';
import { compareLocations } from '../core/scan/lines.ts';
import { compareSeverity } from '../core/severity.ts';
import type { Finding, ScanResult } from '../core/types.ts';
import { cell, locationLink, plural, type ReportContext, registryLine } from './common.ts';
import { RULE_PREFIX } from './rules.ts';

export type { PrDelta };

export const PR_COMMENT_MARKER = `<!-- ${RULE_PREFIX}:pr-comment -->`;
/** GitHub's limit for an issue or PR comment body, in characters. */
export const PR_COMMENT_LIMIT = 65_536;
/** Existing findings listed before "and N more". */
export const EXISTING_ROWS = 20;

/** Findings at or above fail-on that were in the code before the pull request. */
export interface ExistingFindings {
  findings: readonly Finding[];
  /** The fail-on level, for the text. */
  failOn: 'error' | 'warning';
  /** True when they fail the check (`fail-scope: all`); false with `fail-scope: new`. */
  blocking: boolean;
}

export interface PrCommentOptions {
  /** A link to the run's job summary, which has every finding. */
  summaryUrl?: string;
  existing?: ExistingFindings;
  maxChars?: number;
}

const ICON: Record<Finding['severity'], string> = {
  error: '**error**',
  warning: 'warning',
  notice: 'notice',
};

// The message already names the model, its platform, the date and the replacement.
const findingRow = (f: Finding, ctx: ReportContext): string =>
  `| ${ICON[f.severity]} | ${locationLink(f.location, ctx)} | ${cell(f.message)} |`;

const bySeverityThenLocation = (a: Finding, b: Finding): number =>
  compareSeverity(a.severity, b.severity) || compareLocations(a.location, b.location);

export function prCommentBody(
  delta: PrDelta,
  result: ScanResult,
  ctx: ReportContext,
  opts: PrCommentOptions = {},
): string {
  const max = opts.maxChars ?? PR_COMMENT_LIMIT;
  const findings = [...delta.findings].sort(bySeverityThenLocation);
  const unresolved = [...delta.unresolved].sort((a, b) => compareLocations(a.location, b.location));
  const existing = opts.existing && opts.existing.findings.length > 0 ? opts.existing : null;
  const existingAll = existing ? [...existing.findings].sort(bySeverityThenLocation) : [];
  const summaryLink = opts.summaryUrl ? ` See the [job summary](${opts.summaryUrl}).` : '';
  const anyNew = findings.length > 0 || unresolved.length > 0;

  const head = [PR_COMMENT_MARKER, `### Sunset: ${headline(delta, existing)}`];
  const scope = existing
    ? '"New" means this pull request adds it; existing findings were in the code before.'
    : 'Only references this pull request adds are listed.';
  const footer = [
    '',
    `<sub>${scope} sunset ${ctx.version} · ${registryLine(result, ctx)} · dates as of ${result.today}</sub>`,
  ];

  const findingRows = findings.map((f) => findingRow(f, ctx));
  const unresolvedRows = unresolved.map(
    (u) => `| ${locationLink(u.location, ctx)} | ${cell(u.message)} |`,
  );
  const existingRows = existingAll.slice(0, EXISTING_ROWS).map((f) => findingRow(f, ctx));

  const render = (fRows: string[], uRows: string[], eRows: string[], omitted: number): string => {
    const lines = [...head];
    if (!anyNew) {
      lines.push('', 'This pull request adds no deprecated, retiring or retired models.');
    }
    if (fRows.length > 0) {
      lines.push('', '| Level | Where | Details |', '|---|---|---|', ...fRows);
    }
    if (uRows.length > 0) {
      lines.push(
        '',
        '<details>',
        `<summary>${plural(unresolved.length, 'new unresolved reference')}</summary>`,
        '',
        "The model here is chosen at run time, so Sunset can't check it.",
        '',
        '| Where | Details |',
        '|---|---|',
        ...uRows,
        '',
        '</details>',
      );
    }
    if (existing) lines.push(...existingSection(existing, existingAll.length, eRows, summaryLink));
    if (omitted > 0) {
      lines.push('', `${plural(omitted, 'more item')} didn't fit in this comment.${summaryLink}`);
    } else if (summaryLink && (anyNew || existing)) {
      lines.push('', summaryLink.trim());
    }
    lines.push(...footer);
    return `${lines.join('\n')}\n`;
  };

  let body = render(findingRows, unresolvedRows, existingRows, 0);
  if (body.length <= max) return body;

  // Drop existing rows first, then unresolved rows, then findings from the least severe.
  const fRows = [...findingRows];
  const uRows = [...unresolvedRows];
  const eRows = [...existingRows];
  /** Drops a row and returns its length, or returns -1 when none is left. */
  const drop = (): number => (eRows.pop() ?? uRows.pop() ?? fRows.pop())?.length ?? -1;
  // Dropped existing rows are already counted by the existing section's "…and N more".
  const truncated = () =>
    render(
      fRows,
      uRows,
      eRows,
      findingRows.length - fRows.length + unresolvedRows.length - uRows.length,
    );
  // A first cut by the rows' lengths, keeping room for the note. Then the body is rendered and cut
  // until it fits, because the notes that dropped rows bring in take room too.
  let length = render(fRows, uRows, eRows, 1).length + 64;
  while (length > max) {
    const row = drop();
    if (row < 0) break;
    length -= row + 1;
  }
  body = truncated();
  while (body.length > max && drop() >= 0) body = truncated();
  return body;
}

function existingSection(
  existing: ExistingFindings,
  total: number,
  rows: string[],
  summaryLink: string,
): string[] {
  const what = `${plural(total, 'existing finding')} at or above \`fail-on: ${existing.failOn}\``;
  const more =
    total > rows.length
      ? [
          '',
          `…and ${(total - rows.length).toLocaleString('en-US')} more in the job summary.${summaryLink}`,
        ]
      : [];
  const table =
    rows.length > 0 ? ['', '| Level | Where | Details |', '|---|---|---|', ...rows] : [];
  if (existing.blocking) {
    return [
      '',
      `#### Why this check fails: ${what}`,
      '',
      'These were in the code before this pull request. Fix or suppress them, or set `fail-scope: new` in .sunset.yml to fail only on findings a pull request adds.',
      ...table,
      ...more,
    ];
  }
  return [
    '',
    '<details>',
    `<summary>${what}, which don't fail this check (fail-scope: new)</summary>`,
    ...table,
    ...more,
    '',
    '</details>',
  ];
}

function headline(delta: PrDelta, existing: ExistingFindings | null): string {
  const n = delta.findings.length;
  const blocking = existing?.blocking ? existing.findings.length : 0;
  const because =
    blocking > 0
      ? `, but ${plural(blocking, 'existing finding')} ${blocking === 1 ? 'fails' : 'fail'} this check`
      : '';
  if (n === 0 && delta.unresolved.length === 0) return `no new findings${because}`;
  if (n === 0) return `${plural(delta.unresolved.length, 'new unresolved reference')}${because}`;
  const errors = delta.findings.filter((f) => f.severity === 'error').length;
  const what = plural(n, 'new finding');
  return `${errors > 0 ? `${what} (${plural(errors, 'error')})` : what}${because}`;
}
