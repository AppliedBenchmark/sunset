// Parser for Vertex AI's per-model Claude pages (`parser: vertex-claude-model-page`). Each page has one `**Retirement Date:** Not sooner than <date>.` line and a
// `| Model ID | \`<id>\` ||` row. The model is `available`; the date is a no-earlier-than date
// when the line says so.

import type { Extractor } from '../../src/core/ports.ts';
import { type Extraction, LayoutChangedError } from '../../src/core/registry/extract.ts';
import { partnerMaker, readDate } from './google.ts';

const RETIREMENT = /^\*\*Retirement date:\*\*\s*(.+)$/im;
const MODEL_ID_ROW = /^\| Model ID \| `([^`]+)` \|/m;

export const extractor: Extractor = {
  id: 'vertex-claude-model-page',
  extract(page, { source }): Extraction {
    const retirement = RETIREMENT.exec(page.text);
    const modelRow = MODEL_ID_ROW.exec(page.text);
    if (!retirement || !modelRow) {
      throw new LayoutChangedError(
        `the page has no ${retirement ? '`| Model ID |` row' : '`**Retirement Date:**` line'}`,
      );
    }
    const modelId = (modelRow[1] as string).trim();
    const provider = partnerMaker(modelId);
    const date = readDate(retirement[1] as string);
    const problems: string[] = [];
    if (date.kind === 'invalid')
      problems.push(`\`${modelId}\`: unknown date format "${date.text}"`);
    if (provider === null) problems.push(`\`${modelId}\`: unknown model maker`);
    if (source.models && !source.models.includes(modelId)) {
      problems.push(`the page is about \`${modelId}\`, not ${source.models.join(', ')}`);
    }
    if (problems.length) return { rows: [], problems, exhaustive: true };
    return {
      rows: [
        {
          platform: 'vertex',
          provider: provider as string,
          model_id: modelId,
          version: null,
          regions: null,
          state: 'available',
          deprecation: null,
          retirement: date.kind === 'date' ? date.date : null,
          qualifier: date.kind === 'date' ? date.qualifier : 'exact',
          replacements: [],
          excerpt: retirement[0].trim(),
          notes: null,
        },
      ],
      problems,
      exhaustive: true,
    };
  },
};
