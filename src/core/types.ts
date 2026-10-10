// Domain types. The registry types are generated from registry/schema.json; their field names
// follow the YAML files, so they are snake_case.

export type {
  DateQualifier,
  IsoDate,
  ModelStatus,
  Platform,
  PlatformFormats,
  Registry,
  RegistryEntry,
  Replacement,
  Source,
  SourceFetch,
  SourcesFile,
} from './registry/types.gen.ts';

import type { IsoDate, RegistryEntry } from './registry/types.gen.ts';

export type Severity = 'error' | 'warning' | 'notice';

// ── Files and lexing ─────────────────────────────────────────────────────────────────────────

/** A file as listed by a FileSource. `path` is relative to the scan root and POSIX-style. */
export interface FileRef {
  path: string;
  size: number;
}

export type FileClass = 'code' | 'config' | 'docs' | 'test' | 'vendored' | 'generated';

/**
 * The lexer languages; each maps to exactly one Lexer. A notebook's code cells are lexed in its
 * kernel's language (scan/notebook.ts); its own lexer only reads notebooks that aren't valid nbformat.
 */
export type Language =
  | 'javascript'
  | 'java'
  | 'kotlin'
  | 'csharp'
  | 'go'
  | 'rust'
  | 'swift'
  | 'c'
  | 'php'
  | 'scala'
  | 'dart'
  | 'bicep'
  | 'python'
  | 'shell'
  | 'ruby'
  | 'toml'
  | 'ini'
  | 'yaml'
  | 'json'
  | 'notebook'
  | 'hcl'
  | 'powershell'
  | 'html'
  | 'lua'
  | 'r';

export interface ClassifiedFile extends FileRef {
  class: FileClass;
  /**
   * Null when no lexer handles the file, and for docs, which are matched without one. A notebook
   * keeps `notebook` as docs too, so that only its cells are matched.
   */
  language: Language | null;
}

export type SpanKind = 'string' | 'comment' | 'value';

/**
 * A lexed region. Offsets are UTF-16 code units, `end` exclusive. String spans cover the
 * content only, without quotes; an interpolated string yields one span per literal segment.
 */
export interface Span {
  start: number;
  end: number;
  kind: SpanKind;
  /** For string spans: the offset where the whole literal starts (its prefix or opening quote). */
  open?: number;
  /** For string spans: the literal contains interpolation (`${…}`, f-string fields, `$var`, …). */
  interpolated?: boolean;
}

/** Spans sorted by `start`, non-overlapping and within the text. */
export type Spans = readonly Span[];

// ── Findings ─────────────────────────────────────────────────────────────────────────────────

export type RuleId =
  | 'model-retired'
  | 'model-retiring'
  | 'model-deprecated'
  | 'model-unverified'
  | 'model-legacy'
  | 'model-reference-unresolved'
  | 'model-id-unknown'
  | 'suppression-expired';

/**
 * A model router: a service that serves `<vendor>/<id>` through any provider that still has the
 * model.
 */
export type Router = 'openrouter' | 'vercel-ai-gateway';

/** How a registry ID was written, which also decides which platforms it can refer to. */
export type ReferenceContext =
  | { kind: 'literal' }
  | { kind: 'bedrock-profile'; geo: string }
  | { kind: 'bedrock-arn'; resource: 'foundation-model' | 'inference-profile'; geo: string | null }
  | { kind: 'vertex-path'; publisher: string }
  /** A router's `<vendor>/<id>` slug, which gets the vendor's dates. */
  | { kind: Router; vendor: string }
  /** A library's prefix that names the platform, as written: `gemini/`, `anthropic:`. */
  | { kind: 'prefix'; prefix: string }
  | { kind: 'azure-deployment'; source: AzureDeploymentSource };

export type AzureDeploymentSource = 'terraform' | 'bicep' | 'arm' | 'cli';

export type UnresolvedReason =
  | 'environment'
  | 'variable'
  | 'interpolated'
  | 'opaque-arn'
  | 'azure-no-version'
  | 'azure-unknown'
  | 'azure-deployment-name';

/** What a detector reports, before resolution, suppression and severity. Offsets as in Span. */
export type RawFinding =
  | {
      kind: 'reference';
      start: number;
      end: number;
      /** The text that matched, e.g. `us.anthropic.claude-…` or an Azure model name. */
      text: string;
      context: ReferenceContext;
      /** Candidate entries, already narrowed by the context. Never empty. */
      entries: RegistryEntry[];
      /** See the `unresolved` variant. */
      claims?: boolean;
    }
  | {
      kind: 'unresolved';
      start: number;
      end: number;
      reason: UnresolvedReason;
      /** The key the value is assigned to, e.g. `model` or `--model-name`. */
      key: string | null;
      /** The non-literal expression, shortened for display. */
      expression: string;
      /** Entries the reference could be, when known (Azure deployments without a version). */
      entries: RegistryEntry[];
      /**
       * The finding speaks for the model name at its place, so a reference or an inventory item
       * that another detector reports there is dropped: an Azure deployment's model name is also
       * a first-party ID, which has other dates.
       */
      claims?: boolean;
    }
  | { kind: 'inventory'; start: number; end: number; text: string };

export interface Location {
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based, in UTF-16 code units (SARIF `columnKind: utf16CodeUnits`). */
  column: number;
  endLine: number;
  /** Exclusive. */
  endColumn: number;
}

export interface Finding {
  rule: RuleId;
  severity: Severity;
  location: Location;
  fileClass: FileClass;
  /** The text that matched; for `suppression-expired`, the directive. */
  modelId: string;
  context: ReferenceContext | null;
  /**
   * The entry that decides the severity: of region-scoped entries, the one with the earliest date.
   * Null for `suppression-expired`.
   */
  entry: RegistryEntry | null;
  /** Every candidate entry: other regions and other platforms sharing the ID. */
  entries: RegistryEntry[];
  retirementDate: IsoDate | null;
  /** Whole UTC days from today to the retirement date; negative once it has passed. */
  daysLeft: number | null;
  message: string;
}

export interface UnresolvedReference {
  rule: 'model-reference-unresolved';
  severity: 'notice';
  location: Location;
  fileClass: FileClass;
  reason: UnresolvedReason;
  key: string | null;
  expression: string;
  entries: RegistryEntry[];
  message: string;
}

/** A registry ID in a docs file: never fails a run, never annotated. */
export interface Mention {
  location: Location;
  modelId: string;
  entry: RegistryEntry;
  entries: RegistryEntry[];
  /** What the severity would be in code. */
  severity: Severity;
  message: string;
}

/** A model-like string that isn't in the registry. JSON only; never fails a run. */
export interface InventoryItem {
  modelId: string;
  locations: Location[];
}

export interface Suppressed {
  rule: RuleId;
  location: Location;
  modelId: string;
  by: 'inline' | 'config';
  until: IsoDate | null;
  reason: string | null;
}

export type DiagnosticKind = 'malformed-directive' | 'expired-config-ignore';

/** A problem with the scan's own input, such as a malformed directive. Reported as a notice. */
export interface Diagnostic {
  kind: DiagnosticKind;
  message: string;
  location: Location | null;
}

export type SkipReason =
  | 'excluded'
  | 'vendored'
  | 'generated'
  | 'binary'
  | 'too-large'
  | 'no-lexer';

export interface ScanStats {
  files: {
    listed: number;
    /** Read and checked against the registry (code, config, test and docs). */
    scanned: number;
    /** Passed the prefilter and were lexed. */
    lexed: number;
    skipped: Record<SkipReason, number>;
  };
  lines: number;
  /** Stage timings in milliseconds; zero when no timer is injected. */
  timings: { list: number; scan: number; total: number };
}

export interface ScanResult {
  /** Sorted by path, line, column and rule. */
  findings: Finding[];
  unresolved: UnresolvedReference[];
  mentions: Mention[];
  inventory: InventoryItem[];
  suppressed: Suppressed[];
  diagnostics: Diagnostic[];
  registry: {
    schemaVersion: number;
    registryVersion: number | null;
    entries: number;
    generatedAt: string;
    /** The latest `verified_on` of any entry: how fresh the registry's checks are. */
    newestCheck: IsoDate | null;
  };
  today: IsoDate;
  stats: ScanStats;
}
