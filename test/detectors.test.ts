import { describe, expect, it } from 'vitest';
import { fixedClock } from '../src/adapters/clock.ts';
import { unresolvedMessage } from '../src/core/messages.ts';
import { isModelKey } from '../src/core/scan/dynamic-detector.ts';
import type { IsoDate, Registry, RegistryEntry } from '../src/core/types.ts';
import { brief, fixtureRegistry, scanFiles } from './helpers.ts';

/** The test-only registry plus entries made from a retired fixture entry. */
function withEntries(...changes: Partial<RegistryEntry>[]): Registry {
  const retired = fixtureRegistry.models[0] as RegistryEntry;
  const extra = changes.map((c) => ({
    ...retired,
    ...c,
    id: `${c.platform ?? retired.platform}:${c.model_id}`,
  }));
  return { ...fixtureRegistry, models: [...fixtureRegistry.models, ...extra] };
}

describe('literal detector', () => {
  it('reports IDs in strings, never in comments', async () => {
    const { findings } = await brief(
      'a.ts',
      '// gpt-fixture-retired\nconst a = "gpt-fixture-retired"; /* gpt-fixture-3 */',
    );
    expect(findings).toEqual(['model-retired error 2:12 gpt-fixture-retired']);
  });

  it('turns docs matches into mentions', async () => {
    const { findings, mentions } = await brief('docs/guide.md', 'Use `gpt-fixture-retired`.\n');
    expect(findings).toEqual([]);
    expect(mentions).toEqual(['1:6 gpt-fixture-retired']);
  });

  it('skips active models and reports legacy ones only when opted in', async () => {
    const text = 'a = ["gpt-fixture-3-mini", "gpt-fixture-legacy"]';
    expect((await brief('a.py', text)).findings).toEqual([]);
    expect((await brief('a.py', text, { legacy: true })).findings).toEqual([
      'model-legacy notice 1:29 gpt-fixture-legacy',
    ]);
  });

  it('reports the earliest date of an ID shared by several platforms', async () => {
    const { result } = await brief('a.ts', 'x("claude-fixture-opus-9")');
    const [finding] = result.findings;
    expect(finding?.entry?.platform).toBe('anthropic');
    expect(finding?.entries.map((e) => e.platform)).toEqual(['anthropic', 'vertex']);
    expect(finding?.message).toContain('Other dates: vertex: 2099-04-01');
  });

  it('narrows platforms by context', async () => {
    const { result } = await brief(
      'a.ts',
      [
        'x("publishers/anthropic/models/claude-fixture-opus-9")',
        'x("anthropic/claude-fixture-opus-9")',
        // promptfoo's `google:` is the Gemini API, aisuite's Vertex AI.
        'x("google:gemini-fixture-1.0-flash")',
        'x("gemini/gemini-fixture-1.0-flash")',
        'x("aws:anthropic.claude-fixture-opus-9")',
        'x("publishers/google/models/gpt-fixture-3")',
      ].join('\n'),
    );
    expect(result.findings.map((f) => [f.location.line, f.entries.map((e) => e.platform)])).toEqual(
      [
        [1, ['vertex']],
        [2, ['anthropic']],
        [3, ['gemini-api', 'vertex']],
        [4, ['gemini-api']],
        [5, ['bedrock']],
      ],
    );
  });

  it('reports an OpenRouter slug of a retired or soon retired model as a warning', async () => {
    const { result } = await brief(
      'a.py',
      [
        'a = "openai/gpt-fixture-retired"',
        'b = "anthropic/claude-fixture-opus-9"',
        'c = "gpt-fixture-retired"',
        'client = OpenAI(base_url="https://openrouter.ai/api/v1")',
      ].join('\n'),
    );
    expect(result.findings.map((f) => `${f.location.line} ${f.severity} ${f.rule}`)).toEqual([
      '1 warning model-retired',
      '2 warning model-retiring',
      '3 error model-retired',
    ]);
    expect(result.findings[0]?.message).toBe(
      'gpt-fixture-retired (openai; via OpenRouter (openai/)) was retired on 2098-06-30. Recommended replacement: gpt-fixture-4o (openai). OpenRouter may still route this slug to other providers, so this is a warning, not an error.',
    );
    const routed = await brief('a.py', 'm = "openrouter/openai/gpt-fixture-retired"');
    expect(routed.findings).toEqual(['model-retired warning 1:24 gpt-fixture-retired']);
  });

  it.each<[string, string[], string]>([
    // A file that writes `openrouter/<vendor>/` itself calls vendors directly with `<vendor>/`.
    [
      'a.py',
      [
        'os.environ["OPENROUTER_API_KEY"] = key',
        'routed = completion(model="openrouter/openai/gpt-fixture-retired")',
        'direct = completion(model="openai/gpt-fixture-retired")',
      ],
      '2 warning openrouter, 3 error prefix',
    ],
    [
      'a.yaml',
      ['- openrouter:openai/gpt-fixture-retired', '- openai/gpt-fixture-retired'],
      '1 warning openrouter, 2 error prefix',
    ],
    [
      'a.py',
      [
        'gateway = "vercel_ai_gateway/openai/gpt-fixture-retired"',
        'direct = "openai/gpt-fixture-retired"',
      ],
      '1 warning vercel-ai-gateway, 2 error prefix',
    ],
    // The Vercel AI Gateway: the AI SDK sends a `<vendor>/<id>` string to it by default.
    [
      'a.ts',
      [
        "import { generateText } from 'ai';",
        "await generateText({ model: 'openai/gpt-fixture-retired' });",
      ],
      '2 warning vercel-ai-gateway',
    ],
    [
      'a.js',
      ["const { generateText } = require('ai');", "const m = 'openai/gpt-fixture-retired';"],
      '2 warning vercel-ai-gateway',
    ],
    [
      'a.ts',
      ["import { gateway } from '@ai-sdk/gateway';", "gateway('openai/gpt-fixture-retired');"],
      '2 warning vercel-ai-gateway',
    ],
    [
      'a.py',
      [
        'client = OpenAI(base_url="https://ai-gateway.vercel.sh/v1")',
        'm = "openai/gpt-fixture-retired"',
      ],
      '2 warning vercel-ai-gateway',
    ],
    [
      'a.py',
      ['key = os.environ["AI_GATEWAY_API_KEY"]', 'm = "openai/gpt-fixture-retired"'],
      '2 warning vercel-ai-gateway',
    ],
    // LiteLLM's variable for the Gateway's key, and another package's import, aren't signals.
    [
      'a.py',
      ['key = os.environ["VERCEL_AI_GATEWAY_API_KEY"]', 'm = "openai/gpt-fixture-retired"'],
      '2 error prefix',
    ],
    [
      'a.ts',
      ["import { x } from 'ai/rsc';", "const m = 'openai/gpt-fixture-retired';"],
      '2 error prefix',
    ],
    // OpenRouter's name wins over the AI SDK's import.
    [
      'a.ts',
      [
        "import { generateText } from 'ai';",
        "import { openrouter } from '@openrouter/ai-sdk-provider';",
        "openrouter('openai/gpt-fixture-retired');",
      ],
      '3 warning openrouter',
    ],
  ])('reads `<vendor>/<id>` by the router a file uses: %s %j', async (path, lines, expected) => {
    const { result } = await brief(path, lines.join('\n'));
    expect(
      result.findings.map((f) => `${f.location.line} ${f.severity} ${f.context?.kind}`).join(', '),
    ).toBe(expected);
  });

  it("gives the Vercel AI Gateway's slugs both Gemini platforms' dates, capped at a warning", async () => {
    const { result } = await brief(
      'a.ts',
      "import { streamText } from 'ai';\nstreamText({ model: 'google/gemini-fixture-1.0-flash' });",
    );
    const [finding] = result.findings;
    expect(finding?.entries.map((e) => e.platform)).toEqual(['gemini-api', 'vertex']);
    expect(finding?.context).toEqual({ kind: 'vercel-ai-gateway', vendor: 'google' });
    const retired = await brief(
      'a.ts',
      "import { streamText } from 'ai';\nstreamText({ model: 'openai/gpt-fixture-retired' });",
    );
    expect(retired.result.findings[0]?.message).toBe(
      'gpt-fixture-retired (openai; via the Vercel AI Gateway (openai/)) was retired on 2098-06-30. Recommended replacement: gpt-fixture-4o (openai). The Vercel AI Gateway may still route this slug to other providers, so this is a warning, not an error.',
    );
  });

  it("reads `<vendor>/<id>` as LiteLLM's prefix in a file that doesn't mention OpenRouter", async () => {
    const { result } = await brief(
      'a.py',
      [
        'a = completion(model="openai/gpt-fixture-retired")',
        'b = completion(model="anthropic/claude-fixture-opus-9")',
      ].join('\n'),
    );
    expect(result.findings.map((f) => `${f.location.line} ${f.severity} ${f.rule}`)).toEqual([
      '1 error model-retired',
      '2 error model-retiring',
    ]);
    expect(result.findings[0]?.message).toBe(
      'gpt-fixture-retired (openai; prefix openai/) was retired on 2098-06-30. Recommended replacement: gpt-fixture-4o (openai).',
    );
  });

  it('applies region-scoped dates', async () => {
    const { result } = await brief('a.py', 'm = "anthropic.claude-fixture-1-20990101-v1:0"');
    const [finding] = result.findings;
    expect(finding?.severity).toBe('error');
    expect(finding?.entry?.regions).toEqual(['us-gov-west-1']);
    expect(finding?.message).toContain('Other dates: bedrock other regions: 2099-06-01');
  });

  it('reports opaque Bedrock ARNs as unresolved', async () => {
    const { unresolved } = await brief(
      'a.py',
      'm = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3"',
    );
    expect(unresolved).toEqual([
      'opaque-arn 1:6 null = arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3',
    ]);
  });

  it('leaves host names, code, prefixes, paths and other providers out of the inventory', async () => {
    const { inventory } = await brief(
      'a.py',
      [
        'URL = "https://api.openai.com/v1"',
        'HOST = "my.openai.azure-api.net"',
        'CLIENT = "anthropic.Anthropic"',
        'MODULE = "openai.types.chat"',
        'PREFIX = "gpt-77-"',
        'OTHER = "cursor/claude-77-sonnet"',
        'PAGE = "https://example.com/guides/gpt-77-turbo"',
        'KEPT = ["amazon.titan-77-embed-v2:0", "anthropic/claude-sonnet-77", "gpt-77-mini"]',
      ].join('\n'),
    );
    expect(inventory).toEqual([
      'amazon.titan-77-embed-v2:0',
      'anthropic/claude-sonnet-77',
      'gpt-77-mini',
    ]);
  });

  it('collects unknown model-like strings in the inventory, with OpenRouter vendors', async () => {
    const { inventory, findings } = await brief(
      'a.py',
      'a = "gpt-77-turbo"\nb = "anthropic/claude-sonnet-4.5"\n# "gpt-99" in a comment\nc = "gpt-fixture-3"',
    );
    expect(inventory).toEqual(['anthropic/claude-sonnet-4.5', 'gpt-77-turbo']);
    expect(findings).toHaveLength(1);
  });

  it('reads an ID next to a letter of any script as part of a word', async () => {
    // A German biography that names the island Kınalıada: `ı` is a letter, as `i` would be.
    const { findings, inventory } = await brief(
      'a.json',
      [
        '{',
        '  "a": "Kınalıgpt-fixture-retired",',
        '  "b": "égpt-fixture-retired",',
        '  "c": "éopenai:gpt-fixture-retired",',
        '  "d": "Kınalıgpt-77-turbo",',
        '  "e": "«gpt-fixture-retired»"',
        '}',
      ].join('\n'),
    );
    expect(findings).toEqual(['model-retired error 6:10 gpt-fixture-retired']);
    expect(inventory).toEqual([]);
  });

  it.each<[string, string, number]>([
    ['a.ts', "it('should include response_format for gpt-fixture-retired', () => {});", 0],
    ['a.py', 'raise ValueError("Model gpt-fixture-retired is not supported")', 0],
    ['a.yaml', 'description: Summaries with gpt-fixture-retired, fast and cheap', 0],
    ['a.py', 'BODY = \'{"model": "gpt-fixture-retired", "temperature": 0}\'', 1],
    ['a.cs', 'var body = "{\\"model\\": \\"gpt-fixture-retired\\", \\"n\\": 1}";', 1],
    ['a.py', 'CMD = "python run.py --model gpt-fixture-retired --temperature 0"', 1],
    ['a.py', 'CMD = "python run.py --model=gpt-fixture-retired"', 1],
    ['a.yaml', 'steps:\n  - run: python eval.py --model gpt-fixture-retired', 1],
    ['a.py', 'PROMPT = """\nmodel: gpt-fixture-retired\ntemperature: 0\n"""', 1],
    ['a.ts', "const code = `generateText({\n  model: 'openai/gpt-fixture-retired',\n})`;", 1],
    // Flags: `_` in the name, `-m`, and any other long flag.
    ['a.py', 'CMD = "python eval.py --model_name gpt-fixture-retired --out x"', 1],
    ['a.py', 'CMD = "python eval.py --model_name=gpt-fixture-retired"', 1],
    ['a.py', 'os.system("llm -m gpt-fixture-retired \'Summarize this\'")', 1],
    ['a.yaml', 'worker:\n  command: python worker.py -m gpt-fixture-retired', 1],
    ['a.py', 'CMD = f"python run.py --model {m} --fallback gpt-fixture-retired"', 1],
    ['a.py', 'CMD = "python run.py --llm gpt-fixture-retired"', 1],
    ['a.py', 'MSG = "rm -rf gpt-fixture-retired before you start"', 0],
    ['a.py', 'MSG = "see--model gpt-fixture-retired"', 0],
    // Defaults in template expressions and placeholders.
    ['a.yaml', 'value: {{ .Values.model | default "gpt-fixture-retired" | quote }}', 1],
    ['a.yaml', 'args:\n  - {{ default "gpt-fixture-retired" .Values.model }}', 1],
    ['a.yaml', "env:\n  MODEL: ${{ inputs.model || 'gpt-fixture-retired' }}", 1],
    ['a.yaml', "llm: \"{{ lookup('env', 'MODEL') | default('gpt-fixture-retired', true) }}\"", 1],
    ['a.yaml', 'llm: "{{ model or \'gpt-fixture-retired\' }}"', 1],
    ['a.yaml', 'llm: "{{ model ?? \'gpt-fixture-retired\' }}"', 1],
    ['a.yaml', 'command: python app.py --temperature 0 ${MODEL:-gpt-fixture-retired}', 1],
    ['a.yaml', 'command: python app.py --temperature 0 ${MODEL:=gpt-fixture-retired}', 1],
    ['a.py', 'raise ValueError("Failed to create the default \'gpt-fixture-retired\' model.")', 0],
    ['a.py', "raise ValueError(\"model must be 'gpt-fixture-3' or 'gpt-fixture-retired'\")", 0],
    ['a.yaml', 'note: "{{ model }} or \'gpt-fixture-retired\'"', 0],
    ['a.yaml', 'text: Use `gpt-fixture-3` or `gpt-fixture-retired`.', 0],
    // A list of IDs isn't a sentence: whitespace, newlines and commas, quotes, prefixes.
    ['.env', 'FALLBACK_MODELS="gpt-fixture-retired gpt-fixture-3"', 2],
    ['a.yaml', 'fallback_models: gpt-fixture-retired gpt-fixture-1-2099-01-10', 2],
    ['a.yaml', 'files:\n  models.txt: |\n    gpt-fixture-retired\n    gpt-fixture-3\n', 2],
    ['a.py', 'MODELS = """\ngpt-fixture-retired\ngpt-fixture-3\n"""', 2],
    ['a.py', "MODELS = \"'gpt-fixture-retired', 'gpt-fixture-3'\"", 2],
    ['a.yaml', 'models: openai/gpt-fixture-retired, anthropic/claude-fixture-opus-9', 2],
    ['a.py', 'MSG = "gpt-fixture-retired and gpt-fixture-3"', 0],
    ['a.py', 'MSG = "gpt-fixture-retired gpt-fixture-3."', 0],
    ['a.py', 'MODELS = "gpt-fixture-retired gpt-77-turbo"', 0],
    ['a.py', 'PATHS = "gpt-fixture-retired examples/gpt-fixture-3"', 0],
    ['a.py', 'MODELS = "[gpt-fixture-retired, gpt-fixture-3]"', 0],
  ])('counts an ID in a sentence only as a model value: %s %s → %i', async (path, text, count) => {
    expect((await brief(path, text)).findings).toHaveLength(count);
  });

  it('reads the default of a placeholder as a model ID', async () => {
    const { findings } = await brief(
      'src/main/java/Chat.java',
      [
        'class Chat {',
        '  @Value("${spring.ai.openai.chat.options.model:gpt-fixture-retired}")',
        '  String model;',
        '  @Value("${app.fallback-model:claude-fixture-opus-9}")',
        '  String fallback;',
        '}',
      ].join('\n'),
    );
    expect(findings).toEqual([
      'model-retired error 2:49 gpt-fixture-retired',
      'model-retiring warning 4:32 claude-fixture-opus-9',
    ]);
    const properties = await brief(
      'application.properties',
      'spring.ai.openai.chat.options.model=${OPENAI_MODEL:gpt-fixture-retired}',
    );
    expect(properties.findings).toEqual(['model-retired error 1:52 gpt-fixture-retired']);
  });

  it('counts a single-word ID only after a model flag', async () => {
    const registry = withEntries({ model_id: 'quokka' });
    for (const [text, count] of [
      ['CMD = "openai api completions.create --engine quokka -p hi"', 1],
      ['CMD = "python -m quokka --verbose"', 0],
      ['CMD = "python run.py --language quokka"', 0],
    ] as const) {
      expect((await brief('a.py', text, { registry })).findings).toHaveLength(count);
    }
  });

  it('reads an ID followed by `*` as a glob, not as a model or an unknown ID', async () => {
    const glob = await brief('a.ts', 'const route = { model: "openai/gpt-fixture-retired*" };');
    expect(glob.findings).toEqual([]);
    expect(glob.inventory).toEqual([]);
    const { mentions } = await brief(
      'README.md',
      'Use **gpt-fixture-retired** or *gpt-fixture-3*, not `gpt-fixture-3*`.\n',
    );
    expect(mentions).toEqual(['1:7 gpt-fixture-retired', '1:33 gpt-fixture-3']);
  });

  it('reads a C# verbatim string with doubled quotes', async () => {
    const { findings } = await brief(
      'a.cs',
      'const string Body = @"{ ""model"": ""gpt-fixture-retired"", ""temperature"": 0 }";',
    );
    expect(findings).toEqual(['model-retired error 1:38 gpt-fixture-retired']);
  });

  it.each<[string, string]>([
    ['a.py', 'if model.startswith("gpt-fixture-retired"): pass'],
    ['a.py', 'if model.startswith(("gpt-fixture-3", "gpt-fixture-retired")): pass'],
    ['a.py', 'if "ft:gpt-fixture-retired" in model or "gpt-fixture-3" not in model: pass'],
    ['a.py', 'm = re.match(r"gpt-fixture-retired", model)'],
    ['a.ts', "if (model.startsWith('gpt-fixture-retired') || id.includes('gpt-fixture-3')) {}"],
    ['a.go', 'if strings.HasPrefix(model, "gpt-fixture-retired") {}'],
    ['a.rb', 'if model.start_with?("gpt-fixture-retired") then end'],
    ['a.php', '<?php if (str_starts_with($model, "gpt-fixture-retired")) {}'],
  ])('ignores the arguments of prefix and substring checks: %s %s', async (path, text) => {
    expect((await brief(path, text)).findings).toEqual([]);
  });

  it('still reports IDs compared or listed next to a check', async () => {
    const { findings } = await brief(
      'a.py',
      'if model == "gpt-fixture-retired" or model in ["gpt-fixture-retired"]: pass',
    );
    expect(findings).toHaveLength(2);
  });

  it('reads `in` as a check only where it is an operator, not a key', async () => {
    const openapi = [
      'parameters:',
      '  - name: model',
      '    schema:',
      '      enum:',
      '        - gpt-fixture-retired',
      '    in: query',
    ].join('\n');
    expect((await brief('openapi.yaml', openapi)).findings).toEqual([
      'model-retired error 5:11 gpt-fixture-retired',
    ]);
    expect((await brief('a.toml', 'model = "gpt-fixture-retired"\nin = "query"')).findings).toEqual(
      ['model-retired error 1:10 gpt-fixture-retired'],
    );
    const split = 'if (\n    "gpt-fixture-retired"\n    in model\n): pass';
    expect((await brief('a.py', split)).findings).toEqual([]);
  });

  it('ignores an ID of letters and digits inside base64', async () => {
    const registry = withEntries({ model_id: 'q7' });
    const { findings } = await brief(
      'a.ts',
      [
        'const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ+q7/AAADUlEQVR4";',
        'const raw = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlE+q7+";',
        'const model = "q7";',
        'const sum = "a+q7+b";',
      ].join('\n'),
      { registry },
    );
    expect(findings).toEqual(['model-retired error 3:16 q7', 'model-retired error 4:16 q7']);
  });

  describe('a single-word ID', () => {
    // Like OpenAI's `ada` and `davinci`: a word that also names a language, a unit or a class.
    const registry = withEntries({ model_id: 'quokka' });

    it.each<[string, string, number]>([
      ['a.ts', "hljs.registerLanguage('quokka', require('highlight.js/lib/languages/quokka'));", 0],
      ['a.ts', "export const UNITS = { activity: ['becquerel', 'quokka'] };", 0],
      ['a.tsx', 'const p = <p className="quokka">x</p>;', 0],
      ['a.py', 'names = ["babbage", "quokka"]', 0],
      ['a.yaml', 'language: quokka', 0],
      ['a.py', 'x = "quokka is fine"', 0],
      ['a.json', '{"model": "Kınalıquokka", "engine": "quokkaß"}', 0],
      ['a.py', 'r = openai.Completion.create(engine="quokka", prompt="x")', 1],
      ['a.py', 'client.embeddings.create(model="quokka", input=x)', 1],
      ['a.py', 'EMBEDDING_MODEL = "quokka"', 1],
      ['a.json', '{"model": "quokka", "language": "quokka"}', 1],
      ['a.yaml', 'model: quokka  # old', 1],
      ['a.go', 'req := Request{Model: "quokka"}', 1],
      // In a list of IDs, it still needs a model key; the list's other IDs count.
      ['a.yaml', 'fallback: quokka gpt-fixture-retired', 1],
      ['a.yaml', 'models: quokka quokka', 0],
    ])('%s: %s → %i', async (path, text, count) => {
      expect((await brief(path, text, { registry })).findings).toHaveLength(count);
    });

    it('is a docs mention only as a model value', async () => {
      const { mentions } = await brief(
        'README.md',
        'The quokka is a marsupial.\n\n```python\nopenai.Completion.create(engine="quokka")\n```\n',
        { registry },
      );
      expect(mentions).toEqual(['4:34 quokka']);
    });
  });
});

describe('dynamic detector', () => {
  it.each([
    ['model', true],
    ['model_id', true],
    ['modelId', true],
    ['MODEL_NAME', true],
    ['OPENAI_MODEL', true],
    ['defaultModel', true],
    ['chat-model', true],
    ['deployment', true],
    ['deployment_name', true],
    ['azure_deployment', true],
    ['deployment_id', true],
    ['chatDeploymentName', true],
    ['AZURE_OPENAI_DEPLOYMENT', true],
    ['githubDeploymentId', false],
    ['k8s_deployment', false],
    ['vercelDeploymentName', false],
    ['engine', false],
    ['view_model', false],
    ['response_model', false],
    ['dataModel', false],
    ['model_path', false],
    ['search_engine', false],
    ['models', false],
    ['customModelName', false],
    ['provisionedModelId', false],
    ['fine_tuned_model', true],
  ])('isModelKey(%s) is %s', (key, expected) => {
    expect(isModelKey(key)).toBe(expected);
  });

  it.each<[string, string, string[]]>([
    ['a.py', 'client.create(model=os.environ["M"])', ['environment 1:15 model = os.environ["M"]']],
    [
      'a.py',
      'client.create(model=os.getenv("M", "x"))',
      ['environment 1:15 model = os.getenv("M", "x")'],
    ],
    ['a.py', 'client.create(\n    model=model_name,\n)', ['variable 2:5 model = model_name']],
    [
      'a.py',
      'client.create(model=f"{family}-mini")',
      ['interpolated 1:15 model = f"{family}-mini"'],
    ],
    ['a.py', 'model = model.to(device)', []],
    ['a.py', 'model = os.environ["M"]', ['environment 1:1 model = os.environ["M"]']],
    ['a.py', 'self.model = Net()', []],
    ['a.py', 'def f(model: str = "x"): ...', []],
    ['a.py', 'def f(model: Optional[str] = None): ...', []],
    ['a.py', 'cfg = {"model": settings.MODEL}', ['variable 1:9 model = settings.MODEL']],
    ['a.py', 'model = genai.GenerativeModel(name)', []],
    ['a.py', 'x = "model = foo"', []],
    ['a.py', '# model = os.environ["M"]', []],
    [
      'a.ts',
      'openai.create({ model: process.env.MODEL })',
      ['environment 1:17 model = process.env.MODEL'],
    ],
    [
      'a.ts',
      'const model = process.env.MODEL ?? "x";',
      ['environment 1:7 model = process.env.MODEL ?? "x"'],
    ],
    ['a.ts', 'interface O { model: string; modelId: ModelId; m?: string }', []],
    ['a.ts', 'x({ model: MODEL_NAME, temperature: 0 })', ['variable 1:5 model = MODEL_NAME']],
    // A constant set to a plain string in the same file is resolved where it's defined.
    ['a.ts', "const LLM_MODEL = 'claude-x';\nx({ model: LLM_MODEL })", []],
    ['a.ts', 'const M: string = "gpt-x";\nx({ model: M })', []],
    ['a.py', 'M = "gpt-x"\nclient.create(model=M)', []],
    ['a.go', 'const M = "gpt-x"\nreq := Request{Model: M}', []],
    // Still unresolved: an interpolated constant, an environment constant, a property.
    ['a.ts', 'const M = `${base}-mini`;\nx({ model: M })', ['variable 2:5 model = M']],
    ['a.ts', 'const M = process.env.M;\nx({ model: M })', ['variable 2:5 model = M']],
    ['a.ts', 'cfg.M = "gpt-x";\nx({ model: M })', ['variable 2:5 model = M']],
    // Schema and column definitions describe the field; they don't set it.
    ['a.ts', 'const S = z.object({ model: z.string().min(1) })', []],
    ['a.ts', 'export const t = pgTable("t", { model: text("model").notNull() })', []],
    ['a.ts', 'x({ model: v.optional(v.string()) })', []],
    ['a.ts', 'db.update({ data: { githubDeploymentId: result.value } })', []],
    ['a.ts', 'const m = cond ? model : other;', []],
    ['a.ts', 'x({ model: `${base}-mini` })', ['interpolated 1:5 model = `${base}-mini`']],
    // Not model keys or not values: an engine, a type, a model passed on under its own name.
    ['a.ts', 'new Client({ engine: dbEngine })', []],
    ['a.py', 'def validate(model: type[BaseModel] = Item, *, args_model: Type[T]): ...', []],
    [
      'variables.tf',
      'variable "d" {\n  type = object({\n    model_name    = string\n    model_version = optional(string)\n  })\n}',
      [],
    ],
    ['a.py', 'client.create(model=model, openai_model=openai_model)', []],
    // A parameter's default after its type is classified like any value.
    [
      'a.ts',
      "function ask(model: string = process.env.MODEL ?? 'gpt-fixture-3') {}",
      ["environment 1:14 model = process.env.MODEL ?? 'gpt-fixture-3'"],
    ],
    ['a.py', 'def chat(model: str = "gpt-fixture-3", n: int = 1): ...', []],
    ['a.py', 'client.create(model=model_name)', ['variable 1:15 model = model_name']],
    // A call with a model ID as its first argument is checked as that literal.
    ['a.ts', "streamText({ model: openai('gpt-fixture-3'), prompt })", []],
    ['a.ts', "x({ model: registry.languageModel('openai:gpt-77-turbo') })", []],
    ['a.ts', "x({ model: groq('llama-3.3-70b-versatile'), m2: xai.responses('grok-4.7') })", []],
    ['a.py', 'agent = Agent(model=init_chat_model("anthropic:claude-fixture-opus-9"))', []],
    [
      'a.ts',
      "x({ model: azure('my-deployment') })",
      ["variable 1:5 model = azure('my-deployment')"],
    ],
    [
      'a.ts',
      'x({ model: openai(`${family}-mini`) })',
      ['variable 1:5 model = openai(`${family}-mini`)'],
    ],
    [
      'a.py',
      'client.create(model=os.getenv("MODEL", "gpt-fixture-3"))',
      ['environment 1:15 model = os.getenv("MODEL", "gpt-fixture-3")'],
    ],
    [
      'a.py',
      'client.create(model=settings.get("model", "gpt-fixture-3"))',
      ['variable 1:15 model = settings.get("model", "gpt-fixture-3")'],
    ],
    [
      'a.ts',
      "x({ model: config.get('llm.model') })",
      ["variable 1:5 model = config.get('llm.model')"],
    ],
    ['a.ts', 'x({ model: "gpt-fixture-3-mini" })', []],
    ['a.ts', 'x({ model: null, engine: 3, deployment: { a: 1 } })', []],
    [
      'a.go',
      'req := Request{Model: os.Getenv("MODEL")}',
      ['environment 1:16 Model = os.Getenv("MODEL")'],
    ],
    [
      'a.cs',
      'var c = new Client(deployment: Environment.GetEnvironmentVariable("D"));',
      ['environment 1:20 deployment = Environment.GetEnvironmentVariable("D")'],
    ],
    ['a.rb', 'model = ENV["MODEL"]', ['environment 1:1 model = ENV["MODEL"]']],
    [
      'a.yaml',
      'model: ${MODEL}\nother_model: "${{ vars.M }}"\nmodel_name: gpt-x',
      ['environment 1:1 model = ${MODEL}', 'environment 2:1 other_model = "${{ vars.M }}"'],
    ],
    [
      'a.yaml',
      'steps:\n  - run: python eval.py --model "$MODEL"',
      ['environment 2:25 --model = $MODEL'],
    ],
    [
      'a.json',
      '{"model": "gpt-x", "deployment": "${DEPLOYMENT}"}',
      ['environment 1:21 deployment = "${DEPLOYMENT}"'],
    ],
    [
      '.env',
      'OPENAI_MODEL=$DEFAULT_MODEL\nMODEL=gpt-x',
      ['environment 1:1 OPENAI_MODEL = $DEFAULT_MODEL'],
    ],
    ['run.sh', 'MODEL="${MODEL:-gpt-x}"', ['environment 1:1 MODEL = "${MODEL:-gpt-x}"']],
    ['run.sh', 'cat <<EOF\nmodel: gpt-x\nEOF', []],
    [
      'compose.yaml',
      'environment:\n  - MODEL=${WORKER_MODEL}',
      ['environment 2:5 MODEL = ${WORKER_MODEL}'],
    ],
    [
      'run.sh',
      'python run.py --model=${MODEL:-x} --model-name "$N"',
      ['environment 1:15 --model = ${MODEL:-x}', 'environment 1:35 --model-name = $N'],
    ],
    ['main.tf', 'locals {\n  model = var.model_name\n}', ['variable 2:3 model = var.model_name']],
    ['docs/a.md', 'model = os.environ["M"]', []],
  ])('%s: %s', async (path, text, expected) => {
    expect((await brief(path, text)).unresolved).toEqual(expected);
  });
});

describe('azure deployment detector', () => {
  const tf = (model: string) =>
    `resource "azurerm_cognitive_deployment" "d" {\n  name = "my-deployment"\n  model {\n${model}\n  }\n}\n`;

  it('matches Terraform model blocks on (name, version)', async () => {
    const { findings, unresolved } = await brief(
      'main.tf',
      tf('    format  = "OpenAI"\n    name    = "gpt-fixture-4o"\n    version = "2099-01-05"'),
    );
    expect(findings).toEqual(['model-retiring error 5:16 gpt-fixture-4o']);
    expect(unresolved).toEqual([]);
  });

  it('does not report a version that is far from retirement', async () => {
    const { findings } = await brief(
      'main.tf',
      tf('    name    = "gpt-fixture-4o"\n    version = "2099-08-06"'),
    );
    expect(findings).toEqual([]);
  });

  it('reports a missing version as unresolved, listing the known versions', async () => {
    const { result } = await brief('main.tf', tf('    name = "gpt-fixture-4o"'));
    expect(result.findings).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.reason).toBe('azure-no-version');
    expect(result.unresolved[0]?.message).toContain(
      'Known versions: 2099-01-05 (retires 2099-01-25), 2099-08-06 (retires 2099-09-30)',
    );
    // As of the scan's day: a date that has come is a retirement that happened.
    for (const [today, note] of [
      ['2099-01-25', '2099-01-05 (retired 2099-01-25), 2099-08-06 (retires 2099-09-30)'],
      ['2099-10-01', '2099-01-05 (retired 2099-01-25), 2099-08-06 (retired 2099-09-30)'],
    ] as const) {
      const later = await brief('main.tf', tf('    name = "gpt-fixture-4o"'), {
        clock: fixedClock(today),
      });
      expect(later.result.unresolved[0]?.message).toContain(`Known versions: ${note}.`);
    }
    // A date that isn't exact doesn't say the model is gone.
    const entry = fixtureRegistry.models.find(
      (e) => e.id === 'azure-openai:gpt-fixture-4o@2099-01-05',
    ) as RegistryEntry;
    const message = (qualifier: RegistryEntry['retirement_date_qualifier']) =>
      unresolvedMessage(
        'azure-no-version',
        'model.name',
        'gpt-fixture-4o',
        [{ ...entry, retirement_date_qualifier: qualifier }],
        '2099-02-01' as IsoDate,
      );
    expect(message('no_earlier_than')).toContain(
      'Known versions: 2099-01-05 (retirement no earlier than 2099-01-25).',
    );
    expect(message('approximate')).toContain(
      'Known versions: 2099-01-05 (retirement around 2099-01-25).',
    );
  });

  it('reports variable names and versions as unresolved', async () => {
    const { unresolved } = await brief(
      'main.tf',
      tf('    name    = var.model\n    version = "1"') +
        tf('    name    = "gpt-fixture-4o"\n    version = var.v'),
    );
    expect(unresolved).toEqual([
      'variable 4:15 model.name = var.model',
      // The location is the model name; the message names the version.
      'variable 11:16 model.version = var.v',
    ]);
  });

  it('ignores commented-out blocks and reports unknown models', async () => {
    const { findings, unresolved, result } = await brief(
      'main.tf',
      `resource "azurerm_cognitive_deployment" "d" {\n  # model { name = "gpt-fixture-4o" }\n  model {\n    name = "other-model"\n  }\n}`,
    );
    expect(findings).toEqual([]);
    expect(unresolved).toEqual(['azure-unknown 4:13 model.name = other-model']);
    expect(result.unresolved[0]?.message).toBe(
      "The Azure deployment of other-model isn't in Sunset's registry, so Sunset can't check it; make sure the model isn't deprecated or retiring.",
    );
  });

  it("gives a deployment's model name Azure's dates only, even when Azure's are unknown", async () => {
    // A first-party ID as an Azure model name, and a known Azure model with an unknown version.
    const { findings, unresolved, inventory, result } = await brief(
      'main.tf',
      tf('    name    = "gpt-fixture-retired"\n    version = "0613"') +
        tf('    name    = "gpt-fixture-4o"\n    version = "2099-12-31"'),
    );
    expect(findings).toEqual([]);
    expect(inventory).toEqual([]);
    expect(unresolved).toEqual([
      'azure-unknown 4:16 model.name = gpt-fixture-retired',
      'azure-unknown 11:16 model.version = 2099-12-31',
    ]);
    expect(result.unresolved[1]?.message).toBe(
      "The Azure deployment of gpt-fixture-4o version 2099-12-31 isn't in Sunset's registry, so Sunset can't check it. Known versions: 2099-01-05 (retires 2099-01-25), 2099-08-06 (retires 2099-09-30).",
    );
  });

  it('matches Azure Verified Modules and module inputs', async () => {
    const bicep = await brief(
      'main.bicep',
      `module foundry 'br/public:avm/res/cognitive-services/account:0.15.0' = {\n  params: {\n    deployments: [\n      {\n        name: 'chat'\n        model: {\n          format: 'OpenAI'\n          name: 'gpt-fixture-4o'\n          version: '2099-01-05'\n        }\n      }\n    ]\n  }\n}`,
    );
    expect(bicep.findings).toEqual(['model-retiring error 8:18 gpt-fixture-4o']);

    const avm = await brief(
      'main.tf',
      `module "openai" {\n  source = "Azure/avm-res-cognitiveservices-account/azurerm"\n  cognitive_deployments = {\n    chat = {\n      name = "chat"\n      model = {\n        format  = "OpenAI"\n        name    = "gpt-fixture-4o"\n        version = "2099-01-05"\n      }\n    }\n  }\n}`,
    );
    expect(avm.findings).toEqual(['model-retiring error 8:20 gpt-fixture-4o']);

    const inputs = await brief(
      'main.tf',
      `module "openai" {\n  source = "Azure/openai/azurerm"\n  deployment = {\n    "chat" = {\n      name          = "chat"\n      model_format  = "OpenAI"\n      model_name    = "gpt-fixture-4o"\n      model_version = "2099-01-05"\n    }\n  }\n}`,
    );
    expect(inputs.findings).toEqual(['model-retiring error 7:24 gpt-fixture-4o']);

    const types = await brief(
      'variables.tf',
      'variable "deployment" {\n  type = map(object({\n    model_format  = string\n    model_name    = string\n    model_version = optional(string)\n  }))\n}',
    );
    expect(types.unresolved).toEqual([]);
  });

  it('matches Bicep and ARM deployments', async () => {
    const bicep = await brief(
      'main.bicep',
      `resource d 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {\n  name: 'dep'\n  properties: {\n    model: {\n      format: 'OpenAI'\n      name: 'gpt-fixture-4o'\n      version: '2099-01-05'\n    }\n  }\n}`,
    );
    expect(bicep.findings).toEqual(['model-retiring error 6:14 gpt-fixture-4o']);

    const arm = await brief(
      'azuredeploy.json',
      `{"resources": [{"type": "Microsoft.CognitiveServices/accounts/deployments",\n "properties": {"model": {"format": "OpenAI", "name": "gpt-fixture-4o", "version": "[parameters('v')]"}}}]}`,
    );
    expect(arm.findings).toEqual([]);
    expect(arm.unresolved).toEqual(["variable 2:56 model.version = [parameters('v')]"]);
  });

  it('matches az CLI commands, including continuations', async () => {
    const { findings, unresolved } = await brief(
      'deploy.sh',
      'az cognitiveservices account deployment create \\\n  --name acct --deployment-name d \\\n  --model-name gpt-fixture-4o --model-version "2099-01-05" --model-format OpenAI\naz cognitiveservices account deployment create --model-name gpt-fixture-4o',
    );
    expect(findings).toEqual(['model-retiring error 3:16 gpt-fixture-4o']);
    expect(unresolved).toEqual(['azure-no-version 4:61 model.name = gpt-fixture-4o']);

    // PowerShell continues a line with a backtick.
    const ps = await brief(
      'deploy.ps1',
      'az cognitiveservices account deployment create `\n  --name acct --deployment-name d `\n  --model-name gpt-fixture-4o --model-version "2099-01-05" --model-format OpenAI',
    );
    expect(ps.findings).toEqual(['model-retiring error 3:16 gpt-fixture-4o']);
  });

  it("reports a deployment called by name, with the model's known versions", async () => {
    const { unresolved, result } = await brief(
      'a.py',
      [
        'completion(model="azure/gpt-fixture-4o")',
        'completion(model="azure/my-deployment")',
        '# completion(model="azure/gpt-fixture-4o")',
        'URL = "https://r.openai.azure.com/openai/deployments/gpt-fixture-4o/chat/completions"',
      ].join('\n'),
    );
    expect(unresolved).toEqual([
      'azure-deployment-name 1:25 null = azure/gpt-fixture-4o',
      'azure-deployment-name 4:54 null = openai/deployments/gpt-fixture-4o',
    ]);
    expect(result.findings).toEqual([]);
    expect(result.unresolved[0]?.message).toContain(
      'Known versions: 2099-01-05 (retires 2099-01-25), 2099-08-06 (retires 2099-09-30)',
    );
  });

  it('reports every deployment called by name in a large file', async () => {
    // More than `push(...)` takes as arguments without overflowing the stack.
    const count = 200_000;
    const result = await scanFiles(
      { 'a.py': 'm = "azure/gpt-fixture-4o"\n'.repeat(count) },
      { maxFileSize: 8 * 1024 * 1024 },
    );
    expect(result.unresolved).toHaveLength(count);
  });

  it('keeps the Azure finding instead of the first-party literal at the same place', async () => {
    const { result } = await brief(
      'main.tf',
      tf('    name    = "gpt-fixture-4o"\n    version = "2099-01-05"'),
    );
    expect(result.findings.map((f) => f.context?.kind)).toEqual(['azure-deployment']);
  });
});

describe('adversarial input', () => {
  // Each of these took seconds to minutes when a detector rescanned the text for every match or
  // backtracked over it; a linear scan of 1 MiB takes well under a second.
  const MIB = 1024 * 1024;
  const fill = (unit: string): string => unit.repeat(Math.ceil(MIB / unit.length)).slice(0, MIB);

  it.each<[string, string, string]>([
    ['a hyphen chain in a string', 'a.js', `// model\nconst ID = "${fill('ab-')}";\n`],
    ['a hyphen chain as a value', 'a.py', `x = ${fill('model-')}\n`],
    ['minified properties', 'a.js', fill('f({model:e,messages:t});')],
    ['keyword arguments', 'a.py', fill('r = client.create(model=m, messages=[])\n')],
    ['interpolated properties', 'a.js', fill('f({model:`${a}`});')],
    ['flags on one line', 'run.sh', fill('--model $X ')],
    ['deployment keys on one line', 'a.ts', fill('deploymentName: x, ')],
    [
      'unclosed Terraform model blocks',
      'main.tf',
      `resource "azurerm_cognitive_deployment" "d" {\n${fill('model {\n')}`,
    ],
    [
      'unclosed Bicep model blocks',
      'main.bicep',
      `// Microsoft.CognitiveServices/accounts/deployments\n${fill('model: {\n')}`,
    ],
    [
      'an az command that never ends',
      'deploy.sh',
      fill('az cognitiveservices account deployment create \\\n'),
    ],
  ])('scans %s in linear time', async (_name, path, text) => {
    const started = performance.now();
    await scanFiles({ [path]: text }, { maxFileSize: 2 * MIB });
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
