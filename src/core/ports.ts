// Pure interfaces that adapters implement, for the scanner and the updater.
import type { ExtractContext, Extraction, NormalizedPage } from './registry/extract.ts';
import type {
  ClassifiedFile,
  FileRef,
  IsoDate,
  Language,
  PlatformFormats,
  RawFinding,
  Registry,
  RegistryEntry,
  Source,
  Spans,
} from './types.ts';

export interface ListOptions {
  /** Files larger than this are still listed (with their size) but never read. */
  maxFileSize: number;
}

export interface FileSource {
  /** Every candidate file under `root`, honouring `.gitignore`. Paths are POSIX and root-relative. */
  list(root: string, opts: ListOptions): AsyncIterable<FileRef>;
  /** The file's text, or null if it is binary, over the size cap, or gone. */
  read(file: FileRef): Promise<string | null>;
}

export interface LoadedRegistry {
  registry: Registry;
  origin: 'remote' | 'bundled' | 'file';
  version: number | null;
  warnings: string[];
}

export interface RegistrySource {
  load(): Promise<LoadedRegistry>;
}

/** Today's date in UTC; injectable for tests and `--today`. */
export interface Clock {
  today(): IsoDate;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

export interface ChangedFile {
  path: string;
  /** Set for renames, so the base revision is read from the old path. */
  previousPath: string | null;
  status: 'added' | 'modified' | 'renamed';
}

/** Reads another revision of the repository, for the PR delta. */
export interface RevisionReader {
  changedFiles(base: string, head: string): Promise<ChangedFile[]>;
  readAt(rev: string, path: string): Promise<string | null>;
}

export interface UpsertOptions {
  /** Create the comment when there is none yet; otherwise only an existing one is updated. */
  create: boolean;
}

/** The sticky PR comment, found by a hidden marker at the start of its body. */
export interface PrCommentPort {
  upsert(
    marker: string,
    body: string,
    opts: UpsertOptions,
  ): Promise<'created' | 'updated' | 'unchanged' | 'skipped' | 'forbidden'>;
}

// ── Scanner ──────────────────────────────────────────────────────────────────────────────────

/** A registry ID found in text, already checked against the boundary rules. */
export interface MatchHit {
  start: number;
  end: number;
  /** The expanded form that matched (a key for `Matcher.lookup`). */
  form: string;
}

/** What an expanded form stands for. */
export interface ExpandedForm {
  entry: RegistryEntry;
  /** Set when the form carries a Bedrock geo prefix. */
  geo: string | null;
}

/**
 * The registry, compiled for matching. The combined regex sits behind this interface so a
 * trie-compiled regex could replace it without touching the detectors.
 */
export interface Matcher {
  /** Number of expanded forms in the combined regex. */
  readonly size: number;
  /** True when the text may contain something a detector reports, so the file is worth lexing. */
  prefilter(text: string): boolean;
  /** Every registry form in the text that passes the boundary rules, in order. */
  find(text: string): readonly MatchHit[];
  lookup(form: string): readonly ExpandedForm[];
  /** Azure entries by model name; matched only by the Azure deployment detector. */
  azure(name: string): readonly RegistryEntry[];
  readonly formats: PlatformFormats;
}

export interface Lexer {
  readonly languages: readonly Language[];
  lex(text: string): Spans;
}

/** Finds references in one file's text, given its lexed spans. */
export interface Detector {
  readonly id: string;
  detect(file: ClassifiedFile, text: string, spans: Spans, matcher: Matcher): RawFinding[];
}

// ── Updater ────────────────────────────────────────────────────────────────────────

/** A source page, fetched and normalized. */
export interface FetchedPage extends NormalizedPage {
  /** The URLs fetched, after redirects. */
  urls: string[];
  etag: string | null;
  last_modified: string | null;
}

export interface PreviousFetch {
  etag: string | null;
  last_modified: string | null;
}

export interface Fetcher {
  /**
   * Fetches and normalizes a source. With `previous`, the request is conditional, and
   * `'not-modified'` means the page is unchanged since then.
   */
  fetch(source: Source, previous: PreviousFetch | null): Promise<FetchedPage | 'not-modified'>;
}

/**
 * A deterministic parser for one page layout, named by a source's `parser`; never a language model.
 */
export interface Extractor {
  readonly id: string;
  /** Throws LayoutChangedError when the page no longer has the expected structure. */
  extract(page: NormalizedPage, ctx: ExtractContext): Extraction;
}

/** Issues the updater keeps open, one per key, found by a hidden marker in their body. */
export interface IssueTracker {
  upsert(key: string, title: string, body: string): Promise<'created' | 'updated' | 'unchanged'>;
  /** Closes the open issue for `key`, if there is one, with a comment. */
  close(key: string, comment: string): Promise<boolean>;
}
