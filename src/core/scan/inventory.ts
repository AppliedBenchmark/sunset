// The inventory: model-like strings in literals that aren't in the registry,
// found with per-family patterns. Reported in the JSON only; never annotated, never failing.
import { contextOf } from '../registry/formats.ts';
import type { PlatformFormats } from '../types.ts';

const FAMILIES = [
  `gpt-[0-9][A-Za-z0-9.-]*`,
  `chatgpt-[A-Za-z0-9.-]+`,
  `o[1-9](?:-(?:mini|pro|preview|deep-research))*(?:-[0-9]{4}-[0-9]{2}-[0-9]{2})?`,
  // sunset-ignore-next-line reason="regex alternatives, not model IDs"
  `text-(?:embedding|davinci|curie|babbage|ada|moderation)-[A-Za-z0-9-]+`,
  // sunset-ignore-next-line reason="regex alternatives, not model IDs"
  `(?:dall-e-[0-9]|whisper-1|tts-1(?:-hd)?)`,
  `claude-[A-Za-z0-9.-]+(?:@[0-9]{8})?`,
  `(?:gemini|gemma|imagen|veo)-[A-Za-z0-9.-]+(?:@[0-9]{3})?`,
  `(?:open-)?(?:mistral|mixtral|codestral|ministral|pixtral|magistral|devstral|voxtral)-[A-Za-z0-9.-]+`,
  `deepseek-[A-Za-z0-9.-]+`,
  // Bedrock base model IDs, optionally geo-prefixed. The model part starts in lower case and has a
  // digit or a `-`, which hostnames (`api.openai.com`), class names (`anthropic.Anthropic`) and
  // module paths (`openai.types.chat`) don't.
  String.raw`(?:[a-z-]{2,7}\.)?(?:anthropic|amazon|meta|cohere|ai21|mistral|deepseek|openai|qwen|writer)\.(?=[a-z0-9.:]*[0-9-])[a-z0-9][A-Za-z0-9.:-]*`,
];

const INVENTORY = new RegExp(
  String.raw`(?<![\p{L}\p{M}\p{N}_.\-@])(?:${FAMILIES.join('|')})(?![\p{L}\p{M}\p{N}_\-@])`,
  'gu',
);

const FILE_EXTENSION = /\.(?:json|ya?ml|toml|txt|md|csv|jsonl|py|ts|js|log|png|jpg)$/i;
const HOSTNAME = /\.(?:com|net|org|io|ai|dev|cloud|app)$/;

const VENDOR_BEFORE = /(?:^|[^A-Za-z0-9_./-])([a-z0-9-]+)\/$/;

/** Model-like strings in `text[start, end)`. OpenRouter-style slugs keep their vendor prefix. */
// Not global: `test` on the global INVENTORY would leave `lastIndex` set for the next `matchAll`.
const ANY_MODEL_LIKE = new RegExp(INVENTORY.source, 'u');

/** True when the text may hold a model-like string, so the file is worth lexing. */
export function hasModelLike(text: string): boolean {
  return ANY_MODEL_LIKE.test(text);
}

export function findModelLike(
  text: string,
  start: number,
  end: number,
  formats: PlatformFormats,
): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  const slice = text.slice(start, end);
  for (const m of slice.matchAll(INVENTORY)) {
    let s = start + m.index;
    let e = s + m[0].length;
    // A sentence may end after an ID; a `-` or `:` at the end makes a prefix (`gpt-4-`), not an ID.
    while (e > s && text[e - 1] === '.') e--;
    if (text[e - 1] === '-' || text[e - 1] === ':') continue;
    // A file name such as `gemini-pro.json` names a file, not a model; nor does a host name.
    if (FILE_EXTENSION.test(text.slice(s, e)) || HOSTNAME.test(text.slice(s, e))) continue;
    // Nor does a segment of a path or a URL, or a name after another provider's prefix.
    if (!contextOf(text, s, e, [], formats)) continue;
    if (text[s - 1] === '/') {
      const vendor = VENDOR_BEFORE.exec(text.slice(Math.max(start, s - 64), s));
      if (vendor && Object.hasOwn(formats.openrouter.vendors, vendor[1] as string)) {
        s -= (vendor[1] as string).length + 1;
      }
    }
    out.push({ start: s, end: e, text: text.slice(s, e) });
  }
  return out;
}
