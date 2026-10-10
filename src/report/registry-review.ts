// The review table for registry PRs: every added or changed entry with its dates, its excerpt and
// a link, so reviewers can check each value against the quote. A changed value shows as
// `old → new`. Excerpts are shown literally, in code spans: they are text from provider pages.
import type { Registry, RegistryEntry } from '../core/types.ts';
import { code } from './common.ts';

export interface RegistryChanges {
  added: RegistryEntry[];
  changed: { before: RegistryEntry; after: RegistryEntry }[];
  removed: RegistryEntry[];
}

/** Compares entries by id; with no base, every entry counts as added. */
export function diffRegistries(base: Registry | null, head: Registry): RegistryChanges {
  const before = new Map(base?.models.map((e) => [e.id, e]));
  const after = new Map(head.models.map((e) => [e.id, e]));
  const added: RegistryEntry[] = [];
  const changed: RegistryChanges['changed'] = [];
  for (const entry of head.models) {
    const old = before.get(entry.id);
    if (!old) added.push(entry);
    else if (JSON.stringify(old) !== JSON.stringify(entry)) {
      changed.push({ before: old, after: entry });
    }
  }
  const removed = (base?.models ?? []).filter((e) => !after.has(e.id));
  return { added, changed, removed };
}

function date(entry: RegistryEntry, field: 'deprecation_date' | 'retirement_date'): string {
  const value = entry[field];
  if (value === null) return '';
  return field === 'retirement_date' && entry.retirement_date_qualifier !== 'exact'
    ? `${value} (${entry.retirement_date_qualifier.replace(/_/g, ' ')})`
    : value;
}

function replacements(entry: RegistryEntry): string {
  const list = entry.recommended_replacements
    .map((r) =>
      r.platform === entry.platform ? code(r.model_id) : `${code(r.model_id)} (${r.platform})`,
    )
    .join(', ');
  return entry.drop_in ? `${list} (drop-in)` : list;
}

/** The value columns of an entry, as table cells. */
function values(entry: RegistryEntry): string[] {
  return [
    entry.status,
    date(entry, 'deprecation_date'),
    date(entry, 'retirement_date'),
    replacements(entry),
  ];
}

function row(change: string, entry: RegistryEntry, cells: string[]): string {
  const excerpt = entry.source_excerpt === null ? '_none_' : code(entry.source_excerpt);
  return `| ${change} | ${code(entry.id)} | ${cells.join(' | ')} | ${excerpt} | [${entry.source}](${entry.source_url}) |`;
}

/** A changed entry's values, `old → new` where they differ. */
function changedValues(before: RegistryEntry, after: RegistryEntry): string[] {
  const old = values(before);
  return values(after).map((value, i) => {
    const was = old[i] ?? '';
    if (was === value) return value;
    return `${was || '_none_'} → ${value || '_none_'}`;
  });
}

export function registryReviewMarkdown(changes: RegistryChanges): string {
  const lines = [
    '## Registry review',
    '',
    `${changes.added.length} added, ${changes.changed.length} changed, ${changes.removed.length} removed. Check every value against its excerpt.`,
  ];
  const rows = [
    ...changes.added.map((e) => row('added', e, values(e))),
    ...changes.changed.map(({ before, after }) =>
      row('changed', after, changedValues(before, after)),
    ),
  ];
  if (rows.length) {
    lines.push(
      '',
      '| Change | Entry | Status | Deprecation | Retirement | Replacements | Excerpt | Source |',
      '|---|---|---|---|---|---|---|---|',
      ...rows,
    );
  }
  if (changes.removed.length) {
    lines.push('', '### Removed', '', ...changes.removed.map((e) => `- ${code(e.id, false)}`));
  }
  return `${lines.join('\n')}\n`;
}
