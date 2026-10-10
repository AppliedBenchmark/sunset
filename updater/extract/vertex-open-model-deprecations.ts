// Parser for Vertex AI's open model deprecations page (`parser: vertex-open-model-deprecations`):
// open models served as Model as a Service (MaaS). One table
// `Model ID | Deprecation date | Retirement date | Self-deploy alternative`:
// - every row is a deprecated model, retired once its retirement date passes
// - the self-deploy alternative is a Model Garden deployment, not a model ID, so there are no
//   replacements
// - the maker comes from the ID's first word (`llama-…` → meta); an unknown family is a problem
// - IDs are kept as the page writes them (`llama-3.3-70b-instruct-maas`). Code calls them with
//   their publisher (`meta/llama-3.3-70b-instruct-maas`), which the matcher finds all the same.
// Any other table with a `Model ID` or `Retirement date` column is a problem.

import type { Extractor } from '../../src/core/ports.ts';
import {
  type ExtractedRow,
  type Extraction,
  LayoutChangedError,
} from '../../src/core/registry/extract.ts';
import { dedupeRows, modelIdOf, partnerMaker, readDate } from './google.ts';
import { columns, tables, unreadTables } from './table.ts';

const HEADERS = {
  model: 'Model ID',
  deprecation: 'Deprecation date',
  retirement: 'Retirement date',
  alternative: 'Self-deploy alternative',
} as const;

export const extractor: Extractor = {
  id: 'vertex-open-model-deprecations',
  extract(page): Extraction {
    const rows: ExtractedRow[] = [];
    const problems: string[] = [];
    const all = tables(page.text);
    for (const table of all) {
      const cols = columns(table, HEADERS);
      if (!cols) continue;
      for (const row of table.rows) {
        const modelId = modelIdOf(row.cells[cols.model] ?? '');
        if (modelId === null) {
          problems.push(`no model ID in the row: ${row.line}`);
          continue;
        }
        const deprecation = readDate(row.cells[cols.deprecation] ?? '');
        const retirement = readDate(row.cells[cols.retirement] ?? '');
        const invalid = [deprecation, retirement].find((date) => date.kind === 'invalid');
        if (invalid) {
          problems.push(`\`${modelId}\`: unknown date format "${invalid.text}"`);
          continue;
        }
        if (deprecation.kind === 'none' && retirement.kind === 'none') {
          problems.push(`\`${modelId}\` is listed as deprecated but has no date`);
          continue;
        }
        const provider = partnerMaker(modelId);
        if (provider === null) {
          problems.push(`\`${modelId}\`: unknown model maker`);
          continue;
        }
        rows.push({
          platform: 'vertex',
          provider,
          model_id: modelId,
          version: null,
          regions: null,
          state: 'deprecated',
          deprecation: deprecation.kind === 'date' ? deprecation.date : null,
          retirement: retirement.kind === 'date' ? retirement.date : null,
          qualifier: retirement.kind === 'date' ? retirement.qualifier : 'exact',
          replacements: [],
          excerpt: row.line,
          notes: null,
        });
      }
    }
    if (rows.length === 0 && problems.length === 0) {
      throw new LayoutChangedError(
        `no table with the headers ${Object.values(HEADERS).join(', ')}, or no rows in one`,
      );
    }
    problems.push(
      ...unreadTables(all, (t) => columns(t, HEADERS) !== null, [
        HEADERS.model,
        HEADERS.retirement,
      ]),
    );
    return { rows: dedupeRows(rows, problems), problems, exhaustive: true };
  },
};
