// Parser for Vertex AI's Google model versions page (`parser: vertex-model-versions`). Tables
// `Model ID | Release date | Retirement date | Replacement model ID` (the retired table says
// `Recommended upgrade`); any other table with a `Model ID` or `Retirement date` column is a
// problem.
// - rows under a "Retired models" heading are `retired`
// - every other row is `available`; a passed exact date still makes it retired (statusFor)
// - `<date> or later` and `No sooner than <date>` are no-earlier-than dates

import type { Extractor } from '../../src/core/ports.ts';
import {
  type ExtractedRow,
  type Extraction,
  LayoutChangedError,
} from '../../src/core/registry/extract.ts';
import { dedupeRows, modelIdOf, readDate, replacementIds } from './google.ts';
import { columns, type Table, tables, unreadTables } from './table.ts';

const BASE = { model: 'Model ID', retirement: 'Retirement date' } as const;
const REPLACEMENT_HEADERS = ['Replacement model ID', 'Recommended upgrade'];

function replacementColumn(table: Table): number | null {
  for (const header of REPLACEMENT_HEADERS) {
    const cols = columns(table, { replacement: header });
    if (cols) return cols.replacement;
  }
  return null;
}

export const extractor: Extractor = {
  id: 'vertex-model-versions',
  extract(page): Extraction {
    const rows: ExtractedRow[] = [];
    const problems: string[] = [];
    const all = tables(page.text);
    const read = (table: Table) =>
      columns(table, BASE) !== null && replacementColumn(table) !== null;
    for (const table of all) {
      const cols = columns(table, BASE);
      const replacementCol = replacementColumn(table);
      if (!cols || replacementCol === null) continue;
      const retiredTable = table.headings.some((heading) => /^retired models$/i.test(heading));
      for (const row of table.rows) {
        const modelId = modelIdOf(row.cells[cols.model] ?? '');
        if (modelId === null) {
          problems.push(`no model ID in the row: ${row.line}`);
          continue;
        }
        const date = readDate(row.cells[cols.retirement] ?? '');
        if (date.kind === 'invalid') {
          problems.push(`\`${modelId}\`: unknown date format "${date.text}"`);
          continue;
        }
        if (retiredTable && date.kind === 'none') {
          problems.push(`\`${modelId}\` is listed as retired but has no retirement date`);
          continue;
        }
        rows.push({
          platform: 'vertex',
          provider: 'google',
          model_id: modelId,
          version: null,
          regions: null,
          state: retiredTable ? 'retired' : 'available',
          deprecation: null,
          retirement: date.kind === 'date' ? date.date : null,
          qualifier: date.kind === 'date' ? date.qualifier : 'exact',
          replacements: replacementIds(row.cells[replacementCol] ?? ''),
          excerpt: row.line,
          notes: null,
        });
      }
    }
    if (rows.length === 0) {
      throw new LayoutChangedError(
        `no table with the headers ${[...Object.values(BASE), REPLACEMENT_HEADERS.join(' or ')].join(', ')}, or no rows in one`,
      );
    }
    problems.push(...unreadTables(all, read, Object.values(BASE)));
    return { rows: dedupeRows(rows, problems), problems, exhaustive: true };
  },
};
