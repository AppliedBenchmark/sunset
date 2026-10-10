// Parser for Vertex AI model pages whose model tables have a Versions row (`parser:
// vertex-model-page-versions`), such as the Imagen pages of the Vertex AI documentation. Read from
// the HTML page, one row per model section:
//
//   | Versions | imagen-4.0-generate-001 Launch stage: GA Release date: August 14, 2025
//     Discontinuation date: June 30, 2026 | … |
//
// - Each version in the cell is a model: its ID, then `Launch stage:`, `Release date:` and, once
//   one is set, `Discontinuation date:`. The row is the excerpt.
// - A model is available, so a passed discontinuation date makes it retired; one whose launch
//   stage is Deprecated is deprecated.
// - Every model must be one of the source's `models`, so a page that starts listing another
//   model is reported rather than read.

import type { Extractor } from '../../src/core/ports.ts';
import {
  type ExtractedRow,
  type Extraction,
  LayoutChangedError,
} from '../../src/core/registry/extract.ts';
import { dedupeRows, readDate } from './google.ts';
import { cellText, splitRow } from './table.ts';

const VERSIONS_ROW = /^\| Versions \|.*$/gm;
// Where each version of a cell starts: its ID, followed by its launch stage.
const VERSION_START = /(?:^| )(?=\S+ Launch stage:)/;
const MODEL_ID = /^[a-z0-9][a-z0-9._@-]*$/;
const STAGE = /Launch stage: (.+?)(?= Release date:| Discontinuation date:|$)/;
const DISCONTINUED = /Discontinuation date: (.+?)(?= [A-Z][a-z]+ date:|$)/;

export const extractor: Extractor = {
  id: 'vertex-model-page-versions',
  extract(page, { source }): Extraction {
    const rows: ExtractedRow[] = [];
    const problems: string[] = [];
    const lines = [...page.text.matchAll(VERSIONS_ROW)].map((m) => m[0]);
    if (lines.length === 0) throw new LayoutChangedError('the page has no `| Versions |` row');
    for (const line of lines) {
      const versions = cellText(splitRow(line)[1] ?? '')
        .split(VERSION_START)
        .filter(Boolean);
      if (versions.length === 0) problems.push(`no version in the row: ${line}`);
      for (const version of versions) {
        const id = version.split(' ')[0] as string;
        const stage = STAGE.exec(version)?.[1];
        const discontinued = DISCONTINUED.exec(version)?.[1];
        const date = discontinued === undefined ? null : readDate(discontinued);
        if (!MODEL_ID.test(id) || stage === undefined) {
          problems.push(`unrecognized version "${version}" in: ${line}`);
          continue;
        }
        if (date?.kind === 'invalid') {
          problems.push(`\`${id}\`: unknown date format "${date.text}"`);
          continue;
        }
        if (source.models && !source.models.includes(id)) {
          problems.push(`the page lists \`${id}\`, which isn't one of ${source.models.join(', ')}`);
          continue;
        }
        const deprecated = /^deprecated$/i.test(stage);
        const dated = date?.kind === 'date' ? date : null;
        if (deprecated && !dated) {
          problems.push(`\`${id}\` is deprecated but has no discontinuation date`);
          continue;
        }
        rows.push({
          platform: 'vertex',
          provider: 'google',
          model_id: id,
          version: null,
          regions: null,
          state: deprecated ? 'deprecated' : 'available',
          deprecation: null,
          retirement: dated ? dated.date : null,
          qualifier: dated ? dated.qualifier : 'exact',
          replacements: [],
          excerpt: line,
          notes: null,
        });
      }
    }
    return { rows: dedupeRows(rows, problems), problems, exhaustive: true };
  },
};
