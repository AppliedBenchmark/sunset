// "Did you mean" for model-like strings that aren't in the registry (rule `model-id-unknown`).
// Only a reordering of a known ID's words counts, such as `claude-haiku-3-5` for
// `claude-3-5-haiku`: that is almost certainly a typo. Its numbers must keep their order, since
// `gpt-4-5` is no typo of `gpt-5.4`, and it must have the same shape: a Bedrock ID
// (`anthropic.claude-…`) for a Bedrock ID, a first-party ID for a first-party ID or an OpenRouter
// slug, which keeps its vendor. Anything else stays in the inventory, since a new model may simply
// not be in the registry yet. Dates, `latest` and Bedrock's `-v1:0` are ignored on both sides.
import type { Registry } from '../types.ts';

const NOISE = /\d{4}-\d{2}-\d{2}|@?\d{8}|-v\d+(?::\d+)?$|\blatest\b/g;
const VENDOR = /^([a-z0-9-]+\/)(.+)$/;

function parts(id: string): string[] {
  return id
    .toLowerCase()
    .replace(NOISE, '')
    .split(/[-._@:/]+/)
    .filter(Boolean);
}

/** A Bedrock ID names its provider first, with a dot: `anthropic.claude-…`, `us.amazon.nova-…`. */
function bedrockShaped(id: string): boolean {
  const dot = id.indexOf('.');
  const dash = id.indexOf('-');
  return dot !== -1 && (dash === -1 || dot < dash);
}

/** The key under which reorderings meet: the shape, the sorted words, the numbers in order. */
function keyOf(id: string, p: readonly string[]): string {
  const numbers = p.filter((x) => /^\d+$/.test(x));
  return `${bedrockShaped(id)}\u0000${[...p].sort().join(' ')}\u0000${numbers.join(' ')}`;
}

export type Suggester = (id: string) => string[];

export function createSuggester(registry: Registry): Suggester {
  // Key → the known IDs with those parts, by their part order.
  const index = new Map<string, Map<string, string>>();
  for (const entry of registry.models) {
    for (const id of [entry.model_id, ...entry.aliases]) {
      const p = parts(id);
      if (p.length < 3) continue;
      const key = keyOf(id, p);
      const byOrder = index.get(key) ?? new Map<string, string>();
      const order = p.join(' ');
      // Prefer the shortest spelling, e.g. the undated alias.
      const known = byOrder.get(order);
      if (known === undefined || id.length < known.length) byOrder.set(order, id);
      index.set(key, byOrder);
    }
  }
  return (written) => {
    const [, vendor = '', id = written] = VENDOR.exec(written) ?? [];
    const p = parts(id);
    if (p.length < 3) return [];
    const byOrder = index.get(keyOf(id, p));
    // Same order: a spelling the registry doesn't list (another date, say), not a typo.
    if (!byOrder || byOrder.has(p.join(' '))) return [];
    return [...new Set(byOrder.values())]
      .sort()
      .slice(0, 3)
      .map((known) => vendor + known);
  };
}
