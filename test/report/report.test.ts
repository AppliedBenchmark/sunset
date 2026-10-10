// Reporters: a snapshot per format, schema validation for the JSON report and SARIF,
// and the platform limits (25,000 SARIF results, 10 annotations per level, the 1 MiB summary and the
// 65,536-character PR comment).
//
// After an intended change, update the snapshots with `npx vitest run test/report -u` and review
// every diff under test/report/__snapshots__.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { Ajv as AjvDraft7 } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  Finding,
  Registry,
  RegistryEntry,
  RuleId,
  ScanResult,
  UnresolvedReference,
} from '../../src/core/types.ts';
import { annotations } from '../../src/report/annotations.ts';
import { cell, code } from '../../src/report/common.ts';
import { jsonReport, jsonReportText } from '../../src/report/json.ts';
import {
  EXISTING_ROWS,
  PR_COMMENT_LIMIT,
  PR_COMMENT_MARKER,
  prCommentBody,
} from '../../src/report/pr-comment.ts';
import { RULES } from '../../src/report/rules.ts';
import { SARIF_MAX_RESULTS, sarifReport, sarifReportText } from '../../src/report/sarif.ts';
import { SUMMARY_LIMIT_BYTES, summaryMarkdown } from '../../src/report/summary-md.ts';
import { printable, printableLines, type Style, textReport } from '../../src/report/text.ts';
import { fixtureRegistry, root, scanFiles } from '../helpers.ts';
import { LINKED_CONTEXT, manyFindings, SAMPLE_CONTEXT, sampleResult } from './sample.ts';

// ajv-formats is CommonJS with `exports.default`, which ESM sees as a nested default.
const addFormats = createRequire(import.meta.url)('ajv-formats')
  .default as typeof import('ajv-formats').default;

const snap = (name: string) => `./__snapshots__/${name}`;
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/** Pinned draft-07 copy of the SARIF 2.1.0 schema. */
const SARIF_SCHEMA_PATH = `${root}test/schemas/sarif-schema-2.1.0.json`;
const SARIF_SCHEMA_SHA256 = '6352a05f9d03f181b8d9c71a46bdacc4fcff9d8ade5364858b425ba0c0994ed7';

let result: ScanResult;
beforeAll(async () => {
  result = await sampleResult();
});

function sarifValidator() {
  const text = readFileSync(SARIF_SCHEMA_PATH, 'utf8');
  expect(createHash('sha256').update(text).digest('hex')).toBe(SARIF_SCHEMA_SHA256);
  // The schema has a pattern that is invalid with the `u` flag (`…{2}]?$`).
  const ajv = new AjvDraft7({ strict: false, allErrors: true, unicodeRegExp: false });
  addFormats(ajv);
  return ajv.compile(JSON.parse(text));
}

function reportValidator() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  return ajv.compile(JSON.parse(readFileSync(`${root}docs/schemas/report-v1.schema.json`, 'utf8')));
}

describe('text', () => {
  it('matches the snapshot', async () => {
    await expect(textReport(result, SAMPLE_CONTEXT)).toMatchFileSnapshot(snap('report.txt'));
  });

  it('applies the injected style', () => {
    const tag: Style = (format, text) => `<${[format].flat().join('+')}>${text}</>`;
    const out = textReport(result, SAMPLE_CONTEXT, { style: tag });
    expect(out).toContain('<red+bold>Errors (6)</>');
    expect(out).toContain('<yellow>warning</>');
    expect(out).not.toContain('\u001b[');
  });

  it('says so when there is nothing to report', () => {
    const empty = manyFindings(result, 0);
    expect(textReport(empty, SAMPLE_CONTEXT)).toMatch(/^0 errors, 0 warnings, 0 notices\n/);
  });
});

describe('json', () => {
  it('matches the snapshot', async () => {
    await expect(jsonReportText(result, SAMPLE_CONTEXT)).toMatchFileSnapshot(snap('report.json'));
  });

  it('validates against docs/schemas/report-v1.schema.json', () => {
    const validate = reportValidator();
    const ok = validate(jsonReport(result, SAMPLE_CONTEXT));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    expect(
      validate(jsonReport(manyFindings(result, 0), { ...SAMPLE_CONTEXT, registryOrigin: null })),
    ).toBe(true);
    // A router's slug: each router is a context kind of its own.
    for (const kind of ['openrouter', 'vercel-ai-gateway'] as const) {
      const findings = result.findings.map((f, i) =>
        i === 0 ? { ...f, context: { kind, vendor: 'openai' } } : f,
      );
      expect(validate(jsonReport({ ...result, findings }, SAMPLE_CONTEXT))).toBe(true);
    }
  });

  it('counts by severity and reports the registry age', () => {
    const report = jsonReport(result, SAMPLE_CONTEXT);
    expect(report.summary).toMatchObject({ errors: 6, warnings: 2, notices: 2, unresolved: 1 });
    expect(report.registry).toMatchObject({
      origin: 'bundled',
      newest_check: '2099-01-01',
      age_days: 0,
    });
  });

  it('is byte-identical across runs', async () => {
    const again = await sampleResult();
    expect(jsonReportText(again, SAMPLE_CONTEXT)).toBe(jsonReportText(result, SAMPLE_CONTEXT));
  });
});

describe('sarif', () => {
  it('matches the snapshot', async () => {
    await expect(sarifReportText(result, SAMPLE_CONTEXT)).toMatchFileSnapshot(snap('report.sarif'));
  });

  it('validates against the pinned SARIF 2.1.0 schema', () => {
    const validate = sarifValidator();
    validate(sarifReport(result, SAMPLE_CONTEXT));
    expect(validate.errors ?? []).toEqual([]);
  });

  it('follows GitHub’s rules: one run, one location, utf16 columns, no fingerprints', () => {
    const log = sarifReport(result, SAMPLE_CONTEXT);
    expect(log.runs).toHaveLength(1);
    const run = log.runs[0];
    expect(run?.columnKind).toBe('utf16CodeUnits');
    // upload-sarif sets the category; one in the file would override its `category` input.
    expect(run?.automationDetails).toBeUndefined();
    expect(run?.tool.driver.rules?.map((r) => r.id)).toEqual(RULES.map((r) => `sunset/${r.id}`));
    for (const r of run?.results ?? []) {
      expect(r.locations).toHaveLength(1);
      expect(r.partialFingerprints).toBeUndefined();
      expect(r.locations?.[0]?.physicalLocation?.artifactLocation?.uri).not.toMatch(/^\/|:\/\//);
      expect(run?.tool.driver.rules?.[r.ruleIndex as number]?.id).toBe(r.ruleId);
    }
    // Docs mentions are never results; diagnostics are tool notifications.
    expect(run?.results).toHaveLength(result.findings.length + result.unresolved.length);
    expect(run?.invocations?.[0]?.toolConfigurationNotifications).toHaveLength(2);
  });

  it(`keeps the ${SARIF_MAX_RESULTS.toLocaleString('en-US')} most severe results and says so`, () => {
    const big = manyFindings(result, SARIF_MAX_RESULTS + 300);
    const log = sarifReport(big, SAMPLE_CONTEXT);
    const run = log.runs[0];
    expect(run?.results).toHaveLength(SARIF_MAX_RESULTS);
    // 25,300 cycle notice, warning, error: the 300 dropped are all notices.
    expect(run?.results?.filter((r) => r.level === 'note')).toHaveLength(8_434 - 300);
    expect(run?.invocations?.[0]?.toolExecutionNotifications?.[0]?.message.text).toContain(
      'only the 25000 most severe',
    );
    const text = sarifReportText(big, SAMPLE_CONTEXT);
    expect(gzipSync(text).length).toBeLessThan(10 * 1024 * 1024);
  });

  it('keeps every result at the limit', () => {
    const log = sarifReport(manyFindings(result, SARIF_MAX_RESULTS), SAMPLE_CONTEXT);
    expect(log.runs[0]?.results).toHaveLength(SARIF_MAX_RESULTS);
    expect(log.runs[0]?.invocations?.[0]?.toolExecutionNotifications).toEqual([]);
  });
});

describe('annotations', () => {
  it('matches the snapshot', async () => {
    await expect(`${JSON.stringify(annotations(result), null, 2)}\n`).toMatchFileSnapshot(
      snap('annotations.json'),
    );
  });

  it('never annotates docs mentions', () => {
    expect(annotations(result).some((a) => a.file?.startsWith('docs/'))).toBe(false);
  });

  it('leaves one slot per level for the Action, most severe first, then points to the summary', () => {
    const out = annotations(manyFindings(result, 100));
    const count = (level: string) => out.filter((a) => a.level === level).length;
    // GitHub shows 10 per level; the Action's own failure, warning or notice takes the 10th.
    expect([count('error'), count('warning'), count('notice')]).toEqual([9, 9, 9]);
    expect(out.map((a) => a.level).slice(0, 3)).toEqual(['error', 'error', 'error']);
    const last = out.at(-1);
    expect(last?.file).toBeUndefined();
    expect(last?.message).toBe(
      '74 more findings are not annotated, because GitHub shows at most 10 annotations per level. See the job summary for the full list.',
    );
  });

  it('adds no pointer when everything fits', () => {
    const out = annotations(manyFindings(result, 27));
    expect(out).toHaveLength(27);
    expect(out.every((a) => a.file)).toBe(true);
  });

  it('sets columns only on single-line annotations', () => {
    const base = manyFindings(result, 1);
    const f = base.findings[0];
    if (!f) throw new Error('no finding');
    const multi = {
      ...base,
      findings: [{ ...f, location: { ...f.location, endLine: f.location.line + 1 } }],
    };
    expect(annotations(multi)[0]).not.toHaveProperty('startColumn');
    expect(annotations(base)[0]).toHaveProperty('startColumn', 5);
  });
});

describe('summary', () => {
  it('matches the snapshot', async () => {
    await expect(summaryMarkdown(result, LINKED_CONTEXT)).toMatchFileSnapshot(snap('summary.md'));
  });

  it('says so when nothing was found', () => {
    const md = summaryMarkdown(manyFindings(result, 0), SAMPLE_CONTEXT);
    expect(md).toContain('No deprecated, retiring or retired models were found.');
    expect(md).not.toContain('<details>');
  });

  it('stays under 1 MiB, dropping the least important rows first', () => {
    const big = manyFindings(result, 30_000);
    const withExtras: ScanResult = {
      ...big,
      // One row per finding (each has its own model ID), plus a long inventory.
      inventory: Array.from({ length: 20_000 }, (_, i) => ({
        modelId: `gpt-9-unknown-${i}`,
        locations: [big.findings[i % 1000]?.location ?? (big.findings[0]?.location as never)],
      })),
    };
    const md = summaryMarkdown(withExtras, SAMPLE_CONTEXT);
    expect(bytes(md)).toBeLessThanOrEqual(SUMMARY_LIMIT_BYTES);
    expect(bytes(md)).toBeGreaterThan(SUMMARY_LIMIT_BYTES - 64 * 1024);
    expect(md).toContain("This summary was shortened to fit GitHub's 1,024 KiB limit.");
    expect(md).toContain('| _…and 20,000 more, not shown_ |');
    expect(md).toMatch(
      /\| _…and [\d,]+ more, not shown_ \|\n\n<details>\n<summary>Not in the registry/,
    );
    expect(md).toMatch(/<sub>sunset 1\.2\.3 · .*<\/sub>\n$/);
  });

  it('respects a smaller limit', () => {
    const md = summaryMarkdown(result, SAMPLE_CONTEXT, { maxBytes: 3000 });
    expect(bytes(md)).toBeLessThanOrEqual(3000);
    expect(md).toContain('### Findings');
  });

  it('groups findings of one model into one row', () => {
    const md = summaryMarkdown(result, SAMPLE_CONTEXT);
    const row = md.split('\n').find((l) => l.includes('`gpt-fixture-retired` (openai)'));
    expect(row).toContain('`src/client.ts:2`, `src/client.ts:10`, `src/client.ts:11`');
  });
});

describe('pr comment', () => {
  const delta = (r: ScanResult) => ({
    findings: r.findings.filter((f) => f.location.path === 'src/client.ts'),
    unresolved: r.unresolved,
  });

  it('matches the snapshot', async () => {
    await expect(
      prCommentBody(delta(result), result, LINKED_CONTEXT, {
        summaryUrl: 'https://github.com/o/r/actions/runs/1',
      }),
    ).toMatchFileSnapshot(snap('pr-comment.md'));
  });

  it('explains a failure caused by findings that were already there', async () => {
    const existing = result.findings.filter((f) => f.location.path !== 'src/client.ts');
    const body = prCommentBody({ findings: [], unresolved: [] }, result, LINKED_CONTEXT, {
      summaryUrl: 'https://github.com/o/r/actions/runs/1',
      existing: { findings: existing, failOn: 'warning', blocking: true },
    });
    await expect(body).toMatchFileSnapshot(snap('pr-comment-existing.md'));
    expect(body).toContain(
      `### Sunset: no new findings, but ${existing.length} existing findings fail this check`,
    );
    expect(body).toContain('#### Why this check fails:');
  });

  it("lists existing findings collapsed when they don't fail the check", () => {
    const [one] = result.findings;
    const body = prCommentBody({ findings: [], unresolved: [] }, result, SAMPLE_CONTEXT, {
      existing: { findings: one ? [one] : [], failOn: 'error', blocking: false },
    });
    expect(body).toContain('### Sunset: no new findings\n');
    expect(body).toContain(
      "<summary>1 existing finding at or above `fail-on: error`, which don't fail this check (fail-scope: new)</summary>",
    );
    expect(body).not.toContain('Why this check fails');
  });

  it('caps the existing list and drops it first when the comment is too long', () => {
    const big = manyFindings(result, 3_000);
    const existing = { findings: big.findings, failOn: 'warning' as const, blocking: true };
    const short = prCommentBody({ findings: [], unresolved: [] }, big, SAMPLE_CONTEXT, {
      existing,
    });
    expect(short.match(/^\| (\*\*error\*\*|warning|notice) \|/gm)).toHaveLength(EXISTING_ROWS);
    expect(short).toMatch(/…and [\d,]+ more in the job summary\./);
    expect(short).toContain('fail this check');

    const body = prCommentBody(
      { findings: big.findings.slice(0, 2_000), unresolved: [] },
      big,
      SAMPLE_CONTEXT,
      { existing, maxChars: 20_000 },
    );
    expect(body.length).toBeLessThanOrEqual(20_000);
    // Rows go first; the explanation stays.
    expect(body).toContain('Why this check fails');
    expect(body).toMatch(/[\d,]+ more items didn't fit in this comment\./);
    expect(body).toContain('but 3,');

    // Existing rows that don't fit are counted once, by "…and N more", not again as items.
    const onlyExisting = prCommentBody({ findings: [], unresolved: [] }, big, SAMPLE_CONTEXT, {
      existing,
      maxChars: 2_000,
    });
    const rows = onlyExisting.match(/^\| \*\*error\*\* \|/gm)?.length ?? 0;
    expect(onlyExisting).toContain(
      `…and ${(3_000 - rows).toLocaleString('en-US')} more in the job summary.`,
    );
    expect(onlyExisting).not.toContain("didn't fit in this comment");
  });

  it('starts with the hidden marker, also when nothing is new', () => {
    const body = prCommentBody({ findings: [], unresolved: [] }, result, SAMPLE_CONTEXT);
    expect(body.startsWith(`${PR_COMMENT_MARKER}\n### Sunset: no new findings\n`)).toBe(true);
    expect(PR_COMMENT_MARKER).toBe('<!-- sunset:pr-comment -->');
  });

  it(`stays within ${PR_COMMENT_LIMIT.toLocaleString('en-US')} characters and points to the summary`, () => {
    const big = manyFindings(result, 5_000);
    const body = prCommentBody({ findings: big.findings, unresolved: [] }, big, SAMPLE_CONTEXT, {
      summaryUrl: 'https://github.com/o/r/actions/runs/1',
    });
    expect(body.length).toBeLessThanOrEqual(PR_COMMENT_LIMIT);
    expect(body.length).toBeGreaterThan(PR_COMMENT_LIMIT - 2_000);
    expect(body).toMatch(
      /[\d,]+ more items didn't fit in this comment\. See the \[job summary\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/1\)\./,
    );
    // The most severe are kept.
    const levels = body.match(/^\| (\*\*error\*\*|warning|notice) \|/gm) ?? [];
    expect(levels[0]).toBe('| **error** |');
    expect(levels).not.toContain('| notice |');
  });

  describe('stays within the limit with the notes that dropped rows bring in', () => {
    const summaryUrl =
      'https://github.com/owner/repository-name/actions/runs/12345678901/attempts/2';
    const finding = (i: number, length: number): Finding => {
      const [first] = result.findings as [Finding];
      return {
        ...first,
        severity: 'error',
        location: { ...first.location, path: `src/f${i}.ts`, line: i + 1 },
        message: 'x'.repeat(length),
      };
    };
    const unresolvedRef = (i: number, length: number): UnresolvedReference => {
      const [first] = result.unresolved as [UnresolvedReference];
      return {
        ...first,
        location: { ...first.location, path: `src/u${i}.ts` },
        message: 'y'.repeat(length),
      };
    };
    const body = (
      existing: number,
      added: number,
      unresolved: number,
      length: number,
      max?: number,
    ) =>
      prCommentBody(
        {
          findings: Array.from({ length: added }, (_, i) => finding(1_000 + i, length)),
          unresolved: Array.from({ length: unresolved }, (_, i) => unresolvedRef(i, length)),
        },
        result,
        SAMPLE_CONTEXT,
        {
          existing: {
            findings: Array.from({ length: existing }, (_, i) => finding(i, length)),
            failOn: 'error',
            blocking: true,
          },
          summaryUrl,
          ...(max !== undefined && { maxChars: max }),
        },
      );

    it(`at ${PR_COMMENT_LIMIT.toLocaleString('en-US')} characters`, () => {
      // Dropping the one existing row adds "…and 1 more in the job summary." with the link.
      expect(body(1, 384, 0, 198).length).toBeLessThanOrEqual(PR_COMMENT_LIMIT);
    });

    it('over a sweep of sizes', () => {
      // From about twice the text that is always there (the headline, the explanation, the
      // footer), so that some rows always fit.
      for (const existing of [0, 1, EXISTING_ROWS, EXISTING_ROWS + 1])
        for (const added of [0, 1, 40])
          for (const unresolved of [0, 1, 25])
            for (const length of [60, 198])
              for (let max = 2_000; max <= 12_000; max += 389) {
                const text = body(existing, added, unresolved, length, max);
                const where = `${existing} existing, ${added} new, ${unresolved} unresolved, messages of ${length}, max ${max}`;
                expect(text.length, where).toBeLessThanOrEqual(max);
                if (existing + added + unresolved > 0) {
                  expect(text, where).toMatch(/^\| (\*\*error\*\*|`src\/u)/m);
                }
              }
    });
  });
});

describe('markdown escaping', () => {
  it('keeps code spans intact', () => {
    expect(code('a`b')).toBe('``a`b``');
    expect(code('`x`')).toBe('`` `x` ``');
    expect(code('a|b')).toBe('`a\\|b`');
    expect(code('a|b', false)).toBe('`a|b`');
  });

  /** The text GitHub reads as Markdown: everything outside code spans. */
  const outsideCode = (md: string): string => md.replace(/(`+)[\s\S]*?\1/g, ' ');

  it('turns no text from code or the registry into a link, an image, a mention or HTML', () => {
    const attacks = [
      // An expression from the scanned code, in an unresolved reference's message.
      '`model` comes from the environment (os.environ["@octocat ![x](https://evil.example/p.png)"]).',
      // A replacement ID from a tampered registry, in a finding's message.
      'gpt-4.5-preview (openai) was retired on 2025-07-14. Recommended replacement: [gpt-4.1](https://evil.example/migrate)![ok](https://evil.example/ok.png)@octocat (openai).',
      // Backticks meant to end Sunset's own code span early.
      '`model` is set from x``` @octocat <img src=x> www.evil.example a@b.example &#64;team.',
      '[click\nhere](https://evil.example) <script>alert(1)</script> \\@octocat',
    ];
    for (const text of attacks) {
      const md = outsideCode(cell(text));
      expect(md, text).not.toMatch(/@|\]\(|<|>|:\/\/|www\.|&/);
    }
  });

  it('keeps the summary and the PR comment safe from a tampered registry and hostile code', async () => {
    const hostile =
      '[gpt-4.1](https://evil.example/migrate)![ok](https://evil.example/ok.png)@octocat';
    const retired = fixtureRegistry.models[0] as RegistryEntry;
    const tampered: Registry = {
      ...fixtureRegistry,
      models: [
        {
          ...retired,
          recommended_replacements: [{ model_id: hostile, platform: 'openai' }],
          version: null,
        },
        ...fixtureRegistry.models.slice(1),
      ],
    };
    const scanned = await scanFiles(
      {
        'a.py':
          'M = "gpt-fixture-retired"\nclient.create(model=os.environ["@octocat ![x](https://evil.example/p.png)"])\n',
      },
      { registry: tampered },
    );
    const outputs = [
      summaryMarkdown(scanned, SAMPLE_CONTEXT),
      prCommentBody(
        { findings: scanned.findings, unresolved: scanned.unresolved },
        scanned,
        SAMPLE_CONTEXT,
      ),
    ];
    for (const md of outputs) {
      expect(md).toContain('evil.example');
      expect(outsideCode(md)).not.toMatch(/@octocat|\]\(https|evil\.example/);
    }
  });

  it('changes plain words only to escape pipes', () => {
    expect(cell('gpt-fixture-3 (openai)  retires on\n2099-12-31 | `platforms`.')).toBe(
      'gpt-fixture-3 (openai) retires on 2099-12-31 \\| `platforms`.',
    );
    expect(cell('(os.environ["M"]).')).toBe('(`os.environ["M"]`).');
    expect(cell('claude-3-haiku@20240307 a|b@c')).toBe('`claude-3-haiku@20240307` `a\\|b@c`');
  });
});

describe('rules', () => {
  const doc = readFileSync(`${root}docs/rules.md`, 'utf8');

  it('are each documented in docs/rules.md, where helpUri points', () => {
    for (const rule of RULES) {
      expect(doc).toContain(`## ${rule.id}\n`);
      expect(doc).toContain(`[\`sunset/${rule.id}\`](#${rule.id})`);
    }
  });

  it('cover every rule ID the scanner can emit', () => {
    const ids: Record<RuleId, true> = {
      'model-retired': true,
      'model-retiring': true,
      'model-deprecated': true,
      'model-unverified': true,
      'model-legacy': true,
      'model-reference-unresolved': true,
      'model-id-unknown': true,
      'suppression-expired': true,
    };
    expect(RULES.map((r) => r.id).sort()).toEqual(Object.keys(ids).sort());
  });
});

describe('terminal safety', () => {
  it('shows control and bidi characters from the repository as escapes', () => {
    expect(printable('a\u001b[2Jb\nc\u202ed\u0085e')).toBe('a\\u001b[2Jb\\u000ac\\u202ed\\u0085e');
    expect(printable('gpt-4o · Ünïcödé → ok')).toBe('gpt-4o · Ünïcödé → ok');
    // For messages that span lines: the line breaks stay, a lone carriage return doesn't.
    expect(printableLines('a:\r\n  - \u001b]52;c;eA==\u0007\n  - b\rc')).toBe(
      'a:\n  - \\u001b]52;c;eA==\\u0007\n  - b\\u000dc',
    );
  });

  it('escapes what a runner would read as a workflow command', () => {
    expect(printable('::warning::x')).toBe('\\u003a:warning::x');
    expect(printable('  ::error file=a::b')).toBe('  \\u003a:error file=a::b');
    expect(printable('see ##[error]x/a.py')).toBe('see ##\\u005berror]x/a.py');
    expect(printableLines('key\n::warning::x')).toBe('key\n\\u003a:warning::x');
    // Only at the start: `std::env` and `a::b` stay. Escaping twice changes nothing.
    expect(printable('std::env')).toBe('std::env');
    const once = printable('::x ##[y]');
    expect(printable(once)).toBe(once);
  });

  it('applies it to paths and messages in the text report', async () => {
    const result = await sampleResult();
    const [first, ...rest] = result.findings;
    if (!first) throw new Error('no findings in the sample');
    const evil = {
      ...first,
      location: { ...first.location, path: 'evil\u001b]52;c;Y3VybA==\u0007.py' },
      message: `${first.message}\u001b[2J`,
    };
    const text = textReport({ ...result, findings: [evil, ...rest] }, SAMPLE_CONTEXT);
    // Only line breaks are left.
    const controls = [...text].filter((c) => c !== '\n' && (c.codePointAt(0) as number) < 0x20);
    expect(controls).toEqual([]);
    expect(text).toContain('evil\\u001b]52;c;Y3VybA==\\u0007.py');
  });
});
