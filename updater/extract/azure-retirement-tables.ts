// Parser for the Azure / Foundry model retirement schedule (`parser: azure-retirement-tables`).
// Each model maker has a `### <maker>` section with a table
// `Model | Version | Lifecycle | Retirement date | Replacement`.
//
// - Entries are keyed by (model, version). Rows without a version are left out: Azure deployments
//   are matched on both. The fine-tuned models' table (`Deployment retirement date`) is skipped;
//   any other table with one of these columns but not all of them is a problem.
// - Lifecycle `GA` and `Preview` mean available; `Deprecated`, `Legacy` and `Retired` say so.
// - Replacements are the comma-separated IDs of the Replacement cell; footnote marks are dropped,
//   and anything that isn't a single model ID (`sora-2 (2025-12-08)`, `@someone`) is left out.
// - A (model, version) listed more than once with different values can't be tied to one quote,
//   so it becomes `unverified` with the first row as its excerpt.

import type { Extractor } from '../../src/core/ports.ts';
import { parseDateString } from '../../src/core/registry/date-strings.ts';
import {
  type ExtractedRow,
  LayoutChangedError,
  type PageState,
} from '../../src/core/registry/extract.ts';
import { cellText, columns, tables, unreadTables } from './table.ts';

const HEADERS = {
  model: 'Model',
  version: 'Version',
  lifecycle: 'Lifecycle',
  retirement: 'Retirement date',
  replacement: 'Replacement',
} as const;

// A model ID as the other parsers read one.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const STATES: Record<string, PageState> = {
  ga: 'available',
  preview: 'available',
  deprecated: 'deprecated',
  legacy: 'legacy',
  retired: 'retired',
};

// Section names whose slug isn't the maker's registry `provider`.
const MAKERS: Record<string, string> = {
  'azure openai': 'openai',
  'openai-oss': 'openai',
  'mistral ai': 'mistral',
  stabilityai: 'stability',
};

/** The registry `provider` for a maker's section heading (`Azure OpenAI` → openai). */
export function maker(section: string | null): string {
  const name = (section ?? '').trim().toLowerCase();
  return MAKERS[name] ?? name.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const stripFootnotes = (text: string) => text.replace(/<sup>[^<]*<\/sup>/g, '');

export const extractor: Extractor = {
  id: 'azure-retirement-tables',
  extract(page) {
    const problems: string[] = [];
    const all = tables(page.text);
    const schedule = all.filter((t) => columns(t, HEADERS) !== null);
    problems.push(
      ...unreadTables(all, (t) => columns(t, HEADERS) !== null, Object.values(HEADERS), [
        'Deployment retirement date',
      ]),
    );
    if (schedule.length === 0) {
      throw new LayoutChangedError(
        `no table with the columns ${Object.values(HEADERS).join(', ')}`,
      );
    }
    const byKey = new Map<string, { row: ExtractedRow; values: string }[]>();
    for (const table of schedule) {
      const col = columns(table, HEADERS) as Record<keyof typeof HEADERS, number>;
      const provider = maker(table.heading);
      for (const line of table.rows) {
        const cell = (key: keyof typeof HEADERS) =>
          cellText(stripFootnotes(line.cells[col[key]] ?? ''));
        const model = cell('model');
        const version = cell('version');
        const retirementText = cell('retirement');
        const parsedVersion = parseDateString(version);
        if (parsedVersion.kind === 'none') continue;
        if (!/^\S+$/.test(model) || !/^\S+$/.test(version)) {
          problems.push(`unrecognized model or version in: ${line.line}`);
          continue;
        }
        const state = STATES[cell('lifecycle').toLowerCase()];
        if (!state) {
          problems.push(`unrecognized lifecycle "${cell('lifecycle')}" in: ${line.line}`);
          continue;
        }
        const date = parseDateString(retirementText);
        if (date.kind === 'invalid') {
          problems.push(`unrecognized retirement date "${retirementText}" in: ${line.line}`);
          continue;
        }
        const replacements = cell('replacement')
          .split(',')
          .map((r) => r.trim())
          .filter((r) => MODEL_ID.test(r) && r !== model);
        const row: ExtractedRow = {
          platform: 'azure-openai',
          provider,
          model_id: model,
          version,
          regions: null,
          state,
          deprecation: null,
          retirement: date.kind === 'date' ? { text: retirementText, iso: date.iso } : null,
          qualifier: date.kind === 'date' ? date.qualifier : 'exact',
          replacements,
          excerpt: line.line,
          notes: null,
        };
        const key = `${model}@${version}`;
        const values = JSON.stringify([state, row.retirement?.iso, row.qualifier, replacements]);
        const list = byKey.get(key) ?? [];
        list.push({ row, values });
        byKey.set(key, list);
      }
    }
    if (byKey.size === 0 && problems.length === 0) {
      throw new LayoutChangedError('the retirement tables have no rows');
    }
    const rows: ExtractedRow[] = [];
    for (const list of byKey.values()) {
      const first = list[0] as { row: ExtractedRow; values: string };
      if (list.every((item) => item.values === first.values)) {
        rows.push(first.row);
      } else {
        rows.push({
          ...first.row,
          state: 'unverified',
          retirement: null,
          qualifier: 'exact',
          replacements: [],
          notes: 'The page lists this model and version more than once with different values.',
        });
      }
    }
    return { rows, problems, exhaustive: true };
  },
};
