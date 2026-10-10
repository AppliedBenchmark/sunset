// The deterministic parsers, by the `parser` id a source names in sources.yaml.
import type { Extractor } from '../../src/core/ports.ts';
import { extractor as anthropicDeprecations } from './anthropic-deprecations.ts';
import { extractor as azureRetiredModels } from './azure-retired-models.ts';
import { extractor as azureRetirementTables } from './azure-retirement-tables.ts';
import { extractor as bedrockLifecycleTable } from './bedrock-lifecycle-table.ts';
import { extractor as bedrockModelCard } from './bedrock-model-card.ts';
import { extractor as deepseekUpdates } from './deepseek-updates.ts';
import { extractor as geminiApiDeprecations } from './gemini-api-deprecations.ts';
import { extractor as geminiApiReleaseNotes } from './gemini-api-release-notes.ts';
import { extractor as mistralModelFiles } from './mistral-model-files.ts';
import { extractor as openaiDeprecations } from './openai-deprecations.ts';
import { extractor as vertexClaudeModelPage } from './vertex-claude-model-page.ts';
import { extractor as vertexDeprecationNotice } from './vertex-deprecation-notice.ts';
import { extractor as vertexModelPageVersions } from './vertex-model-page-versions.ts';
import { extractor as vertexModelVersions } from './vertex-model-versions.ts';
import { extractor as vertexOpenModelDeprecations } from './vertex-open-model-deprecations.ts';
import { extractor as vertexPartnerDeprecations } from './vertex-partner-deprecations.ts';

export const EXTRACTORS: ReadonlyMap<string, Extractor> = new Map(
  [
    anthropicDeprecations,
    azureRetiredModels,
    azureRetirementTables,
    bedrockLifecycleTable,
    bedrockModelCard,
    deepseekUpdates,
    geminiApiDeprecations,
    geminiApiReleaseNotes,
    mistralModelFiles,
    openaiDeprecations,
    vertexClaudeModelPage,
    vertexDeprecationNotice,
    vertexModelPageVersions,
    vertexModelVersions,
    vertexOpenModelDeprecations,
    vertexPartnerDeprecations,
  ].map((e) => [e.id, e]),
);
