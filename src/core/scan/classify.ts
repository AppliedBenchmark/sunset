// File classification: by path and extension, with config overrides. Vendored and generated files
// are skipped; docs are matched for mentions only; tests are reported like
// code but tagged `test`.
import picomatch from 'picomatch';
import { own } from '../own.ts';
import type { ClassifiedFile, FileClass, FileRef, Language } from '../types.ts';

export interface ClassOverride {
  paths: string[];
  class: FileClass;
}

export interface ClassifyOptions {
  /** When set, only files matching one of these globs are scanned. */
  include?: string[];
  exclude?: string[];
  /** Checked in order before the defaults; the first match wins. */
  overrides?: ClassOverride[];
}

export const DEFAULT_PATTERNS: Readonly<
  Record<'vendored' | 'generated' | 'docs' | 'test', string[]>
> = {
  vendored: [
    '**/node_modules/**',
    '**/vendor/**',
    '**/third_party/**',
    '**/dist/**',
    '**/build/**',
    // Framework build output and caches. A Next.js static export (`out/`) has its JavaScript and
    // CSS in `_next/`; the chunks are minified but not named `*.min.*`.
    '**/{.next,_next,.nuxt,.svelte-kit,.output,.turbo,.docusaurus,storybook-static}/**',
    '**/.vercel/output/**',
    '**/.venv/**',
    '**/site-packages/**',
    '**/.terraform/**',
    '**/*.min.*',
    '**/{package-lock.json,npm-shrinkwrap.json,yarn.lock,pnpm-lock.yaml,bun.lock,bun.lockb}',
    '**/{Cargo.lock,poetry.lock,Pipfile.lock,uv.lock,pdm.lock,composer.lock,Gemfile.lock}',
    '**/{go.sum,packages.lock.json,gradle.lockfile,flake.lock,Package.resolved,.terraform.lock.hcl}',
  ],
  generated: [
    '**/*.generated.*',
    '**/*.gen.*',
    '**/*.pb.go',
    '**/*_pb2.py',
    '**/*_pb2_grpc.py',
    '**/*.g.dart',
    '**/*.freezed.dart',
    '**/*.Designer.cs',
  ],
  docs: ['**/*.{md,mdx,rst,txt}', 'docs/**'],
  test: [
    '**/*.{test,spec}.*',
    '**/test_*.py',
    '**/*_test.{py,go}',
    '**/conftest.py',
    '**/*{Test,Tests}.{java,kt,cs}',
    '**/*_spec.rb',
    // Test projects and targets: `UnitTests/`, C#'s `MyLib.Tests/`, Swift's `MyAppTests/`.
    '**/*Tests/**',
  ],
};

/**
 * Directories of tests and test data, matched in any case (`Tests/`, `TestData/`). The globs above
 * are case-sensitive: `*Test.java` in any case would take in `Contest.java`.
 */
const TEST_DIRECTORIES: readonly string[] = [
  '**/{test,tests,__tests__,spec,specs,e2e}/**',
  '**/{testdata,test_data,fixtures,__fixtures__,__mocks__,__snapshots__}/**',
  '**/{unittests,unit_tests,unit-tests,integrationtests,integration_tests,integration-tests}/**',
];

const EXTENSIONS: Readonly<Record<string, Language>> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'javascript',
  mts: 'javascript',
  cts: 'javascript',
  tsx: 'javascript',
  java: 'java',
  // Groovy's strings and comments are Java's, but for `'''` and slashy strings.
  groovy: 'java',
  gradle: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'c',
  cpp: 'c',
  cxx: 'c',
  hpp: 'c',
  hh: 'c',
  hxx: 'c',
  php: 'php',
  scala: 'scala',
  sc: 'scala',
  dart: 'dart',
  bicep: 'bicep',
  bicepparam: 'bicep',
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  env: 'shell',
  envrc: 'shell',
  mk: 'shell',
  dockerfile: 'shell',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  rb: 'ruby',
  rake: 'ruby',
  gemspec: 'ruby',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  properties: 'ini',
  yml: 'yaml',
  yaml: 'yaml',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  // JSON Lines: one JSON value per line, such as OpenAI Batch API input.
  jsonl: 'json',
  ndjson: 'json',
  ipynb: 'notebook',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  vue: 'html',
  svelte: 'html',
  astro: 'html',
  tf: 'hcl',
  tfvars: 'hcl',
  hcl: 'hcl',
  lua: 'lua',
  r: 'r',
};

const BASENAMES: Readonly<Record<string, Language>> = {
  Dockerfile: 'shell',
  Containerfile: 'shell',
  Makefile: 'shell',
  makefile: 'shell',
  GNUmakefile: 'shell',
  Gemfile: 'ruby',
  Jenkinsfile: 'java',
  Rakefile: 'ruby',
  '.editorconfig': 'ini',
};

const CONFIG_LANGUAGES: ReadonlySet<Language> = new Set(['yaml', 'json', 'toml', 'ini', 'hcl']);

/** The lexer language for a path, or null if no lexer handles it. */
export function languageOf(path: string): Language | null {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const byName = own(BASENAMES, base);
  if (byName) return byName;
  // `.env`, `.env.local`, `Dockerfile.dev` and the like.
  if (base === '.env' || base.startsWith('.env.')) return 'shell';
  if (base.startsWith('Dockerfile.') || base.startsWith('Containerfile.')) return 'shell';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 && !base.startsWith('.')) return null;
  return own(EXTENSIONS, base.slice(dot + 1).toLowerCase()) ?? null;
}

type Test = (path: string) => boolean;

const compile = (globs: readonly string[], nocase = false): Test =>
  globs.length === 0 ? () => false : picomatch(globs as string[], { dot: true, nocase });

export interface Classifier {
  /** The file's class and language, or null if include/exclude rule it out. */
  classify(file: FileRef): ClassifiedFile | null;
}

export function createClassifier(opts: ClassifyOptions = {}): Classifier {
  const include = opts.include?.length ? compile(opts.include) : null;
  const exclude = compile(opts.exclude ?? []);
  const overrides = (opts.overrides ?? []).map((o) => ({ test: compile(o.paths), class: o.class }));
  const defaults = [
    ...(['vendored', 'generated', 'docs', 'test'] as const).map((cls) => ({
      test: compile(DEFAULT_PATTERNS[cls]),
      class: cls as FileClass,
    })),
    { test: compile(TEST_DIRECTORIES, true), class: 'test' as FileClass },
  ];

  return {
    classify(file) {
      if ((include && !include(file.path)) || exclude(file.path)) return null;
      const language = languageOf(file.path);
      const matched =
        overrides.find((o) => o.test(file.path)) ?? defaults.find((d) => d.test(file.path));
      let cls: FileClass;
      if (matched) cls = matched.class;
      else if (language && CONFIG_LANGUAGES.has(language)) cls = 'config';
      else cls = 'code';
      // Docs are matched without a lexer, but a notebook's cells still have to be found.
      const lexed = cls !== 'docs' || language === 'notebook';
      return { ...file, class: cls, language: lexed ? language : null };
    },
  };
}

/**
 * A header comment that marks a generated file: Go's convention (https://go.dev/s/generatedcode,
 * here with any comment marker) or Meta's `@generated` tag. Only the start of the file is read.
 */
const GENERATED_HEADER =
  /^[ \t]*(?:\/\/|#|--|;|\/\*+|\*|<!--)[ \t]*(?:Code generated .* DO NOT EDIT\.|.*@generated\b)/m;

export function isGeneratedText(text: string): boolean {
  return GENERATED_HEADER.test(text.slice(0, 2048));
}
