// Parser for the Gemini API deprecations page (`parser: gemini-api-deprecations`).
//
// Tables `Model | Release date | Shutdown date | Recommended replacement`, one per model family;
// rows such as `Preview models ||||` are sub-headings. Only the HTML page says which rows are shut
// down (`row-gray`, recorded in the snapshot's meta):
// - a gray row is `retired`, with its shutdown date as an exact date
// - any other row is `available`. The page says its dates are the earliest possible ones (the
//   source's `page_qualifier`) and that deprecations are announced in the release notes, so a
//   date alone doesn't make a model deprecated: the stable gemini-3.1-flash-lite is listed with
//   one a year after its release.
// Tables keyed `Agent` (managed agents) aren't models and are skipped; any other table with a
// `Model` or `Shutdown date` column but not the other headers is a problem.

import type { Extractor } from '../../src/core/ports.ts';
import {
  type ExtractedRow,
  type Extraction,
  LayoutChangedError,
} from '../../src/core/registry/extract.ts';
import { dedupeRows, modelIdOf, readDate, replacementIds } from './google.ts';
import { columns, tables, unreadTables } from './table.ts';

const SHUT_DOWN_CLASS = 'row-gray';
const HEADERS = {
  model: 'Model',
  shutdown: 'Shutdown date',
  replacement: 'Recommended replacement',
} as const;
const EARLIEST_NOTE = 'The page says its shutdown dates are the earliest possible dates.';

export const extractor: Extractor = {
  id: 'gemini-api-deprecations',
  extract(page, { source }): Extraction {
    const shutDown = new Set(page.row_classes[SHUT_DOWN_CLASS] ?? []);
    // The page always has shut-down rows. With none marked, the markup changed, and reading every
    // row as not shut down would bring all of them back.
    if (shutDown.size === 0) {
      throw new LayoutChangedError(`the HTML page marks no row \`${SHUT_DOWN_CLASS}\``);
    }
    const pageQualifier = source.page_qualifier?.qualifier ?? 'exact';
    const rows: ExtractedRow[] = [];
    const problems: string[] = [];
    const all = tables(page.text);
    for (const table of all) {
      const cols = columns(table, HEADERS);
      if (!cols) continue;
      for (const row of table.rows) {
        const modelCell = row.cells[cols.model] ?? '';
        const modelId = modelIdOf(modelCell);
        if (modelId === null) {
          // A sub-heading row: one label, the other cells empty.
          if (row.cells.slice(1).every((cell) => cell === '')) continue;
          problems.push(`no model ID in the row: ${row.line}`);
          continue;
        }
        const date = readDate(row.cells[cols.shutdown] ?? '');
        if (date.kind === 'invalid') {
          problems.push(`\`${modelId}\`: unknown date format "${date.text}"`);
          continue;
        }
        const gray = shutDown.has(modelId);
        if (gray && date.kind === 'none') {
          problems.push(`\`${modelId}\` is marked as shut down but has no shutdown date`);
          continue;
        }
        const dated = date.kind === 'date';
        const qualifier = !dated
          ? 'exact'
          : gray
            ? 'exact'
            : date.qualifier === 'exact'
              ? pageQualifier
              : date.qualifier;
        rows.push({
          platform: 'gemini-api',
          provider: 'google',
          model_id: modelId,
          version: null,
          regions: null,
          state: gray ? 'retired' : 'available',
          deprecation: null,
          retirement: dated ? date.date : null,
          qualifier,
          replacements: replacementIds(row.cells[cols.replacement] ?? ''),
          excerpt: row.line,
          notes: dated && !gray && qualifier === 'no_earlier_than' ? EARLIEST_NOTE : null,
        });
      }
    }
    if (rows.length === 0) {
      throw new LayoutChangedError(
        `no table with the headers ${Object.values(HEADERS).join(', ')}, or no rows in one`,
      );
    }
    problems.push(
      ...unreadTables(
        all,
        (t) => columns(t, HEADERS) !== null,
        [HEADERS.model, HEADERS.shutdown],
        ['Agent'],
      ),
    );
    // A gray row in a skipped table (a managed agent) is fine; a gray ID in no table at all means
    // the two pages disagree.
    const listed = new Set(all.flatMap((t) => t.rows.map((row) => modelIdOf(row.cells[0] ?? ''))));
    for (const id of shutDown) {
      if (!listed.has(id)) problems.push(`\`${id}\` is marked as shut down but not in a table`);
    }
    return { rows: dedupeRows(rows, problems), problems, exhaustive: true };
  },
};
