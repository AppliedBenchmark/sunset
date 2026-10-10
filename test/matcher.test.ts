import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { contextOf, expandForms, platformsFor } from '../src/core/registry/formats.ts';
import { createMatcher } from '../src/core/registry/matcher.ts';
import type { Registry, RegistryEntry, Router } from '../src/core/types.ts';
import { brief, fixtureRegistry, formats } from './helpers.ts';

const matcher = createMatcher(fixtureRegistry, formats);
const found = (text: string): string[] => matcher.find(text).map((h) => h.form);

describe('boundary rules', () => {
  it.each<[string, string[]]>([
    // Exact IDs in ordinary literals.
    ['"gpt-fixture-3"', ['gpt-fixture-3']],
    ["'gpt-fixture-3'", ['gpt-fixture-3']],
    ['model=gpt-fixture-3', ['gpt-fixture-3']],
    ['openai:gpt-fixture-3', ['gpt-fixture-3']],
    ['(gpt-fixture-3,gpt-fixture-retired)', ['gpt-fixture-3', 'gpt-fixture-retired']],
    // Never inside a longer ID or an identifier.
    ['"gpt-fixture-3-mini"', ['gpt-fixture-3-mini']],
    ['"gpt-fixture-3-nano"', []],
    ['"xgpt-fixture-3"', []],
    ['"my_gpt-fixture-3"', []],
    ['"gpt-fixture-3_backup"', []],
    ['"v.gpt-fixture-3"', []],
    ['"gpt-fixture-30"', []],
    // A letter or a digit in any script is part of the word: Turkish `ı`, accents, CJK, a
    // combining mark. Punctuation and spaces in any script are boundaries.
    ['"Kınalıgpt-fixture-3"', []],
    ['"égpt-fixture-3"', []],
    ['"e\u0301gpt-fixture-3"', []],
    ['"gpt-fixture-3ß"', []],
    ['"gpt-fixture-3.é"', []],
    ['"中gpt-fixture-3"', []],
    ['"٣gpt-fixture-3"', []],
    ['"ü gpt-fixture-3"', ['gpt-fixture-3']],
    ['「gpt-fixture-3」', ['gpt-fixture-3']],
    ['«gpt-fixture-3»', ['gpt-fixture-3']],
    ['“gpt-fixture-3”', ['gpt-fixture-3']],
    ['gpt-fixture-3。', ['gpt-fixture-3']],
    // `.` + alphanumeric on the right is a longer dotted ID; a full stop is not.
    ['"gemini-fixture-1.0-flash.1"', []],
    ['Use gemini-fixture-1.0-flash.', ['gemini-fixture-1.0-flash']],
    // `@` + alphanumeric on the right is a Vertex version; `:` + digit a Bedrock version. A
    // Vertex ID listed without a version also matches with an `@YYYYMMDD` one.
    ['"claude-fixture-opus-9@20990101"', ['claude-fixture-opus-9@20990101']],
    ['"claude-fixture-opus-9@2099"', []],
    ['"claude-fixture-opus-9@20990101x"', []],
    ['"gpt-fixture-3@20990101"', []],
    ['"claude-fixture-1@20990101"', ['claude-fixture-1@20990101']],
    ['"claude-fixture-1@20990101@20990102"', []],
    // `@NNN` as on PaLM models (`text-bison@002`), also only for a Vertex ID.
    ['"claude-fixture-opus-9@002"', ['claude-fixture-opus-9@002']],
    ['"claude-fixture-opus-9@0002"', []],
    ['"gpt-fixture-3@002"', []],
    ['"anthropic.claude-fixture-v2:1"', ['anthropic.claude-fixture-v2:1']],
    ['"anthropic.claude-fixture-v2:9"', []],
    ['"anthropic.claude-fixture-v2"', ['anthropic.claude-fixture-v2']],
    ['"gpt-fixture-3:free"', ['gpt-fixture-3']],
    // A shell default is a value of its own.
    ['MODEL: ${MODEL:-gpt-fixture-3}', ['gpt-fixture-3']],
    [
      '${MODEL-gpt-fixture-3} ${MODEL:=gpt-fixture-retired} ${M=gpt-fixture-3}',
      ['gpt-fixture-3', 'gpt-fixture-retired', 'gpt-fixture-3'],
    ],
    ['$MODEL:-gpt-fixture-3 x-gpt-fixture-3', []],
    // `/` is a left boundary: paths, ARNs and slugs match and their context is classified later.
    ['"openai/gpt-fixture-3"', ['gpt-fixture-3']],
    ['publishers/anthropic/models/claude-fixture-1@20990101', ['claude-fixture-1@20990101']],
    // Bedrock geo prefixes, longest first.
    ['"us.anthropic.claude-fixture-opus-9"', ['us.anthropic.claude-fixture-opus-9']],
    ['"us-gov.anthropic.claude-fixture-opus-9"', ['us-gov.anthropic.claude-fixture-opus-9']],
    ['"ca.anthropic.claude-fixture-opus-9"', []],
    ['"deepseek.fixture-v3.2"', ['deepseek.fixture-v3.2']],
    // Azure model names are only matched by the Azure detector.
    ['"gpt-fixture-4o"', ['gpt-fixture-4o']],
  ])('%s → %j', (text, expected) => {
    expect(found(text)).toEqual(expected);
  });

  it('never matches inside a longer ID (property)', () => {
    const ids = [...expandForms(fixtureRegistry, formats).keys()];
    const tail = fc.stringMatching(/^[A-Za-z0-9_-]{1,4}$/);
    fc.assert(
      fc.property(fc.constantFrom(...ids), tail, fc.constantFrom('"', ' ', '='), (id, extra, q) => {
        const text = `${q}${id}${extra}${q}`;
        // Whatever matches must be a whole registry form, never `id` cut out of `id+extra`.
        for (const hit of matcher.find(text)) {
          expect(text.slice(hit.end, hit.end + 1)).not.toMatch(/[A-Za-z0-9_-]/);
          expect(hit.form).not.toBe(id);
        }
      }),
    );
  });

  it('prefilters on registry hits and on dynamic keywords', () => {
    expect(matcher.prefilter('nothing here')).toBe(false);
    expect(matcher.prefilter('x = "gpt-fixture-3"')).toBe(true);
    expect(matcher.prefilter('const MODEL = env.X')).toBe(true);
    expect(matcher.prefilter('az cognitiveservices account deployment create')).toBe(true);
  });

  it('works with an empty registry', () => {
    const empty = createMatcher({ ...fixtureRegistry, models: [] }, formats);
    expect(empty.size).toBe(0);
    expect(empty.find('"gpt-fixture-3"')).toEqual([]);
  });
});

describe('expansion and contexts', () => {
  it('expands Bedrock entries with every geo prefix and leaves Azure out', () => {
    const forms = expandForms(fixtureRegistry, formats);
    for (const geo of formats.bedrock.geo_prefixes) {
      expect(forms.get(`${geo}.anthropic.claude-fixture-opus-9`)?.[0]?.geo).toBe(geo);
    }
    // gpt-fixture-4o is only the OpenAI entry; the two Azure versions are matched separately.
    expect(forms.get('gpt-fixture-4o')?.map((f) => f.entry.platform)).toEqual(['openai']);
    expect(matcher.azure('gpt-fixture-4o').map((e) => e.version)).toEqual([
      '2099-01-05',
      '2099-08-06',
    ]);
    expect(forms.get('gpt-fixture-3-0301')?.[0]?.entry.model_id).toBe('gpt-fixture-3');
  });

  const ctx = (text: string, form: string) => {
    const start = text.indexOf(form);
    return contextOf(text, start, start + form.length, matcher.lookup(form), formats);
  };

  it.each<[string, string, unknown]>([
    ['"gpt-fixture-3"', 'gpt-fixture-3', { kind: 'literal' }],
    [
      '"us.anthropic.claude-fixture-opus-9"',
      'us.anthropic.claude-fixture-opus-9',
      { kind: 'bedrock-profile', geo: 'us' },
    ],
    // Resource paths.
    [
      'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-fixture-opus-9',
      'anthropic.claude-fixture-opus-9',
      { kind: 'bedrock-arn', resource: 'foundation-model', geo: null },
    ],
    [
      'arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:inference-profile/us-gov.anthropic.claude-fixture-opus-9',
      'us-gov.anthropic.claude-fixture-opus-9',
      { kind: 'bedrock-arn', resource: 'inference-profile', geo: 'us-gov' },
    ],
    [
      'arn:aws-eusc:bedrock:eusc-de-east-1::foundation-model/anthropic.claude-fixture-opus-9',
      'anthropic.claude-fixture-opus-9',
      { kind: 'bedrock-arn', resource: 'foundation-model', geo: null },
    ],
    [
      'arn:aws-cn:bedrock:cn-north-1::foundation-model/anthropic.claude-fixture-opus-9',
      'anthropic.claude-fixture-opus-9',
      null,
    ],
    [
      'arn:aws:bedrock:us-east-1::foundation-model/us.anthropic.claude-fixture-opus-9',
      'us.anthropic.claude-fixture-opus-9',
      null,
    ],
    [
      'arn:aws:bedrock:us-east-1:1:inference-profile/anthropic.claude-fixture-opus-9',
      'anthropic.claude-fixture-opus-9',
      null,
    ],
    [
      "f'arn:aws:bedrock:{region}::foundation-model/anthropic.claude-fixture-opus-9'",
      'anthropic.claude-fixture-opus-9',
      { kind: 'bedrock-arn', resource: 'foundation-model', geo: null },
    ],
    [
      '!Sub arn:${AWS::Partition}:bedrock:${AWS::Region}:${AWS::AccountId}:inference-profile/us.anthropic.claude-fixture-opus-9',
      'us.anthropic.claude-fixture-opus-9',
      { kind: 'bedrock-arn', resource: 'inference-profile', geo: 'us' },
    ],
    [
      '"arn:aws:bedrock:" + region + "::foundation-model/anthropic.claude-fixture-opus-9"',
      'anthropic.claude-fixture-opus-9',
      { kind: 'bedrock-arn', resource: 'foundation-model', geo: null },
    ],
    [
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-fixture-opus-9/invoke',
      'anthropic.claude-fixture-opus-9',
      { kind: 'literal' },
    ],
    ['f"{provider}/gpt-fixture-3"', 'gpt-fixture-3', { kind: 'literal' }],
    [
      'projects/p/locations/us-east5/publishers/anthropic/models/claude-fixture-opus-9',
      'claude-fixture-opus-9',
      { kind: 'vertex-path', publisher: 'anthropic' },
    ],
    [
      'publishers/google/models/gemini-fixture-1.0-flash',
      'gemini-fixture-1.0-flash',
      { kind: 'vertex-path', publisher: 'google' },
    ],
    ['"models/gemini-fixture-1.0-flash"', 'gemini-fixture-1.0-flash', { kind: 'literal' }],
    [
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-fixture-1.0-flash:generateContent',
      'gemini-fixture-1.0-flash',
      { kind: 'literal' },
    ],
    // OpenRouter slugs, after `openrouter/`. Without it, `<vendor>/` is LiteLLM's prefix, and so
    // is a vendor whose platform doesn't have the ID.
    [
      '"openrouter/openai/gpt-fixture-3"',
      'gpt-fixture-3',
      { kind: 'openrouter', vendor: 'openai' },
    ],
    [
      '"openrouter:openai/gpt-fixture-3"',
      'gpt-fixture-3',
      { kind: 'openrouter', vendor: 'openai' },
    ],
    [
      '"litellm/openrouter/anthropic/claude-fixture-opus-9"',
      'claude-fixture-opus-9',
      { kind: 'openrouter', vendor: 'anthropic' },
    ],
    // LiteLLM's route through the Vercel AI Gateway, whose `google/` covers both Gemini platforms.
    [
      '"vercel_ai_gateway/google/gemini-fixture-1.0-flash"',
      'gemini-fixture-1.0-flash',
      { kind: 'vercel-ai-gateway', vendor: 'google' },
    ],
    [
      '"vercel_ai_gateway/mistralai/mistral-fixture-large-2099"',
      'mistral-fixture-large-2099',
      { kind: 'prefix', prefix: 'mistralai/' },
    ],
    ['"openai/gpt-fixture-3"', 'gpt-fixture-3', { kind: 'prefix', prefix: 'openai/' }],
    [
      '"deepseek/deepseek-fixture-chat"',
      'deepseek-fixture-chat',
      { kind: 'prefix', prefix: 'deepseek/' },
    ],
    [
      '"anthropic/claude-fixture-1@20990101"',
      'claude-fixture-1@20990101',
      { kind: 'prefix', prefix: 'anthropic/' },
    ],
    ['"meta/claude-fixture-1@20990101"', 'claude-fixture-1@20990101', null],
    ['"snowflake/claude-fixture-opus-9"', 'claude-fixture-opus-9', null],
    // Libraries' prefixes, with route segments and pass-through prefixes.
    [
      '"gemini/gemini-fixture-1.0-flash"',
      'gemini-fixture-1.0-flash',
      { kind: 'prefix', prefix: 'gemini/' },
    ],
    [
      '"litellm_proxy/gemini/gemini-fixture-1.0-flash"',
      'gemini-fixture-1.0-flash',
      { kind: 'prefix', prefix: 'gemini/' },
    ],
    // The OpenAI Agents SDK's route to LiteLLM, and Pydantic AI's `litellm:`.
    [
      '"litellm/anthropic/claude-fixture-opus-9"',
      'claude-fixture-opus-9',
      { kind: 'prefix', prefix: 'anthropic/' },
    ],
    ['"litellm:gpt-fixture-3"', 'gpt-fixture-3', { kind: 'literal' }],
    // Pydantic AI's providers, and LiteLLM's Codestral and older Vertex routes.
    [
      '"google-gla:gemini-fixture-1.0-flash"',
      'gemini-fixture-1.0-flash',
      { kind: 'prefix', prefix: 'google-gla:' },
    ],
    [
      '"google-vertex:gemini-fixture-1.0-flash"',
      'gemini-fixture-1.0-flash',
      { kind: 'prefix', prefix: 'google-vertex:' },
    ],
    [
      '"google-cloud:gemini-fixture-1.0-flash"',
      'gemini-fixture-1.0-flash',
      { kind: 'prefix', prefix: 'google-cloud:' },
    ],
    ['"openai-chat:gpt-fixture-3"', 'gpt-fixture-3', { kind: 'prefix', prefix: 'openai-chat:' }],
    [
      '"openai-responses:gpt-fixture-3"',
      'gpt-fixture-3',
      { kind: 'prefix', prefix: 'openai-responses:' },
    ],
    [
      '"codestral/mistral-fixture-large-2099"',
      'mistral-fixture-large-2099',
      { kind: 'prefix', prefix: 'codestral/' },
    ],
    [
      '"vertex_ai_beta/gemini-fixture-1.0-flash"',
      'gemini-fixture-1.0-flash',
      { kind: 'prefix', prefix: 'vertex_ai_beta/' },
    ],
    // aisuite's Bedrock provider.
    [
      '"aws:anthropic.claude-fixture-opus-9"',
      'anthropic.claude-fixture-opus-9',
      { kind: 'prefix', prefix: 'aws:' },
    ],
    [
      '"aws:us.anthropic.claude-fixture-opus-9"',
      'us.anthropic.claude-fixture-opus-9',
      { kind: 'bedrock-profile', geo: 'us' },
    ],
    [
      '"vertex_ai/claude-fixture-opus-9"',
      'claude-fixture-opus-9',
      { kind: 'prefix', prefix: 'vertex_ai/' },
    ],
    [
      '"bedrock/converse/anthropic.claude-fixture-v2"',
      'anthropic.claude-fixture-v2',
      { kind: 'prefix', prefix: 'bedrock/' },
    ],
    [
      '"bedrock/us.anthropic.claude-fixture-opus-9"',
      'us.anthropic.claude-fixture-opus-9',
      { kind: 'bedrock-profile', geo: 'us' },
    ],
    [
      '"anthropic:claude-fixture-opus-9"',
      'claude-fixture-opus-9',
      { kind: 'prefix', prefix: 'anthropic:' },
    ],
    [
      '"anthropic:messages:claude-fixture-opus-9"',
      'claude-fixture-opus-9',
      { kind: 'prefix', prefix: 'anthropic:' },
    ],
    ['"ft:gpt-fixture-3:my-org::abc123"', 'gpt-fixture-3', { kind: 'prefix', prefix: 'ft:' }],
    // Azure deployment names are the Azure detector's.
    ['"azure/gpt-fixture-3"', 'gpt-fixture-3', null],
    ['"azure:chat:gpt-fixture-3"', 'gpt-fixture-3', null],
    [
      'https://r.openai.azure.com/openai/deployments/gpt-fixture-3/chat/completions',
      'gpt-fixture-3',
      null,
    ],
    // Paths, URLs and unknown prefixes.
    ['"https://example.com/openai/gpt-fixture-3"', 'gpt-fixture-3', null],
    ['"unknown/gpt-fixture-3"', 'gpt-fixture-3', null],
    ['"examples/gpt-fixture-3/run.py"', 'gpt-fixture-3', null],
    ['"/docs/guides/gpt-fixture-3"', 'gpt-fixture-3', null],
    ['"gpt-fixture-3/run.py"', 'gpt-fixture-3', null],
    ['"cache:gpt-fixture-3"', 'gpt-fixture-3', null],
    ['"team-1:gpt-fixture-3"', 'gpt-fixture-3', null],
    // A placeholder's default: the key before it isn't a prefix, but a prefix in the default is.
    [
      '"${spring.ai.openai.chat.options.model:gpt-fixture-3}"',
      'gpt-fixture-3',
      { kind: 'literal' },
    ],
    ['"${app.fallback-model:gpt-fixture-3}"', 'gpt-fixture-3', { kind: 'literal' }],
    ['model=${OPENAI_MODEL:gpt-fixture-3}', 'gpt-fixture-3', { kind: 'literal' }],
    ['"\\${OPENAI_MODEL:gpt-fixture-3}"', 'gpt-fixture-3', { kind: 'literal' }],
    [
      'MODEL=${MODEL:-gemini/gemini-fixture-1.0-flash}',
      'gemini-fixture-1.0-flash',
      { kind: 'prefix', prefix: 'gemini/' },
    ],
    [
      'MODEL=${MODEL-gemini/gemini-fixture-1.0-flash}',
      'gemini-fixture-1.0-flash',
      { kind: 'prefix', prefix: 'gemini/' },
    ],
    [
      '"${LLM:anthropic:claude-fixture-opus-9}"',
      'claude-fixture-opus-9',
      { kind: 'prefix', prefix: 'anthropic:' },
    ],
    ['"${MODEL:-snowflake/claude-fixture-opus-9}"', 'claude-fixture-opus-9', null],
    ['"{MODEL:gpt-fixture-3}"', 'gpt-fixture-3', null],
    // A glob, as in LiteLLM's wildcard routes; emphasis isn't one.
    ['"openai/gpt-fixture-3*"', 'gpt-fixture-3', null],
    ['"gpt-fixture-3*"', 'gpt-fixture-3', null],
    ['Use *gpt-fixture-3* here.', 'gpt-fixture-3', { kind: 'literal' }],
    ['Use **gpt-fixture-3** here.', 'gpt-fixture-3', { kind: 'literal' }],
  ])('%s', (text, form, expected) => {
    expect(ctx(text, form)).toEqual(expected);
  });

  it('reads `<vendor>/<id>` as the slug of the router a file goes through', () => {
    const at = (text: string, form: string, router: Router | null) => {
      const start = text.indexOf(form);
      const forms = matcher.lookup(form);
      return contextOf(text, start, start + form.length, forms, formats, () => router);
    };
    const opus = '"anthropic/claude-fixture-opus-9"';
    expect(at(opus, 'claude-fixture-opus-9', 'openrouter')).toEqual({
      kind: 'openrouter',
      vendor: 'anthropic',
    });
    expect(at(opus, 'claude-fixture-opus-9', 'vercel-ai-gateway')).toEqual({
      kind: 'vercel-ai-gateway',
      vendor: 'anthropic',
    });
    expect(at(opus, 'claude-fixture-opus-9', null)).toEqual({
      kind: 'prefix',
      prefix: 'anthropic/',
    });
    // The Gateway names Mistral `mistral/`, OpenRouter `mistralai/`.
    const large = 'mistral-fixture-large-2099';
    expect(at(`"mistral/${large}"`, large, 'vercel-ai-gateway')).toEqual({
      kind: 'vercel-ai-gateway',
      vendor: 'mistral',
    });
    expect(at(`"mistral/${large}"`, large, 'openrouter')).toEqual({
      kind: 'prefix',
      prefix: 'mistral/',
    });
  });

  it("reads `<publisher>/<model>-maas` as Vertex's name for an open model", () => {
    const retired = fixtureRegistry.models[0] as RegistryEntry;
    const maas: RegistryEntry = {
      ...retired,
      id: 'vertex:llama-fixture-maas',
      platform: 'vertex',
      model_id: 'llama-fixture-maas',
    };
    const withMaas = createMatcher(
      { ...fixtureRegistry, models: [...fixtureRegistry.models, maas] },
      formats,
    );
    for (const text of ['"meta/llama-fixture-maas"', '"openai/llama-fixture-maas"']) {
      const start = text.indexOf('llama');
      const forms = withMaas.lookup('llama-fixture-maas');
      expect(contextOf(text, start, start + 18, forms, formats)).toEqual({
        kind: 'vertex-path',
        publisher: text.slice(1, start - 1),
      });
    }
  });

  it('narrows platforms by context', () => {
    expect(platformsFor({ kind: 'literal' }, formats)).toBeNull();
    expect(platformsFor({ kind: 'vertex-path', publisher: 'google' }, formats)).toEqual(['vertex']);
    expect(platformsFor({ kind: 'openrouter', vendor: 'google' }, formats)).toEqual([
      'gemini-api',
      'vertex',
    ]);
    expect(platformsFor({ kind: 'vercel-ai-gateway', vendor: 'google' }, formats)).toEqual([
      'gemini-api',
      'vertex',
    ]);
    const { vercel_ai_gateway: _, ...withoutGateway } = formats;
    expect(platformsFor({ kind: 'vercel-ai-gateway', vendor: 'google' }, withoutGateway)).toEqual(
      [],
    );
    expect(platformsFor({ kind: 'prefix', prefix: 'google_genai:' }, formats)).toEqual([
      'gemini-api',
      'vertex',
    ]);
    // promptfoo's `google:` is the Gemini API, aisuite's Vertex AI.
    expect(platformsFor({ kind: 'prefix', prefix: 'google:' }, formats)).toEqual([
      'gemini-api',
      'vertex',
    ]);
    expect(platformsFor({ kind: 'azure-deployment', source: 'cli' }, formats)).toEqual([
      'azure-openai',
    ]);
  });

  it('keeps one form per entry even if an alias repeats the model ID', () => {
    const base = fixtureRegistry.models[0] as RegistryEntry;
    const registry: Registry = {
      ...fixtureRegistry,
      models: [{ ...base, aliases: [base.model_id] }],
    };
    expect(expandForms(registry, formats).get(base.model_id)).toHaveLength(1);
  });
});

describe('Vertex versions on unversioned IDs', () => {
  it('resolve to the Vertex entry only', () => {
    const forms = matcher.lookup('claude-fixture-opus-9@20990101');
    expect(forms.map((f) => f.entry.id)).toEqual(['vertex:claude-fixture-opus-9']);
    expect(
      matcher
        .lookup('claude-fixture-opus-9')
        .map((f) => f.entry.platform)
        .sort(),
    ).toEqual(['anthropic', 'vertex']);
  });

  it('report the Vertex dates in a scan', async () => {
    const { findings } = await brief('main.py', 'MODEL = "claude-fixture-opus-9@20990101"\n');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/ 1:10 claude-fixture-opus-9@20990101$/);
  });
});
