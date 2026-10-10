// The scan benchmark: a synthetic 100k-line corpus in 1,000 files,
// scanned end to end (file listing, reading, prefilter, lexing, detectors, severity) with
// synthetic registries of 1k, 5k and 20k expanded IDs. Fails if any scan takes 10 s or more.
// Then scans 1 MiB files built to defeat a scan that isn't linear, each of which must take under a
// second. Writes Markdown tables to the GitHub job summary when there is one.
//
//   npm run bench                 all three registry sizes
//   npm run bench -- --runs 5     median of 5 runs per size (default 3)
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { fixedClock } from '../src/adapters/clock.ts';
import { createFileSource } from '../src/adapters/file-source.ts';
import { scan } from '../src/core/pipeline.ts';
import { expandForms } from '../src/core/registry/formats.ts';
import type { PlatformFormats, Registry, RegistryEntry } from '../src/core/types.ts';

const BUDGET_MS = 10_000;
const ADVERSARIAL_BUDGET_MS = 1_000;
const FILES = 1_000;
const LINES_PER_FILE = 100;
const SIZES = [1_000, 5_000, 20_000];
const TODAY = '2099-01-01';

const { values } = parseArgs({ options: { runs: { type: 'string', default: '3' } } });
const runs = Math.max(1, Number(values.runs));

const formats = parse(
  readFileSync(new URL('../registry/formats.yaml', import.meta.url), 'utf8'),
) as PlatformFormats;

/** mulberry32: an integer-safe PRNG, so the corpus is the same on every platform. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function entry(platform: RegistryEntry['platform'], modelId: string, n: number): RegistryEntry {
  return {
    id: `${platform}:${modelId}`,
    provider: platform,
    platform,
    model_id: modelId,
    version: null,
    aliases: [],
    status: 'deprecated',
    deprecation_date: '2098-06-01' as RegistryEntry['deprecation_date'],
    retirement_date: `2099-0${1 + (n % 9)}-15` as RegistryEntry['retirement_date'],
    retirement_date_qualifier: 'exact',
    recommended_replacements: [],
    drop_in: false,
    source: 'fixture/bench',
    source_url: 'https://fixture.invalid/bench',
    source_excerpt: 'Synthetic benchmark entry.',
    verified_on: TODAY as RegistryEntry['verified_on'],
    notes: null,
  };
}

/** Real-looking IDs: dated GPT, Claude, Gemini, Mistral and DeepSeek names, Bedrock and Vertex forms. */
function syntheticId(i: number): [RegistryEntry['platform'], string] {
  const date = `20${String(30 + (i % 60)).padStart(2, '0')}${String(1 + (i % 12)).padStart(2, '0')}${String(1 + (i % 28)).padStart(2, '0')}`;
  switch (i % 7) {
    case 0:
      return [
        'openai',
        `gpt-${4 + (i % 5)}o-bench-${i}-${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`,
      ];
    case 1:
      return ['anthropic', `claude-bench-${i}-${date}`];
    case 2:
      return ['gemini-api', `gemini-${1 + (i % 3)}.${i % 10}-bench-${i}-00${i % 10}`];
    case 3:
      return ['mistral', `mistral-bench-${i}-${date.slice(2, 6)}`];
    case 4:
      return ['deepseek', `deepseek-bench-${i}`];
    case 5:
      return ['bedrock', `anthropic.claude-bench-${i}-${date}-v1:0`];
    default:
      return ['vertex', `claude-bench-${i}@${date}`];
  }
}

/** A registry with about `size` expanded forms (Bedrock entries expand into 9 forms each). */
function registryOf(size: number): { registry: Registry; ids: string[] } {
  const models: RegistryEntry[] = [];
  let forms = 0;
  for (let i = 0; forms < size; i++) {
    const [platform, id] = syntheticId(i);
    models.push(entry(platform, id, i));
    forms += platform === 'bedrock' ? 1 + formats.bedrock.geo_prefixes.length : 1;
  }
  const registry: Registry = {
    schema_version: 1,
    registry_version: 1,
    generated_at: '2099-01-01T00:00:00Z',
    models,
  };
  return { registry, ids: [...expandForms(registry, formats).keys()] };
}

const EXTENSIONS = ['ts', 'py', 'yaml', 'go', 'json'] as const;

function line(
  ext: (typeof EXTENSIONS)[number],
  i: number,
  literal: string,
  rnd: () => number,
): string {
  const r = rnd();
  switch (ext) {
    case 'ts':
      return r < 0.1
        ? `  const model${i} = process.env.MODEL_${i} ?? '${literal}'; // model note ${i}`
        : `  const value${i} = compute(${i}, '${literal}', \`tmpl \${x${i}} done\`); /* c */`;
    case 'py':
      return r < 0.1
        ? `    resp = client.create(model=settings.model_${i}, prompt="${literal}")  # model`
        : `    value_${i} = compute(${i}, "${literal}", f"tmpl {x_${i}} done")  # comment`;
    case 'yaml':
      return `  key_${i}: "${literal}" # model setting ${i}`;
    case 'go':
      return `\tvalue${i} := compute(${i}, "${literal}", \`raw ${i}\`) // model`;
    case 'json':
      return `  "key_${i}": "${literal}",`;
  }
}

/** 100k lines; about 0.3% hold a registry ID and many more hold near misses. */
function writeCorpus(dir: string, ids: string[]): void {
  const rnd = prng(42);
  for (let f = 0; f < FILES; f++) {
    const ext = EXTENSIONS[f % EXTENSIONS.length] as (typeof EXTENSIONS)[number];
    const out: string[] = [];
    for (let l = 0; l < LINES_PER_FILE; l++) {
      const r = rnd();
      const id = ids[Math.floor(rnd() * ids.length)] as string;
      // A hit, a near miss (a longer ID), or ordinary text.
      const literal = r < 0.003 ? id : r < 0.05 ? `${id}-preview` : `text ${f}-${l} gpt claude`;
      out.push(line(ext, l, literal, rnd));
    }
    const sub = join(dir, `pkg${f % 20}`);
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, `file${f}.${ext}`), `${out.join('\n')}\n`);
  }
}

async function timeScan(dir: string, registry: Registry) {
  const started = performance.now();
  const result = await scan({
    root: dir,
    files: createFileSource({ git: false }),
    registry,
    formats,
    clock: fixedClock(TODAY),
    now: () => performance.now(),
  });
  return { ms: performance.now() - started, result };
}

const median = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

const rows: string[] = [];
let failed = false;
for (const size of SIZES) {
  const { registry, ids } = registryOf(size);
  const dir = mkdtempSync(join(tmpdir(), 'sunset-bench-'));
  try {
    // The corpus draws IDs from the registry being measured, so every size has hits.
    writeCorpus(dir, ids);
    await timeScan(dir, registry); // warm-up
    const times: number[] = [];
    let last = await timeScan(dir, registry);
    times.push(last.ms);
    for (let r = 1; r < runs; r++) {
      last = await timeScan(dir, registry);
      times.push(last.ms);
    }
    const ms = median(times);
    const { stats, findings, unresolved, inventory } = last.result;
    const ok = ms < BUDGET_MS;
    failed ||= !ok;
    rows.push(
      `| ${ids.length.toLocaleString('en-US')} | ${stats.lines.toLocaleString('en-US')} | ${stats.files.scanned} | ${stats.files.lexed} | ${findings.length} | ${unresolved.length} | ${inventory.length} | ${(ms / 1000).toFixed(2)} s | ${ok ? 'pass' : '**over budget**'} |`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MIB = 1024 * 1024;

/** A file of exactly 1 MiB: `head`, then `unit` repeated. */
const mebibyte = (head: string, unit: string): string =>
  head + unit.repeat(Math.ceil(MIB / unit.length)).slice(0, MIB - head.length);

/** Inputs that once made a detector rescan the text for every match, or backtrack over it. */
const ADVERSARIAL: [string, string, string][] = [
  ['hyphen chain in a string', 'a.js', mebibyte('// model\nconst ID = "', 'ab-')],
  ['hyphen chain as a value', 'a.py', mebibyte('x = ', 'model-')],
  ['minified properties', 'a.js', mebibyte('', 'f({model:e,messages:t});')],
  ['keyword arguments', 'a.py', mebibyte('', 'r = client.create(model=m, messages=[])\n')],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the file holds a JavaScript template.
  ['interpolated properties', 'a.js', mebibyte('', 'f({model:`${a}`});')],
  ['flags on one line', 'run.sh', mebibyte('', '--model $X ')],
  ['quoted IDs in one string', 'a.py', mebibyte('x = """', "'deepseek-bench-4' or ")],
  ['a list of IDs in one string', 'a.py', mebibyte('x = """', 'deepseek-bench-4 ')],
  ['deployment keys on one line', 'a.ts', mebibyte('', 'deploymentName: x, ')],
  [
    'unclosed Terraform model blocks',
    'main.tf',
    mebibyte('resource "azurerm_cognitive_deployment" "d" {\n', 'model {\n'),
  ],
  [
    'unclosed Bicep model blocks',
    'main.bicep',
    mebibyte('// Microsoft.CognitiveServices/accounts/deployments\n', 'model: {\n'),
  ],
  [
    'endless az continuation',
    'deploy.sh',
    mebibyte('', 'az cognitiveservices account deployment create \\\n'),
  ],
];

const adversarialRows: string[] = [];
const { registry: small } = registryOf(SIZES[0] as number);
for (const [name, path, text] of ADVERSARIAL) {
  const dir = mkdtempSync(join(tmpdir(), 'sunset-bench-'));
  try {
    writeFileSync(join(dir, path), text);
    const { ms, result } = await timeScan(dir, small);
    const ok = ms < ADVERSARIAL_BUDGET_MS && result.stats.files.lexed === 1;
    failed ||= !ok;
    adversarialRows.push(
      `| ${name} | \`${path}\` | ${(ms / 1000).toFixed(2)} s | ${ok ? 'pass' : '**over budget**'} |`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const report = [
  `### Scan benchmark (Node ${process.versions.node}, ${process.platform}/${process.arch}, median of ${runs})`,
  '',
  'End to end: listing, reading, prefilter, lexing, detectors and severity. Budget: under 10 s.',
  '',
  '| Expanded IDs | Lines | Files scanned | Files lexed | Findings | Unresolved | Inventory | Time | Result |',
  '|---:|---:|---:|---:|---:|---:|---:|---:|---|',
  ...rows,
  '',
  `Adversarial files of 1 MiB, one scan each. Budget: under ${ADVERSARIAL_BUDGET_MS / 1000} s per file.`,
  '',
  '| Input | File | Time | Result |',
  '|---|---|---:|---|',
  ...adversarialRows,
  '',
].join('\n');

console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
if (failed) {
  console.error('A scan went over its time budget.');
  process.exitCode = 1;
}
