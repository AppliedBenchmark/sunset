// Parser for Vertex AI's deprecated partner (MaaS) models page (`parser:
// vertex-partner-deprecations`). One `## <model>` section per model, in prose:
//
//   <Model> is **deprecated as of <date>** and will be **shut down on <date>**. …
//   | Model ID | `<id>` ||
//
// The prose wraps across lines, so the excerpt is the section's text from the paragraph that
// carries the dates through the Model ID row, with its whitespace collapsed. The model is
// `deprecated` (retired once the shutdown date passes).

import type { Extractor } from '../../src/core/ports.ts';
import {
  type ExtractedRow,
  type Extraction,
  LayoutChangedError,
} from '../../src/core/registry/extract.ts';
import { partnerMaker, readDate } from './google.ts';

const DEPRECATED = /\*\*deprecated as of ([^*]+?)\*\*/i;
const SHUT_DOWN = /\*\*shut down on ([^*]+?)\*\*/i;
const MODEL_ID_ROW = /^\| Model ID \| `([^`]+)` \|.*$/m;

export const extractor: Extractor = {
  id: 'vertex-partner-deprecations',
  extract(page): Extraction {
    const rows: ExtractedRow[] = [];
    const problems: string[] = [];
    const sections = page.text.split(/^(?=## )/m).filter((s) => s.startsWith('## '));
    for (const section of sections) {
      const heading = (section.split('\n')[0] as string).slice(3).trim();
      const modelRow = MODEL_ID_ROW.exec(section);
      if (!modelRow) {
        problems.push(`section "${heading}" has no Model ID row`);
        continue;
      }
      const modelId = (modelRow[1] as string).trim();
      // The paragraph that states the shutdown, up to and including the Model ID row.
      const before = section.slice(0, modelRow.index + modelRow[0].length);
      const paragraphs = before.split(/\n\s*\n/);
      const start = paragraphs.findIndex((p) => SHUT_DOWN.test(p));
      if (start < 0) {
        problems.push(`\`${modelId}\`: no "**shut down on <date>**" sentence`);
        continue;
      }
      const excerpt = paragraphs.slice(start).join(' ').replace(/\s+/g, ' ').trim();
      const shutdown = readDate((SHUT_DOWN.exec(excerpt) as RegExpExecArray)[1] as string);
      const deprecatedMatch = DEPRECATED.exec(excerpt);
      const deprecation = deprecatedMatch ? readDate(deprecatedMatch[1] as string) : null;
      const provider = partnerMaker(modelId);
      if (shutdown.kind !== 'date' || (deprecation && deprecation.kind !== 'date')) {
        problems.push(`\`${modelId}\`: unknown date format in "${excerpt.slice(0, 160)}"`);
        continue;
      }
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
        deprecation: deprecation?.kind === 'date' ? deprecation.date : null,
        retirement: shutdown.date,
        qualifier: shutdown.qualifier,
        replacements: [],
        excerpt,
        notes: null,
      });
    }
    if (rows.length === 0) {
      throw new LayoutChangedError(
        'no `## <model>` section with a Model ID row and a shutdown date',
      );
    }
    return { rows, problems, exhaustive: true };
  },
};
