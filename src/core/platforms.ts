// Which platforms a repository uses, inferred from its dependency manifests (npm, PyPI, Go). It
// only settles IDs that several platforms serve with different dates (`gemini-3.6-flash` on the
// Gemini API and on Vertex): when the code doesn't say which platform it calls, the platform its
// SDKs point to decides. It never hides an ID; `platforms` in the config overrides it.
//
// In pyproject.toml, only what declares dependencies is read: `[project]`'s `dependencies` and
// `optional-dependencies` (the pyproject.toml specification), `[dependency-groups]` (PEP 735) and
// Poetry's dependency tables. Its keywords, classifiers and URLs can name a package too.
//
// Only packages that name their platforms count. `boto3` (all of AWS) and the generic `openai`
// client used with other providers' endpoints are deliberately not evidence for Bedrock or Azure.
// Google's Gen AI SDKs (`@google/genai`, `google-genai`, `google.golang.org/genai`), and
// `langchain-google-genai` 4+ built on them, call the Gemini API or Vertex as configured at run
// time, so they count for both.
import { own } from './own.ts';
import type { Platform } from './types.ts';

export interface Manifest {
  path: string;
  text: string;
}

export interface InferredPlatforms {
  platforms: Platform[];
  /** `package.json: @anthropic-ai/sdk`, one per package that counted. */
  evidence: string[];
}

const GEMINI_OR_VERTEX: readonly Platform[] = ['gemini-api', 'vertex'];

const NPM: Readonly<Record<string, Platform | readonly Platform[]>> = {
  openai: 'openai',
  '@azure/openai': 'azure-openai',
  '@anthropic-ai/sdk': 'anthropic',
  '@anthropic-ai/bedrock-sdk': 'bedrock',
  '@anthropic-ai/vertex-sdk': 'vertex',
  '@google/genai': GEMINI_OR_VERTEX,
  '@google/generative-ai': 'gemini-api',
  '@google-cloud/vertexai': 'vertex',
  '@google-cloud/aiplatform': 'vertex',
  '@aws-sdk/client-bedrock-runtime': 'bedrock',
  '@aws-sdk/client-bedrock': 'bedrock',
  '@mistralai/mistralai': 'mistral',
  '@ai-sdk/openai': 'openai',
  '@ai-sdk/azure': 'azure-openai',
  '@ai-sdk/anthropic': 'anthropic',
  '@ai-sdk/google': 'gemini-api',
  '@ai-sdk/google-vertex': 'vertex',
  '@ai-sdk/amazon-bedrock': 'bedrock',
  '@ai-sdk/mistral': 'mistral',
  '@ai-sdk/deepseek': 'deepseek',
  '@langchain/openai': 'openai',
  '@langchain/anthropic': 'anthropic',
  '@langchain/google-genai': 'gemini-api',
  '@langchain/google-vertexai': 'vertex',
  '@langchain/aws': 'bedrock',
  '@langchain/mistralai': 'mistral',
  '@langchain/deepseek': 'deepseek',
};

/** PyPI names, normalized (PEP 503: lowercase, runs of `-_.` become `-`). */
const PYPI: Readonly<Record<string, Platform | readonly Platform[]>> = {
  openai: 'openai',
  anthropic: 'anthropic',
  'google-genai': GEMINI_OR_VERTEX,
  'google-generativeai': 'gemini-api',
  'google-cloud-aiplatform': 'vertex',
  vertexai: 'vertex',
  mistralai: 'mistral',
  'langchain-openai': 'openai',
  'langchain-anthropic': 'anthropic',
  'langchain-google-genai': GEMINI_OR_VERTEX,
  'langchain-google-vertexai': 'vertex',
  'langchain-aws': 'bedrock',
  'langchain-mistralai': 'mistral',
  'langchain-deepseek': 'deepseek',
};

/** `anthropic[bedrock]`, `anthropic[vertex]`. */
const PYPI_EXTRAS: Readonly<Record<string, Platform>> = { bedrock: 'bedrock', vertex: 'vertex' };

const GO: Readonly<Record<string, Platform | readonly Platform[]>> = {
  'github.com/openai/openai-go': 'openai',
  'github.com/anthropics/anthropic-sdk-go': 'anthropic',
  'google.golang.org/genai': GEMINI_OR_VERTEX,
  'cloud.google.com/go/vertexai': 'vertex',
  'github.com/aws/aws-sdk-go-v2/service/bedrockruntime': 'bedrock',
};

const PYTHON_MANIFEST =
  /(?:^|\/)(?:requirements[^/]*\.(?:txt|in)|pyproject\.toml|Pipfile|setup\.(?:py|cfg))$/;

/** Whether a path is a manifest this module reads. */
export function isManifest(path: string): boolean {
  return /(?:^|\/)(?:package\.json|go\.mod)$/.test(path) || PYTHON_MANIFEST.test(path);
}

const normalizePypi = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-');

function npmPackages(text: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(
    (field) => {
      const deps = (data as Record<string, unknown> | null)?.[field];
      return deps && typeof deps === 'object' ? Object.keys(deps) : [];
    },
  );
}

interface Requirement {
  name: string;
  extras: string[];
}

const requirement = (name: string, extras: readonly string[]): Requirement => ({
  name: normalizePypi(name),
  extras: extras.map((e) => e.trim().toLowerCase()).filter(Boolean),
});

/** Requirement names (with extras) anywhere in a Python manifest: `name`, `name[extra]`. */
function pythonRequirements(text: string): Requirement[] {
  const out: Requirement[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, ''));
  // A requirement starts a line (requirements.txt), or a quoted string (setup.py), or is a TOML
  // key (`openai = "*"` in a Pipfile).
  const pattern =
    /(?:^\s*|["'])([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s*\[([A-Za-z0-9_,\s-]+)\])?(?=\s*(?:[<>=!~;@"'\s,]|$))/g;
  for (const line of lines) {
    for (const m of line.matchAll(pattern)) {
      out.push(requirement(m[1] as string, (m[2] ?? '').split(',')));
    }
  }
  return out;
}

/** The name and extras at the start of a dependency specifier (PEP 508): `anthropic[vertex]>=1`. */
function specifier(text: string): Requirement[] {
  const m = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[([^\]]*)\])?/.exec(text);
  return m ? [requirement(m[1] as string, (m[2] ?? '').split(','))] : [];
}

/** Where a Poetry dependency table's keys, the package names, start in a key path; or -1. */
function poetryNames(path: readonly string[]): number {
  if (path[0] !== 'tool' || path[1] !== 'poetry') return -1;
  // `dependencies`, the legacy `dev-dependencies`, and `group.<name>.dependencies`.
  if (path[2] === 'dependencies' || path[2] === 'dev-dependencies') return 3;
  return path[2] === 'group' && path[4] === 'dependencies' ? 5 : -1;
}

/** The requirements a pyproject.toml declares. */
function pyprojectRequirements(text: string): Requirement[] {
  const out: Requirement[] = [];
  for (const { path, value } of tomlEntries(text)) {
    const [table, key] = path;
    if (table === 'project' && (key === 'dependencies' || key === 'optional-dependencies')) {
      for (const r of tomlStrings(value).flatMap(specifier)) out.push(r);
    } else if (table === 'dependency-groups') {
      // `{include-group = "…"}` names another group, not a package.
      for (const r of tomlStrings(value, { inTables: false }).flatMap(specifier)) out.push(r);
    } else {
      // `openai = "^1"`, `anthropic = { version = "^0.40", extras = ["bedrock"] }`, or a table
      // per package (`[tool.poetry.dependencies.anthropic]`) with its own `extras` key.
      const at = poetryNames(path);
      const name = at < 0 ? undefined : path[at];
      if (name === undefined) continue;
      if (path.length === at + 1) {
        const extras = /(?:^|[{,\s])["']?extras["']?\s*=\s*(\[[^\]]*\])/.exec(value)?.[1];
        out.push(requirement(name, extras ? tomlStrings(extras) : []));
      } else if (path.length === at + 2 && path[at + 1] === 'extras') {
        out.push(requirement(name, tomlStrings(value)));
      } else {
        out.push(requirement(name, []));
      }
    }
  }
  return out;
}

/** A `key = value` of a TOML document: the full key path, its table's included, and the value. */
interface TomlEntry {
  path: string[];
  value: string;
}

/**
 * The entries of a TOML document. Enough of TOML to find dependency declarations: tables, dotted
 * and quoted keys, and values that span lines in brackets, braces or multi-line strings.
 */
/** The deepest table a dependency is declared in: `[tool.poetry.group.<name>.dependencies.<pkg>]`. */
const MAX_TABLE_DEPTH = 6;

function tomlEntries(text: string): TomlEntry[] {
  const out: TomlEntry[] = [];
  let table: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (/\s/.test(c)) {
      i++;
    } else if (c === '#') {
      i = lineEnd(text, i);
    } else if (c === '[') {
      // `[table]` or `[[array of tables]]`.
      const end = scan(text, i, (ch) => ch === ']' || ch === '\n');
      table = keyPath(text.slice(i, end).replace(/^\[+/, ''));
      i = lineEnd(text, end);
    } else {
      const eq = scan(text, i, (ch) => ch === '=' || ch === '\n');
      if (text[eq] !== '=') {
        i = eq;
        continue;
      }
      const end = valueEnd(text, eq + 1);
      // Deeper tables hold no dependencies, and copying their path for every key would take
      // memory in proportion to depth times keys.
      if (table.length <= MAX_TABLE_DEPTH) {
        out.push({
          path: [...table, ...keyPath(text.slice(i, eq))],
          value: text.slice(eq + 1, end),
        });
      }
      i = end;
    }
  }
  return out;
}

const lineEnd = (text: string, i: number): number => {
  const end = text.indexOf('\n', i);
  return end < 0 ? text.length : end;
};

/** The index after the string that starts at `i`: basic or literal, on one line or several. */
function stringEnd(text: string, i: number): number {
  const quote = text[i] as string;
  const triple = text.startsWith(quote.repeat(3), i);
  const close = triple ? quote.repeat(3) : quote;
  for (let j = i + close.length; j < text.length; j++) {
    if (quote === '"' && text[j] === '\\') j++;
    else if (text.startsWith(close, j)) return j + close.length;
    else if (!triple && text[j] === '\n') return j;
  }
  return text.length;
}

/** The index of the first character from `i` that `stop` accepts, outside strings. */
function scan(text: string, i: number, stop: (c: string) => boolean): number {
  let j = i;
  while (j < text.length && !stop(text[j] as string)) {
    j = text[j] === '"' || text[j] === "'" ? stringEnd(text, j) : j + 1;
  }
  return j;
}

/** Where the value that starts at `i` ends: a line end or a comment outside brackets and braces. */
function valueEnd(text: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const c = text[j] as string;
    if (c === '"' || c === "'") j = stringEnd(text, j);
    else if (c === '#') j = lineEnd(text, j);
    else if (c === '\n' && depth <= 0) return j;
    else {
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      j++;
    }
  }
  return j;
}

/** `tool.poetry."my.pkg"` → `tool`, `poetry`, `my.pkg`. */
function keyPath(key: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < key.length) {
    const end = scan(key, i, (c) => c === '.' || c === ']');
    const part = key.slice(i, end).trim();
    parts.push(/^(["']).*\1$/s.test(part) ? part.slice(1, -1) : part);
    if (key[end] !== '.') break;
    i = end + 1;
  }
  return parts;
}

/** The strings in a TOML value, unquoted; with `inTables: false`, not those in inline tables. */
function tomlStrings(value: string, opts: { inTables?: boolean } = {}): string[] {
  const out: string[] = [];
  let tables = 0;
  for (let i = 0; i < value.length; ) {
    const c = value[i] as string;
    if (c === '"' || c === "'") {
      const end = stringEnd(value, i);
      const quote = value.startsWith(c.repeat(3), i) ? 3 : 1;
      if (tables === 0 || opts.inTables !== false) out.push(value.slice(i + quote, end - quote));
      i = end;
    } else if (c === '#') {
      i = lineEnd(value, i);
    } else {
      if (c === '{') tables++;
      else if (c === '}') tables--;
      i++;
    }
  }
  return out;
}

function goModules(text: string): string[] {
  return [...text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+v[0-9]/gm)].map(
    (m) => m[1] as string,
  );
}

export function inferPlatforms(manifests: readonly Manifest[]): InferredPlatforms {
  const platforms = new Set<Platform>();
  const evidence = new Set<string>();
  const found = (manifest: Manifest, pkg: string, platform: Platform | readonly Platform[]) => {
    for (const p of typeof platform === 'string' ? [platform] : platform) platforms.add(p);
    evidence.add(`${manifest.path}: ${pkg}`);
  };

  for (const manifest of [...manifests].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (/(?:^|\/)package\.json$/.test(manifest.path)) {
      for (const pkg of npmPackages(manifest.text)) {
        const platform = own(NPM, pkg);
        if (platform) found(manifest, pkg, platform);
      }
    } else if (/(?:^|\/)go\.mod$/.test(manifest.path)) {
      for (const mod of goModules(manifest.text)) {
        const key = Object.keys(GO).find((m) => mod === m || mod.startsWith(`${m}/`));
        if (key) found(manifest, key, GO[key] as Platform | readonly Platform[]);
      }
    } else if (PYTHON_MANIFEST.test(manifest.path)) {
      const requirements = /(?:^|\/)pyproject\.toml$/.test(manifest.path)
        ? pyprojectRequirements(manifest.text)
        : pythonRequirements(manifest.text);
      for (const { name, extras } of requirements) {
        const platform = own(PYPI, name);
        if (!platform) continue;
        found(manifest, name, platform);
        if (name === 'anthropic') {
          for (const extra of extras) {
            const via = own(PYPI_EXTRAS, extra);
            if (via) found(manifest, `anthropic[${extra}]`, via);
          }
        }
      }
    }
  }
  return { platforms: [...platforms].sort(), evidence: [...evidence] };
}
