// PR and issue text: titles, the re-verified summary, page text shown literally, and truncation
// below GitHub's limit.
import { describe, expect, it } from 'vitest';
import type { IsoDate, RegistryEntry, Source } from '../../src/core/types.ts';
import type { Change } from '../../updater/merge.ts';
import { issueBody, prBody, prTitle, snapshotDiff } from '../../updater/proposal.ts';
import type { ProviderRun } from '../../updater/update.ts';

const TODAY = '2026-10-08' as IsoDate;
const source = { id: 'openai/deprecations', url: 'https://x/deprecations', parser: 'p' } as Source;
const entry = {
  id: 'openai:gpt-a',
  source: 'openai/deprecations',
  source_url: source.url,
  source_excerpt: '| a |',
  status: 'deprecated',
  deprecation_date: null,
  retirement_date: '2026-12-01',
  retirement_date_qualifier: 'exact',
  recommended_replacements: [],
} as unknown as RegistryEntry;

function run(changes: Change[], text: string | null = null): ProviderRun {
  return {
    provider: 'openai',
    sources: [
      {
        source,
        previous:
          text === null ? null : { page: { text: 'old\n', row_classes: {} }, meta: {} as never },
        changed:
          text === null
            ? null
            : { text, row_classes: {}, urls: [], etag: null, last_modified: null },
        merge: { source, changes, missing: [], rejected: [], problems: [], unreviewed: [] },
        failure: null,
      },
    ],
  };
}

const change = (kind: Change['kind']): Change => ({
  kind,
  before: entry,
  after: entry,
  fields: [],
});

describe('prTitle and prBody', () => {
  it('names what changed', () => {
    expect(prTitle(run([change('added'), change('updated'), change('excerpt')]))).toBe(
      'chore(registry): update openai (1 new, 2 changed)',
    );
    expect(prTitle(run([change('reverified')]))).toBe(
      'chore(registry): update openai (re-verified)',
    );
    expect(prTitle(run([], 'new\n'))).toBe('chore(registry): update openai (snapshots only)');
  });

  it('summarizes re-verified entries in one line', () => {
    const body = prBody(run([change('reverified'), change('reverified')]), TODAY, null);
    expect(body).toContain('2 entries are unchanged and still on the page');
    expect(body).not.toContain('| reverified |');
  });

  it('lists the rows the HTML page marks differently, which the snapshot diff cannot show', () => {
    const changed = run([change('updated')], 'old\n');
    const [s] = changed.sources;
    if (!s?.previous || !s.changed) throw new Error('no snapshot');
    s.previous.page.row_classes = { 'row-gray': ['gemini-a', 'gemini-b'] };
    s.changed.row_classes = { 'row-gray': ['gemini-b', 'gemini-c'] };
    const body = prBody(changed, TODAY, null);
    expect(body).toContain(
      'Rows marked on the HTML page of `openai/deprecations`:\n\n- `row-gray` added: `gemini-c`\n- `row-gray` removed: `gemini-a`',
    );
    // The text didn't change, so there is no empty diff.
    expect(body).not.toContain('Snapshot diff');
  });

  it('shows page text literally, in code spans and code blocks the text cannot close', () => {
    const hostile =
      'Hi @octocat, see #1 and [this](https://evil.example) ![x](https://evil.example/x.png)';
    const excerpt = `| a | \`\`\`\n${hostile}\n\`\`\` |`;
    const after = {
      ...entry,
      source_excerpt: excerpt,
      recommended_replacements: [{ model_id: 'gpt-|b', platform: 'openai' }],
    } as RegistryEntry;
    const updated: Change = {
      kind: 'updated',
      before: entry,
      after,
      fields: ['recommended_replacements'],
    };
    const body = prBody(run([updated], `new ${hostile}\n\`\`\`\`\`\n`), TODAY, null);
    // A table cell: pipes escaped inside the code span.
    expect(body).toContain(
      '| updated | `openai:gpt-a` | recommended_replacements: none → `gpt-\\|b` |',
    );
    expect(body).toContain(`\`\`\`\`text\n${excerpt}\n\`\`\`\``);
    // The diff has a run of five backticks, so its fence has six.
    expect(body).toContain('``````diff\n--- a/openai/deprecations.txt\n');
    // Outside code, the text appears nowhere.
    const outside = body.replace(/(`{3,})[^\n]*\n[\s\S]*?\n\1/g, '');
    expect(outside).not.toContain('@octocat');
  });

  it('shows parser messages and unreviewed excerpts literally in the issue', () => {
    const failed = run([]);
    const [s] = failed.sources;
    if (!s?.merge) throw new Error('no merge');
    s.failure = { kind: 'parse', details: ['unrecognized date "@octocat" in: | @octocat |'] };
    s.merge.unreviewed = [
      {
        platform: 'deepseek',
        provider: 'deepseek',
        model_id: 'deepseek-x',
        version: null,
        regions: null,
        state: 'unverified',
        deprecation: null,
        retirement: null,
        qualifier: 'exact',
        replacements: [],
        excerpt: 'Ping @octocat about [deepseek-x](https://evil.example).',
        notes: null,
      },
    ];
    const body = issueBody(failed, TODAY, null)?.body ?? '';
    expect(body).toContain('```text\nunrecognized date "@octocat" in: | @octocat |\n```');
    expect(body).toContain(
      '- `deepseek-x`: `Ping @octocat about [deepseek-x](https://evil.example).`',
    );
  });

  it('truncates long snapshot diffs and keeps the body under the limit', () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    expect(snapshotDiff('openai/deprecations', '', big)).toMatch(
      /… \(truncated; see the snapshot file\)$/,
    );
    const many = Array.from({ length: 2000 }, () => change('added'));
    const body = prBody(run(many, big), TODAY, null);
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain('(truncated');
  });

  it('cuts the body only between blocks, so no code block or details stay open', () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    // Enough excerpts that the snapshot diff, last in the body, crosses the limit.
    const excerpts = Array.from({ length: 200 }, () => ({
      ...change('added'),
      after: { ...entry, source_excerpt: 'y'.repeat(100) },
    }));
    const body = prBody(run(excerpts, big), TODAY, null);
    expect(body).toMatch(/\n\n… \(truncated: the full changes are in the diff\)\n$/);
    expect((body.match(/^```/gm)?.length ?? 0) % 2).toBe(0);
    expect(body).toContain('### Excerpts');
    expect(body.match(/<details>/g)?.length ?? 0).toBe(body.match(/<\/details>/g)?.length ?? 0);
  });
});
