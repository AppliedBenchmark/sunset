// Parser for a Vertex AI model page that carries a deprecation notice (`parser:
// vertex-deprecation-notice`), such as the Grok 4.1 Fast page:
//
//   > **Deprecated:** The Grok 4.1 model family (including `xai/grok-4.1-fast-reasoning` and
//   > `xai/grok-4.1-fast-non-reasoning`) is deprecated on … and will be shut down on August 20, 2026. …
//   | Model ID | `grok-4.1-fast-reasoning` ||
//
// - The notice is about every model of the page, one `| Model ID |` row each, and must name each
//   of them, with or without the publisher (`xai/`) that code puts in front on the OpenAI-compatible
//   endpoint. The IDs are kept as the Model ID rows write them.
// - The excerpt runs from `**Deprecated:**` to the end of the sentence with the shutdown date. The
//   notice gives no deprecation date; the models are deprecated, and retired once the shutdown
//   date passes.

import type { Extractor } from '../../src/core/ports.ts';
import {
  type ExtractedRow,
  type Extraction,
  LayoutChangedError,
} from '../../src/core/registry/extract.ts';
import { idAppears } from '../../src/core/registry/grounding.ts';
import { partnerMaker, readDate } from './google.ts';

const NOTICE = /\*\*Deprecated:\*\*.*$/m;
// The sentence that gives the date, up to its full stop.
const SHUT_DOWN = /^.*?\bshut down on (.+?)\.(?=\s|$)/;
const MODEL_ID_ROW = /^\| Model ID \| `([^`]+)` \|/gm;

export const extractor: Extractor = {
  id: 'vertex-deprecation-notice',
  extract(page, { source }): Extraction {
    const notice = NOTICE.exec(page.text);
    const ids = [...page.text.matchAll(MODEL_ID_ROW)].map((m) => (m[1] as string).trim());
    if (!notice || ids.length === 0) {
      throw new LayoutChangedError(
        `the page has no ${notice ? '`| Model ID |` row' : '`**Deprecated:**` notice'}`,
      );
    }
    const sentence = SHUT_DOWN.exec(notice[0]);
    if (!sentence) {
      return {
        rows: [],
        problems: [`the notice has no "shut down on <date>." sentence: ${notice[0]}`],
        exhaustive: true,
      };
    }
    const excerpt = sentence[0];
    const date = readDate(sentence[1] as string);
    if (date.kind !== 'date') {
      return {
        rows: [],
        problems: [`unknown date format "${sentence[1]}" in: ${excerpt}`],
        exhaustive: true,
      };
    }
    const problems: string[] = [];
    const rows: ExtractedRow[] = [];
    for (const id of new Set(ids)) {
      const provider = partnerMaker(id);
      if (!idAppears(id, excerpt)) problems.push(`the notice doesn't name \`${id}\``);
      else if (provider === null) problems.push(`\`${id}\`: unknown model maker`);
      else if (source.models && !source.models.includes(id)) {
        problems.push(`the page is about \`${id}\`, not ${source.models.join(', ')}`);
      } else {
        rows.push({
          platform: 'vertex',
          provider,
          model_id: id,
          version: null,
          regions: null,
          state: 'deprecated',
          deprecation: null,
          retirement: date.date,
          qualifier: date.qualifier,
          replacements: [],
          excerpt,
          notes: null,
        });
      }
    }
    return { rows: problems.length ? [] : rows, problems, exhaustive: true };
  },
};
