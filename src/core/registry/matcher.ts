// The combined-regex matcher: one regex over every expanded registry form,
// longest alternative first, with the boundary rules below.
import { escapeRegExp } from '../escape-regexp.ts';
import type { ExpandedForm, Matcher, MatchHit } from '../ports.ts';
import type { PlatformFormats, Registry, RegistryEntry } from '../types.ts';
import { azureIndex, expandForms } from './formats.ts';

/**
 * Boundary rules, defined once. A form matches only if:
 *
 * | Side  | Rejected next to the form           | Why                                               |
 * |-------|-------------------------------------|---------------------------------------------------|
 * | left  | a letter, a digit, `_`, `.` or `-`  | inside a longer ID or a word (`xgpt-…`, `a.b`, `Kınalıada`) |
 * | right | a letter, a digit, `_` or `-`       | inside a longer ID (`gpt-4o` in `gpt-4o-mini`)     |
 * | right | `.` or `@` followed by a letter or digit | a longer dotted or Vertex `@` ID (`gemini-1.5` in `gemini-1.5.1`) |
 * | right | `:` followed by `[0-9]`             | a longer Bedrock ID (`…-v2` in `…-v2:1`)           |
 *
 * A letter or a digit is one in any script, with its combining marks (`\p{L}`, `\p{M}`, `\p{N}`):
 * an ID next to `ı`, `é` or `ß` is part of a word, as it is next to `i`, `e` or `s`. The patterns
 * therefore need the `u` flag.
 *
 * Everything else is a boundary, including `/` on the left (so resource paths, ARNs and
 * OpenRouter slugs match; their context is classified afterwards) and `:` on the left
 * (`openai:gpt-…` in LangChain-style strings). One `-` on the left is a boundary too: the one in
 * a shell default, `${MODEL:-gpt-…}` (also `${MODEL-…}`, `${MODEL:=…}` and `${MODEL=…}`).
 *
 * One exception to the `@` rule: Google lists Vertex Claude models before 4.6 without their
 * version (`claude-3-haiku`), but code calls them as `claude-3-haiku@20240307`; likewise the PaLM
 * models (`text-bison`, called as `text-bison@002`). A form followed by `@YYYYMMDD` or `@NNN`
 * therefore matches as a whole, and resolves only to Vertex entries whose ID has no `@` (see
 * `vertexVersioned`); for any other entry it stays unmatched.
 */
export const LEFT_BOUNDARY =
  '(?:(?<![\\p{L}\\p{M}\\p{N}_.\\-])|(?<=\\$\\{[A-Za-z_][A-Za-z0-9_]*:?[-=]))';
export const RIGHT_BOUNDARY = '(?![\\p{L}\\p{M}\\p{N}_\\-]|[.@][\\p{L}\\p{M}\\p{N}]|:[0-9])';
/** An optional Vertex version after a form: `@YYYYMMDD` (Claude) or `@NNN` (PaLM). */
const VERTEX_VERSION = '(?:@(?:\\d{8}|\\d{3}))?';
const VERSIONED = /^(.*)@(?:\d{8}|\d{3})$/;

/**
 * The entries a `<form>@YYYYMMDD` match can mean: Vertex entries whose ID is the form, without a
 * version of their own.
 */
function vertexVersioned(
  forms: ReadonlyMap<string, readonly ExpandedForm[]>,
  base: string,
): readonly ExpandedForm[] {
  return (forms.get(base) ?? []).filter(
    (f) => f.entry.platform === 'vertex' && f.geo === null && !base.includes('@'),
  );
}

/** Words that make a file worth lexing even without a registry hit (dynamic and Azure detectors). */
const KEYWORDS = /model|deployment|engine|inference-profile/i;

export function createMatcher(registry: Registry, formats: PlatformFormats): Matcher {
  const forms = expandForms(registry, formats);
  const azure = azureIndex(registry);
  const alternatives = [...forms.keys()]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
    .map(escapeRegExp);
  const source = alternatives.length > 0 ? alternatives.join('|') : '(?!)';
  const regex = new RegExp(`${LEFT_BOUNDARY}(?:${source})${VERTEX_VERSION}${RIGHT_BOUNDARY}`, 'gu');
  const noForms: readonly ExpandedForm[] = [];
  const lookup = (form: string): readonly ExpandedForm[] => {
    const exact = forms.get(form);
    if (exact) return exact;
    const versioned = VERSIONED.exec(form);
    return versioned ? vertexVersioned(forms, versioned[1] as string) : noForms;
  };

  let cachedText: string | null = null;
  let cachedHits: MatchHit[] = [];

  const find = (text: string): readonly MatchHit[] => {
    if (text === cachedText) return cachedHits;
    const hits: MatchHit[] = [];
    regex.lastIndex = 0;
    for (let m = regex.exec(text); m !== null; m = regex.exec(text)) {
      // A versioned form that resolves to nothing was a `@` boundary violation all along.
      if (lookup(m[0]).length === 0) continue;
      hits.push({ start: m.index, end: m.index + m[0].length, form: m[0] });
    }
    cachedText = text;
    cachedHits = hits;
    return hits;
  };

  const none: readonly RegistryEntry[] = [];

  return {
    size: forms.size,
    formats,
    prefilter: (text) => KEYWORDS.test(text) || find(text).length > 0,
    find,
    lookup,
    azure: (name) => azure.get(name) ?? none,
  };
}
