// Platform inference from dependency manifests, and how it settles IDs shared across platforms.
import { describe, expect, it } from 'vitest';
import { inferPlatforms, isManifest } from '../src/core/platforms.ts';
import { scanFiles } from './helpers.ts';

describe('inferPlatforms', () => {
  it('reads a 1 MiB pyproject.toml with a very deep table in little time and memory', () => {
    const deep = `[${Array(2001).fill('a').join('.')}]\n${'b=1\n'.repeat(260_000)}`;
    const text = `[project]\ndependencies = ["anthropic"]\n${deep}`;
    const started = performance.now();
    expect(inferPlatforms([{ path: 'pyproject.toml', text }]).platforms).toEqual(['anthropic']);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('reads npm dependencies of every kind', () => {
    expect(
      inferPlatforms([
        {
          path: 'web/package.json',
          text: JSON.stringify({
            dependencies: { '@google/generative-ai': '^0.24', react: '19' },
            devDependencies: { '@ai-sdk/amazon-bedrock': '1' },
            peerDependencies: { '@langchain/anthropic': '1' },
          }),
        },
      ]),
    ).toEqual({
      platforms: ['anthropic', 'bedrock', 'gemini-api'],
      evidence: [
        'web/package.json: @google/generative-ai',
        'web/package.json: @ai-sdk/amazon-bedrock',
        'web/package.json: @langchain/anthropic',
      ],
    });
  });

  it('reads Python requirements, pyproject, Pipfile and extras', () => {
    const { platforms, evidence } = inferPlatforms([
      {
        path: 'requirements.txt',
        text: '# openai is not here\nGoogle_GenerativeAI>=0.8\nboto3\n',
      },
      {
        path: 'svc/pyproject.toml',
        text: '[project]\nname = "svc"\ndependencies = ["anthropic[vertex, bedrock]>=0.40", "requests"]\n',
      },
      { path: 'Pipfile', text: '[packages]\nmistralai = "*"\n' },
    ]);
    expect(platforms).toEqual(['anthropic', 'bedrock', 'gemini-api', 'mistral', 'vertex']);
    expect(evidence).toContain('svc/pyproject.toml: anthropic[vertex]');
    // boto3 covers all of AWS: no evidence for Bedrock on its own.
    expect(evidence.some((e) => e.includes('boto3'))).toBe(false);
  });

  it('reads only the tables of a pyproject.toml that declare dependencies', () => {
    const evidence = (text: string) =>
      inferPlatforms([{ path: 'pyproject.toml', text }]).evidence.map((e) =>
        e.replace('pyproject.toml: ', ''),
      );
    // Keywords, classifiers and URLs name packages too.
    expect(
      evidence(
        '[project]\nname = "my-tool"\nkeywords = ["anthropic", "openai", "mistralai"]\nclassifiers = ["Topic :: vertexai"]\ndependencies = ["httpx"]\n\n[project.urls]\nopenai = "https://example.com"\n',
      ),
    ).toEqual([]);
    // The pyproject.toml specification's [project] table, and dependency groups (PEP 735).
    expect(
      evidence(
        [
          '[project]',
          'dependencies = [',
          '  "anthropic[vertex]>=0.40",  # the SDK',
          "  'requests',",
          ']',
          'optional-dependencies.gemini = ["google-generativeai"]',
          '[project.optional-dependencies]',
          'mistral = ["mistralai>=1 ; python_version >= \'3.9\'"]',
          '[dependency-groups]',
          'dev = ["openai", {include-group = "deepseek"}]',
          'deepseek = ["pytest"]',
        ].join('\n'),
      ),
    ).toEqual(['anthropic', 'anthropic[vertex]', 'google-generativeai', 'mistralai', 'openai']);
    // Poetry: dependencies, the legacy dev-dependencies, groups, and a table per package.
    expect(
      evidence(
        [
          '[tool.poetry]',
          'keywords = ["vertexai"]',
          '[tool.poetry.dependencies]',
          'python = "^3.10"',
          '"anthropic" = { version = "^0.40", extras = ["bedrock"] }',
          'mistralai = [{ version = "<1", python = "<3.9" }, { version = "^1", python = ">=3.9" }]',
          '[tool.poetry.dev-dependencies]',
          'langchain-openai = "*"',
          '[tool.poetry.group.cloud.dependencies]',
          'google-cloud-aiplatform = "^1"',
          '[tool.poetry.group.cloud.dependencies.langchain-deepseek]',
          'version = "^0.1"',
          '[tool.poetry.extras]',
          'gemini = ["google-genai"]',
        ].join('\n'),
      ),
    ).toEqual([
      'anthropic',
      'anthropic[bedrock]',
      'mistralai',
      'langchain-openai',
      'google-cloud-aiplatform',
      'langchain-deepseek',
    ]);
    // Comments and strings that look like tables don't start one.
    expect(
      evidence(
        '# [project]\n# dependencies = ["openai"]\n[tool.x]\ntext = """\n[project]\ndependencies = ["openai"]\n"""\n',
      ),
    ).toEqual([]);
  });

  it('reads go.mod', () => {
    expect(
      inferPlatforms([
        {
          path: 'go.mod',
          text: 'module x\n\nrequire (\n\tcloud.google.com/go/vertexai v0.13.0\n\tgithub.com/aws/aws-sdk-go-v2/service/bedrockruntime v1.30.0\n)\n',
        },
      ]).platforms,
    ).toEqual(['bedrock', 'vertex']);
  });

  it("counts Google's Gen AI SDKs for both the Gemini API and Vertex", () => {
    for (const manifest of [
      { path: 'package.json', text: '{"dependencies": {"@google/genai": "^1.30.0"}}' },
      { path: 'requirements.txt', text: 'google-genai>=1.0\n' },
      { path: 'requirements.txt', text: 'langchain-google-genai>=4\n' },
      { path: 'go.mod', text: 'module x\n\nrequire google.golang.org/genai v1.2.0\n' },
    ]) {
      expect(inferPlatforms([manifest]).platforms, manifest.text).toEqual(['gemini-api', 'vertex']);
    }
  });

  it('ignores broken and unrelated manifests', () => {
    expect(
      inferPlatforms([
        { path: 'package.json', text: '{ not json' },
        { path: 'b/package.json', text: '{"dependencies": {"next": "15"}}' },
        // Package names that Object.prototype has.
        { path: 'c/package.json', text: '{"dependencies": {"constructor": "1"}}' },
        { path: 'requirements.txt', text: 'constructor==3.0\nanthropic[toString]\n' },
      ]),
    ).toEqual({ platforms: ['anthropic'], evidence: ['requirements.txt: anthropic'] });
  });

  it('knows which files are manifests', () => {
    for (const path of [
      'package.json',
      'a/b/package.json',
      'requirements.txt',
      'requirements-dev.in',
      'pyproject.toml',
      'Pipfile',
      'setup.py',
      'go.mod',
    ]) {
      expect(isManifest(path), path).toBe(true);
    }
    for (const path of ['package-lock.json', 'go.sum', 'mypackage.json', 'README.md']) {
      expect(isManifest(path), path).toBe(false);
    }
  });
});

describe('preferred platforms in the scan', () => {
  // Anthropic retires it on 2099-01-20 (error), Vertex on 2099-04-01 (notice).
  const files = { 'a.py': 'M = "claude-fixture-opus-9"\n' };
  const verdict = async (preferredPlatforms: ('anthropic' | 'vertex' | 'openai')[]) =>
    (await scanFiles(files, { preferredPlatforms })).findings.map(
      (f) => `${f.severity} ${f.entries.map((e) => e.platform).join(',')}`,
    );

  it("settles shared IDs by the repository's platforms", async () => {
    expect(await verdict(['anthropic'])).toEqual(['error anthropic']);
    expect(await verdict(['vertex'])).toEqual(['notice vertex']);
  });

  it("keeps both of Google's platforms for a repository on the Gen AI SDK", async () => {
    // The Gemini API retires it in 31 days (warning), Vertex later (notice).
    const { platforms } = inferPlatforms([
      { path: 'package.json', text: '{"dependencies": {"@google/genai": "^1"}}' },
    ]);
    const { findings } = await scanFiles(
      { 'a.ts': 'const m = "gemini-fixture-1.0-flash";\n' },
      { preferredPlatforms: platforms },
    );
    expect(findings.map((f) => `${f.severity} ${f.entries.map((e) => e.platform)}`)).toEqual([
      'warning gemini-api,vertex',
    ]);
  });

  it('keeps every candidate when no preferred platform serves the ID', async () => {
    expect(await verdict(['openai'])).toEqual(['warning anthropic,vertex']);
    expect(await verdict(['anthropic', 'vertex'])).toEqual(['warning anthropic,vertex']);
  });

  it('says how the verdict was reached', async () => {
    const [judged] = (await scanFiles(files, { preferredPlatforms: ['vertex'] })).findings;
    expect(judged?.message).toContain(
      "Judged for vertex, which this repository's dependencies use; set `platforms` in .sunset.yml to change that.",
    );
    const [open] = (await scanFiles(files)).findings;
    expect(open?.message).toContain(
      'If you use only some of these platforms, set `platforms` in .sunset.yml.',
    );
  });

  it('never overrides an explicit platforms setting', async () => {
    const result = await scanFiles(files, {
      platforms: ['anthropic'],
      preferredPlatforms: ['vertex'],
    });
    expect(result.findings.map((f) => f.severity)).toEqual(['error']);
  });
});
