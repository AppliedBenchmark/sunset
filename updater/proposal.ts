// The text of the updater's PRs and issues. Pure: (ProviderRun, …) → string.
//
// Text from a provider's page (excerpts, IDs, the snapshot diff, parser messages that quote a row)
// is shown literally, in code spans and code blocks, so a page can't add links, images, mentions
// or issue references to a PR or issue.
import { createTwoFilesPatch } from 'diff';
import type { IsoDate, RegistryEntry } from '../src/core/types.ts';
import { code } from '../src/report/common.ts';
import type { Change } from './merge.ts';
import { applicable, type FailureKind, type ProviderRun, unreviewed } from './update.ts';

/** GitHub rejects PR and issue bodies over 65,536 characters. */
const MAX_BODY = 60_000;
const MAX_DIFF = 15_000;
const MAX_DETAILS = 50;

const FAILURE_TITLES: Record<FailureKind, string> = {
  fetch: 'fetch failed',
  'layout-changed': 'layout changed',
  parse: 'parse failure',
  grounding: 'grounding failure',
  missing: 'models missing from the page',
  invalid: 'entries that would not validate',
};
const BLOCKED_TITLE = "the updated registry doesn't validate";

/** A code span outside a table, where a backslash before a pipe would show. */
const inline = (text: string) => code(text, false);

/** A fenced code block the text can't close: its fence is longer than any backtick run in it. */
export function fenced(text: string, info = ''): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${text}\n${fence}`;
}

function capped(lines: readonly string[]): string {
  const more = lines.length - MAX_DETAILS;
  return [...lines.slice(0, MAX_DETAILS), ...(more > 0 ? [`… and ${more} more`] : [])].join('\n');
}

function describeValues(entry: RegistryEntry): string {
  const parts = [`status ${code(entry.status)}`];
  if (entry.deprecation_date) parts.push(`deprecated ${code(entry.deprecation_date)}`);
  if (entry.retirement_date) {
    parts.push(`retires ${code(entry.retirement_date)} (${entry.retirement_date_qualifier})`);
  }
  if (entry.recommended_replacements.length) {
    parts.push(
      `replacement ${entry.recommended_replacements.map((r) => code(r.model_id)).join(', ')}`,
    );
  }
  return parts.join(', ');
}

function fieldValue(entry: RegistryEntry | null, field: string): string {
  const value = entry?.[field as keyof RegistryEntry];
  if (field === 'recommended_replacements') {
    const list = (value as RegistryEntry['recommended_replacements'] | undefined) ?? [];
    return list.length ? list.map((r) => code(r.model_id)).join(', ') : 'none';
  }
  return value === null || value === undefined ? 'none' : code(String(value));
}

/** One table cell: field names and code spans only, so nothing in it needs escaping. */
function describeChange(change: Change): string {
  switch (change.kind) {
    case 'added':
      return describeValues(change.after);
    case 'updated': {
      const parts = change.fields.map(
        (f) => `${f}: ${fieldValue(change.before, f)} → ${fieldValue(change.after, f)}`,
      );
      if (change.before?.drop_in && !change.after.drop_in) parts.push('drop_in cleared');
      return parts.join('; ');
    }
    case 'excerpt':
      return 'excerpt refreshed; values unchanged';
    case 'reverified':
      return 'still on the page; values unchanged';
  }
}

/** The snapshot diff of one source, truncated. */
export function snapshotDiff(id: string, before: string, after: string): string {
  const patch = createTwoFilesPatch(`a/${id}.txt`, `b/${id}.txt`, before, after, '', '', {
    context: 2,
  });
  // Drops the `=====` line above the `---`/`+++` header.
  const body = patch.split('\n').slice(1).join('\n').trimEnd();
  if (body.length <= MAX_DIFF) return body;
  return `${body.slice(0, MAX_DIFF).replace(/\n[^\n]*$/, '')}\n… (truncated; see the snapshot file)`;
}

/** The rows each markup class gained and lost, one list item per class and direction. */
function rowClassChanges(
  before: Readonly<Record<string, string[]>>,
  after: Readonly<Record<string, string[]>>,
): string[] {
  const lines: string[] = [];
  for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const old = new Set(before[name] ?? []);
    const now = new Set(after[name] ?? []);
    const added = [...now].filter((id) => !old.has(id));
    const removed = [...old].filter((id) => !now.has(id));
    if (added.length) lines.push(`- ${inline(name)} added: ${added.map(inline).join(', ')}`);
    if (removed.length) lines.push(`- ${inline(name)} removed: ${removed.map(inline).join(', ')}`);
  }
  return lines;
}

/**
 * Joins the blocks with line breaks. Once the body would pass GitHub's limit, the remaining
 * blocks are left out whole, so no code block or <details> is cut open.
 */
function withinLimit(blocks: readonly string[], note: string): string {
  const out: string[] = [];
  let length = 0;
  for (const block of blocks) {
    length += block.length + 1;
    if (length > MAX_BODY) return `${out.join('\n')}\n\n${note}\n`;
    out.push(block);
  }
  return out.join('\n');
}

export function changesOf(run: ProviderRun): Change[] {
  return applicable(run).flatMap((s) => s.merge?.changes ?? []);
}

/** Also the commit message, so it follows the repository's Conventional Commits style. */
export function prTitle(run: ProviderRun): string {
  const all = changesOf(run);
  const changes = all.filter((c) => c.kind !== 'reverified');
  const added = changes.filter((c) => c.kind === 'added').length;
  const updated = changes.length - added;
  const parts = [added ? `${added} new` : '', updated ? `${updated} changed` : ''].filter(Boolean);
  const none = all.length ? ' (re-verified)' : ' (snapshots only)';
  return `chore(registry): update ${run.provider}${parts.length ? ` (${parts.join(', ')})` : none}`;
}

export function prBody(run: ProviderRun, today: IsoDate, runUrl: string | null): string {
  const changes = changesOf(run);
  const listed = changes.filter((c) => c.kind !== 'reverified');
  const reverified = changes.length - listed.length;
  const out: string[] = [
    `<!-- sunset-registry-update:${run.provider} -->`,
    `## Registry update: ${run.provider}`,
    '',
    `The registry updater checked ${run.provider}'s pages on ${today}${runUrl ? ` ([run](${runUrl}))` : ''}. ` +
      'Every value below is quoted from the page, and the `Validate registry` check re-checks each ' +
      'excerpt against the committed snapshot. Review the excerpts; the updater never sets `drop_in`.',
    '',
  ];
  if (listed.length) {
    out.push('| Change | Entry | What changed |', '|---|---|---|');
    for (const c of listed) out.push(`| ${c.kind} | ${code(c.after.id)} | ${describeChange(c)} |`);
    out.push('');
  }
  if (reverified) {
    out.push(
      `${reverified} ${reverified === 1 ? 'entry is' : 'entries are'} unchanged and still on the page; ` +
        `their \`verified_on\` moves to ${today}, so the registry shows they were checked recently.`,
      '',
    );
  }
  const failed = run.sources.filter((s) => s.failure);
  if (failed.length) {
    out.push(
      `Not included: ${failed.map((s) => inline(s.source.id)).join(', ')} failed; see the updater issue for ${run.provider}.`,
      '',
    );
  }
  if (listed.length) out.push('### Excerpts', '');
  for (const c of listed) {
    out.push(
      `**${inline(c.after.id)}** ([${c.after.source}](${c.after.source_url}))`,
      '',
      fenced(c.after.source_excerpt ?? '(none)', 'text'),
      '',
    );
  }
  for (const s of applicable(run)) {
    if (!s.changed) continue;
    const marks = rowClassChanges(s.previous?.page.row_classes ?? {}, s.changed.row_classes);
    if (marks.length) {
      // Not in the snapshot text, so the diff below can't show them.
      out.push(`Rows marked on the HTML page of ${inline(s.source.id)}:`, '', ...marks, '');
    }
    if (s.previous?.page.text === s.changed.text) continue;
    const diff = snapshotDiff(s.source.id, s.previous?.page.text ?? '', s.changed.text);
    out.push(
      [
        `<details><summary>Snapshot diff: ${s.source.id}</summary>`,
        '',
        fenced(diff, 'diff'),
        '',
        '</details>',
      ].join('\n'),
      '',
    );
  }
  return withinLimit(out, '… (truncated: the full changes are in the diff)');
}

/**
 * The provider's issue, or null when nothing needs a human. `blocked` holds the errors of the
 * updated registry as a whole, which keep the whole run from being written.
 */
export function issueBody(
  run: ProviderRun,
  today: IsoDate,
  runUrl: string | null,
  blocked: readonly string[] = [],
): { title: string; body: string } | null {
  const failed = run.sources.filter((s) => s.failure);
  const review = unreviewed(run);
  if (failed.length === 0 && review.length === 0 && blocked.length === 0) return null;
  const out: string[] = [`## Registry updater: ${run.provider}`, ''];
  if (blocked.length) {
    out.push(
      "### The updated registry doesn't validate",
      '',
      "With this run's changes the registry would fail `Validate registry`, so the updater wrote " +
        'nothing, not even the sources that succeeded. Each source passed its own checks, so the ' +
        'cause is something they share (such as a name two sources claim), a registry on `main` ' +
        'that already fails, or a bug in the updater:',
      '',
      fenced(capped(blocked), 'text'),
      '',
    );
  }
  if (failed.length) {
    out.push(
      'The registry updater could not process these sources. Their snapshots and registry entries were ' +
        'left unchanged; the updater retries every day and closes this issue once they succeed.',
      '',
    );
  } else if (review.length) {
    out.push('The registry updater needs a human to look at these pages.', '');
  }
  for (const s of failed) {
    const failure = s.failure as NonNullable<typeof s.failure>;
    out.push(`### ${inline(s.source.id)}: ${FAILURE_TITLES[failure.kind]}`, '');
    if (failure.kind === 'invalid') {
      out.push(
        'With the page as it is now, `Validate registry` would reject these entries. Fix them ' +
          'by hand, or the parser if it misread the page:',
        '',
      );
    }
    out.push(
      fenced(capped(failure.details), 'text'),
      '',
      `Page: ${s.source.url} · parser ${inline(s.source.parser)}`,
      '',
    );
  }
  for (const s of review) {
    out.push(
      `### ${inline(s.source.id)}: models to review by hand`,
      '',
      "This page is free text, so the updater doesn't propose entries from it. These IDs are on " +
        'the page but not in the registry:',
      '',
    );
    for (const row of s.merge?.unreviewed ?? []) {
      out.push(`- ${inline(row.model_id)}: ${inline(row.excerpt)}`);
    }
    out.push('');
  }
  out.push(`Last checked: ${today}${runUrl ? ` ([run](${runUrl}))` : ''}`);
  const kinds = [
    ...(blocked.length ? [BLOCKED_TITLE] : []),
    ...new Set(failed.map((s) => FAILURE_TITLES[(s.failure as { kind: FailureKind }).kind])),
  ];
  const title = kinds.length
    ? `Registry updater: ${run.provider} (${kinds.join(', ')})`
    : `Registry updater: ${run.provider} (models to review)`;
  return { title, body: withinLimit(out, '… (truncated)') };
}
