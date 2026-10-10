// A scan result that exercises every part of every report: each severity, an alias, a Bedrock
// profile with per-region dates, an Azure deployment, unresolved references, a docs mention,
// an inventory item, both kinds of suppression, an expired suppression and both diagnostics.
import type {
  Finding,
  IsoDate,
  Location,
  RegistryEntry,
  ScanResult,
} from '../../src/core/types.ts';
import type { ReportContext } from '../../src/report/common.ts';
import { scanFiles } from '../helpers.ts';

export const SAMPLE_FILES: Record<string, string> = {
  'src/client.ts': [
    "import OpenAI from 'openai';",
    "const retired = 'gpt-fixture-retired';",
    "const soon = 'gpt-fixture-1-2099-01-10';",
    "const later = 'gpt-fixture-2-2099-02-15';",
    "const far = 'gpt-fixture-3';",
    "const unknown = 'gpt-fixture-unverified';",
    "const notInRegistry = 'gpt-9-turbo';",
    'const fromEnv = await client.create({ model: process.env.MODEL });',
    'const kept = \'gpt-fixture-retired\'; // sunset-ignore reason="pinned for replay tests"',
    "const stale = 'gpt-fixture-retired'; // sunset-ignore until=2098-12-31",
    "const typo = 'gpt-fixture-retired'; // sunset-ignore until=soon",
    '',
  ].join('\n'),
  'infra/bedrock.py': [
    'MODEL = "us-gov.anthropic.claude-fixture-1-20990101-v1:0"',
    'OPUS = "anthropic.claude-fixture-opus-9"',
    'NAME = "the | pipe `tick` <b>"  # not a model',
    '',
  ].join('\n'),
  'infra/main.tf': [
    'resource "azurerm_cognitive_deployment" "chat" {',
    '  model {',
    '    format  = "OpenAI"',
    '    name    = "gpt-fixture-4o"',
    '    version = "2099-01-05"',
    '  }',
    '}',
    '',
  ].join('\n'),
  'docs/migration.md': 'We moved off `gpt-fixture-retired` in 2098.\n',
};

export const SAMPLE_CONTEXT: ReportContext = { version: '1.2.3', registryOrigin: 'bundled' };

export const LINKED_CONTEXT: ReportContext = {
  ...SAMPLE_CONTEXT,
  fileUrl: (l) => `https://github.com/o/r/blob/abc123/${l.path}#L${l.line}`,
};

export function sampleResult(): Promise<ScanResult> {
  return scanFiles(SAMPLE_FILES, {
    ignores: [
      { paths: ['infra/main.tf'], reason: 'expired ignore', until: '2098-06-01' as IsoDate },
      { models: ['gpt-fixture-3'], reason: 'tracked in #42', until: '2099-06-30' as IsoDate },
    ],
  });
}

const loc = (i: number): Location => ({
  path: `src/f${String(Math.floor(i / 1000)).padStart(3, '0')}.ts`,
  line: (i % 1000) + 1,
  column: 5,
  endLine: (i % 1000) + 1,
  endColumn: 25,
});

/** `n` synthetic findings, cycling through the severities, for the limit tests. */
export function manyFindings(base: ScanResult, n: number): ScanResult {
  const template = base.findings.find((f) => f.rule === 'model-retired') as Finding;
  const entry = template.entry as RegistryEntry;
  const severities = ['notice', 'warning', 'error'] as const;
  const findings: Finding[] = Array.from({ length: n }, (_, i) => {
    // Each finding names its own model, so the summary can't group them.
    const own = {
      ...entry,
      id: `openai:gpt-fixture-retired-${i}`,
      model_id: `gpt-fixture-retired-${i}`,
    };
    return {
      ...template,
      severity: severities[i % 3] as Finding['severity'],
      modelId: own.model_id,
      entry: own,
      entries: [own],
      location: loc(i),
    };
  });
  return {
    ...base,
    findings,
    unresolved: [],
    mentions: [],
    diagnostics: [],
    inventory: [],
    suppressed: [],
  };
}
