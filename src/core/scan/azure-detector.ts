// The Azure deployment detector: Azure retires per model *and version*, and deployment
// names are user-defined, so references are matched on the (name, version) pair in:
//
// - Terraform `azurerm_cognitive_deployment` → `model { name = "…", version = "…" }`
// - Bicep and ARM `Microsoft.CognitiveServices/accounts/deployments` → `properties.model { name, version }`
// - `az cognitiveservices account deployment create --model-name … --model-version …`
//
// Azure Verified Modules take the same `model` object (`br/public:avm/res/cognitive-services/
// account` in Bicep, `cognitive_deployments` in Terraform), and the Azure/openai/azurerm module
// takes `model_format`, `model_name` and `model_version`.
//
// Without a version, Azure assigns the default one at deployment time, so the reference is
// `unresolved` and lists every known version. A name or version the registry doesn't list is
// `unresolved` too: these findings speak for the name, so it never gets first-party dates.
//
// Code that calls a deployment names it instead: `azure/<deployment>` in LiteLLM,
// `azure:chat:<deployment>` in promptfoo, `/openai/deployments/<deployment>/` in a URL. A
// deployment named after a model probably runs that model, but its version is set where the
// deployment is created, so these are `unresolved` too, with the model's known versions.
import { own } from '../own.ts';
import type { Detector, Matcher } from '../ports.ts';
import type {
  AzureDeploymentSource,
  Language,
  PlatformFormats,
  RawFinding,
  RegistryEntry,
  Span,
  Spans,
  UnresolvedReason,
} from '../types.ts';
import { HCL_TYPE } from './dynamic-detector.ts';
import { spanAt } from './lines.ts';

interface Field {
  value: string;
  start: number;
  end: number;
  /** False when the value isn't a plain literal (a variable, a parameter, an interpolation). */
  literal: boolean;
}

interface Deployment {
  source: AzureDeploymentSource;
  name: Field | null;
  version: Field | null;
}

/** Text that a file deploying Azure models contains. */
const MARKERS: Record<Exclude<AzureDeploymentSource, 'cli'>, readonly string[]> = {
  terraform: ['azurerm_cognitive_deployment', 'cognitive_deployments'],
  bicep: ['Microsoft.CognitiveServices/accounts/deployments', 'avm/res/cognitive-services/account'],
  arm: ['Microsoft.CognitiveServices/accounts/deployments'],
};

const BLOCK_OPENERS: Record<Exclude<AzureDeploymentSource, 'cli'>, RegExp> = {
  terraform: /(?<![\w-])model\s*=?\s*\{/g,
  bicep: /(?<![\w-])model\s*:\s*\{/g,
  arm: /"model"\s*:\s*\{/g,
};

/**
 * The offset of the `}` that closes each `{` outside strings and comments, in one pass; an
 * unclosed `{` runs to the end of the text.
 */
function closingBraces(text: string, spans: Spans): Map<number, number> {
  const closes = new Map<number, number>();
  const open: number[] = [];
  let s = 0;
  for (let i = 0; i < text.length; i++) {
    while (s < spans.length && (spans[s] as Span).end <= i) s++;
    const span = spans[s];
    if (span && span.start <= i) {
      i = span.end - 1;
      continue;
    }
    const c = text[i];
    if (c === '{') open.push(i);
    else if (c === '}') {
      const at = open.pop();
      if (at !== undefined) closes.set(at, i);
    }
  }
  for (const at of open) closes.set(at, text.length);
  return closes;
}

/** Model names and versions are short; a longer quoted value isn't one. */
const MAX_VALUE = 256;

/**
 * Every `key = value` (Terraform), `key: value` (Bicep) or `"key": value` (ARM) outside other
 * strings and comments, in order. Each block then takes the first one inside it.
 */
function fields(text: string, spans: Spans, key: string, source: AzureDeploymentSource): Field[] {
  const pattern =
    source === 'terraform'
      ? new RegExp(`(?<![\\w-])${key}\\s*=\\s*`, 'g')
      : source === 'bicep'
        ? new RegExp(`(?<![\\w-])${key}\\s*:\\s*`, 'g')
        : new RegExp(`"${key}"\\s*:\\s*`, 'g');
  const out: Field[] = [];
  for (const m of text.matchAll(pattern)) {
    const keySpan = spanAt(spans, m.index);
    if (keySpan?.kind === 'comment') continue;
    if (source !== 'arm' && keySpan) continue; // a key inside some string
    const p = m.index + m[0].length;
    const quote = text[p];
    if (quote === '"' || quote === "'") {
      const close = text.slice(p + 1, p + 1 + MAX_VALUE).indexOf(quote);
      const end = close === -1 ? Math.min(text.length, p + 1 + MAX_VALUE) : p + 1 + close;
      const value = text.slice(p + 1, end);
      const literal = !/\$\{|\[|%\{/.test(value);
      out.push({ value, start: p + 1, end, literal });
      continue;
    }
    // A reference such as `var.model_version` or a Bicep parameter, but not a Terraform type
    // constraint (`model_name = string` in a variable's `object({…})`).
    const expr = /^[^\s,}\n]+/.exec(text.slice(p, p + MAX_VALUE))?.[0] ?? '';
    if (!expr || (source === 'terraform' && HCL_TYPE.test(expr))) continue;
    out.push({ value: expr, start: p, end: p + expr.length, literal: false });
  }
  return out;
}

/** The first field that starts in [from, to), by binary search. */
function firstIn(list: readonly Field[], from: number, to: number): Field | null {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] as Field).start < from) lo = mid + 1;
    else hi = mid;
  }
  const found = list[lo];
  return found && found.start < to ? found : null;
}

/** The innermost `{` around each of `positions` (sorted), outside strings and comments, or -1. */
function openingBraces(text: string, spans: Spans, positions: readonly number[]): number[] {
  const out: number[] = [];
  const open: number[] = [];
  let s = 0;
  let i = 0;
  for (const pos of positions) {
    for (; i < pos; i++) {
      while (s < spans.length && (spans[s] as Span).end <= i) s++;
      const span = spans[s];
      if (span && span.start <= i) {
        i = span.end - 1;
        continue;
      }
      if (text[i] === '{') open.push(i);
      else if (text[i] === '}') open.pop();
    }
    out.push(open[open.length - 1] ?? -1);
  }
  return out;
}

function blockDeployments(
  text: string,
  spans: Spans,
  source: Exclude<AzureDeploymentSource, 'cli'>,
): Deployment[] {
  if (!MARKERS[source].some((marker) => text.includes(marker))) return [];
  const closes = closingBraces(text, spans);
  const names = fields(text, spans, 'name', source);
  const versions = fields(text, spans, 'version', source);
  const out: Deployment[] = [];
  for (const m of text.matchAll(BLOCK_OPENERS[source])) {
    if (spanAt(spans, m.index)?.kind === 'comment') continue;
    const open = m.index + m[0].length - 1;
    const close = closes.get(open) ?? text.length;
    out.push({
      source,
      name: firstIn(names, open, close),
      version: firstIn(versions, open, close),
    });
  }
  return out;
}

/**
 * Deployments as module inputs, objects with `model_format`, `model_name` and `model_version`
 * (the Azure/openai/azurerm Terraform module): one for each object around a `model_format`.
 */
function moduleDeployments(text: string, spans: Spans): Deployment[] {
  const formats = fields(text, spans, 'model_format', 'terraform');
  if (formats.length === 0) return [];
  const closes = closingBraces(text, spans);
  const names = fields(text, spans, 'model_name', 'terraform');
  const versions = fields(text, spans, 'model_version', 'terraform');
  const out: Deployment[] = [];
  for (const open of openingBraces(
    text,
    spans,
    formats.map((f) => f.start),
  )) {
    if (open === -1) continue;
    const close = closes.get(open) ?? text.length;
    out.push({
      source: 'terraform',
      name: firstIn(names, open, close),
      version: firstIn(versions, open, close),
    });
  }
  return out;
}

const AZ_COMMAND = /\baz\s+cognitiveservices\s+account\s+deployment\s+create\b/g;

/** `--flag value`, `--flag=value` or `--flag "value"` within the command text. */
function flag(command: string, offset: number, name: string): Field | null {
  const m = new RegExp(`--${name}(?:=|[ \\t]+)(["']?)([^\\s"'\\\\]+)\\1`).exec(command);
  if (!m) return null;
  const value = m[2] as string;
  const start = offset + m.index + m[0].length - value.length - (m[1] as string).length;
  return { value, start, end: start + value.length, literal: !value.includes('$') };
}

function cliDeployments(text: string, spans: Spans): Deployment[] {
  const out: Deployment[] = [];
  let previousEnd = -1;
  for (const m of text.matchAll(AZ_COMMAND)) {
    // Inside the previous command's continuation lines, it's one of that command's arguments.
    if (m.index < previousEnd) continue;
    if (spanAt(spans, m.index)?.kind === 'comment') continue;
    // The command runs to the end of the line, following `\` and PowerShell `` ` `` continuations.
    let end = m.index;
    for (;;) {
      const eol = text.indexOf('\n', end);
      if (eol === -1) {
        end = text.length;
        break;
      }
      const line = text.slice(end, eol).replace(/\r$/, '');
      end = eol;
      if (!/[\\`]\s*$/.test(line)) break;
      end = eol + 1;
    }
    previousEnd = end;
    const command = text.slice(m.index, end);
    out.push({
      source: 'cli',
      name: flag(command, m.index, 'model-name'),
      version: flag(command, m.index, 'model-version'),
    });
  }
  return out;
}

const BLOCK_SOURCES: Partial<Record<Language, Exclude<AzureDeploymentSource, 'cli'>>> = {
  hcl: 'terraform',
  bicep: 'bicep',
  json: 'arm',
};

function resolve(deployment: Deployment, matcher: Matcher): RawFinding | null {
  const { name, version, source } = deployment;
  if (!name) return null;
  const unresolved = (
    reason: UnresolvedReason,
    key: string,
    expression: string,
    entries: RegistryEntry[],
    end = name.end,
  ): RawFinding => ({
    kind: 'unresolved',
    start: name.start,
    end,
    reason,
    key,
    expression,
    entries,
    claims: true,
  });
  if (!name.literal) return unresolved('variable', 'model.name', name.value, []);
  const known = matcher.azure(name.value);
  if (known.length === 0) return unresolved('azure-unknown', 'model.name', name.value, []);
  if (!version?.literal) {
    return version
      ? unresolved('variable', 'model.version', version.value, [...known], version.end)
      : unresolved('azure-no-version', 'model.name', name.value, [...known]);
  }
  const entries = known.filter((e) => e.version === version.value);
  if (entries.length === 0) {
    return unresolved('azure-unknown', 'model.version', version.value, [...known], version.end);
  }
  return {
    kind: 'reference',
    start: name.start,
    end: name.end,
    text: name.value,
    context: { kind: 'azure-deployment', source },
    entries,
    claims: true,
  };
}

const URL_DEPLOYMENT = /openai\/deployments\/([A-Za-z0-9_.-]+)/g;
const patterns = new WeakMap<PlatformFormats, RegExp>();

/**
 * `<prefix>/<deployment>` or `<prefix>:<route>:<deployment>` for each prefix in formats.yaml that
 * names Azure; the deployment is the last segment.
 */
function prefixPattern(formats: PlatformFormats): RegExp {
  let pattern = patterns.get(formats);
  if (!pattern) {
    const prefixes = Object.keys(formats.prefixes ?? {}).filter((p) =>
      own(formats.prefixes ?? {}, p)?.includes('azure-openai'),
    );
    pattern = new RegExp(
      `(?<![\\p{L}\\p{M}\\p{N}_./:-])(?:${prefixes.join('|') || '(?!)'})[/:](?:[A-Za-z0-9_.-]+[/:])*([A-Za-z0-9_.-]+)(?![\\p{L}\\p{M}\\p{N}_./:-])`,
      'gu',
    );
    patterns.set(formats, pattern);
  }
  return pattern;
}

/** Deployments that code calls by name, when the name is a model Azure lists. */
function namedDeployments(text: string, spans: Spans, matcher: Matcher): RawFinding[] {
  const out: RawFinding[] = [];
  for (const pattern of [prefixPattern(matcher.formats), URL_DEPLOYMENT]) {
    for (const m of text.matchAll(pattern)) {
      const name = m[1] as string;
      const start = m.index + m[0].length - name.length;
      const end = start + name.length;
      const span = spanAt(spans, start, end);
      if (!span || span.kind === 'comment') continue;
      const known = matcher.azure(name);
      if (known.length === 0) continue;
      out.push({
        kind: 'unresolved',
        start,
        end,
        reason: 'azure-deployment-name',
        key: null,
        expression: m[0],
        entries: [...known],
        claims: true,
      });
    }
  }
  return out;
}

export const azureDetector: Detector = {
  id: 'azure-deployment',
  detect(file, text, spans, matcher) {
    if (file.class === 'docs') return [];
    const source = file.language ? BLOCK_SOURCES[file.language] : undefined;
    const cli =
      file.language === 'shell' ||
      file.language === 'powershell' ||
      file.language === 'yaml' ||
      file.language === 'ruby';
    // Array literals, not `push(...)`, which overflows the stack with a large file's deployments.
    const deployments = [
      ...(source ? blockDeployments(text, spans, source) : []),
      ...(source === 'terraform' ? moduleDeployments(text, spans) : []),
      ...(cli ? cliDeployments(text, spans) : []),
    ];
    const out: RawFinding[] = [];
    for (const deployment of deployments) {
      const finding = resolve(deployment, matcher);
      if (finding) out.push(finding);
    }
    return [...out, ...namedDeployments(text, spans, matcher)];
  },
};
