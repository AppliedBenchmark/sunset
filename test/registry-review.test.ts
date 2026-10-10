// The registry review table, and `npm run registry:validate` as the workflow runs it.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { computeEntryId } from '../src/core/registry/validate.ts';
import type { IsoDate, Registry, RegistryEntry } from '../src/core/types.ts';
import { diffRegistries, registryReviewMarkdown } from '../src/report/registry-review.ts';
import { fixtureRegistry, root } from './helpers.ts';

const [a, b, c] = fixtureRegistry.models as [RegistryEntry, RegistryEntry, RegistryEntry];
const reg = (...models: RegistryEntry[]): Registry => ({ ...fixtureRegistry, models });

describe('diffRegistries', () => {
  it('finds added, changed and removed entries by id', () => {
    const changedB = { ...b, notes: 'changed' };
    expect(diffRegistries(reg(a, b), reg(changedB, c))).toEqual({
      added: [c],
      changed: [{ before: b, after: changedB }],
      removed: [a],
    });
  });

  it('treats every entry as added without a base', () => {
    expect(diffRegistries(null, reg(a)).added).toEqual([a]);
  });
});

describe('registryReviewMarkdown', () => {
  it('shows dates, replacements, the excerpt and the source', () => {
    const entry: RegistryEntry = {
      ...a,
      retirement_date_qualifier: 'no_earlier_than',
      source_excerpt: '| Jan 6, 2027 | `x` |',
      recommended_replacements: [
        { model_id: 'y', platform: a.platform },
        { model_id: 'z', platform: 'vertex' },
      ],
      drop_in: true,
    };
    const md = registryReviewMarkdown({ added: [entry], changed: [], removed: [b] });
    expect(md).toContain('1 added, 0 changed, 1 removed.');
    expect(md).toContain(
      `| added | \`${a.id}\` | ${a.status} | ${a.deprecation_date} | ${a.retirement_date} (no earlier than) | \`y\`, \`z\` (vertex) (drop-in) | \`\`\\| Jan 6, 2027 \\| \`x\` \\|\`\` | [${a.source}](${a.source_url}) |`,
    );
    expect(md).toContain(`### Removed\n\n- \`${b.id}\``);
  });

  it('shows a changed value as old → new', () => {
    const before: RegistryEntry = { ...a, status: 'active', retirement_date: null };
    const after: RegistryEntry = {
      ...a,
      status: 'deprecated',
      retirement_date: '2027-05-03' as IsoDate,
      retirement_date_qualifier: 'exact',
    };
    const md = registryReviewMarkdown({ added: [], changed: [{ before, after }], removed: [] });
    expect(md).toContain(
      `| changed | \`${a.id}\` | active → deprecated | ${a.deprecation_date ?? ''} | _none_ → 2027-05-03 |`,
    );
  });

  it('shows an excerpt literally, so its Markdown and mentions do nothing', () => {
    const entry = { ...a, source_excerpt: 'cc @octocat: see [docs](https://evil.example)' };
    expect(registryReviewMarkdown({ added: [entry], changed: [], removed: [] })).toContain(
      '| `cc @octocat: see [docs](https://evil.example)` |',
    );
  });

  it('omits the table when nothing was added or changed', () => {
    expect(registryReviewMarkdown({ added: [], changed: [], removed: [] })).toBe(
      '## Registry review\n\n0 added, 0 changed, 0 removed. Check every value against its excerpt.\n',
    );
  });
});

// The script is TypeScript, which Node runs as is from 22.18 (and 23.6); on older 22.x releases,
// which CI also tests, only the bundled CLI and Action run.
describe.skipIf(!process.features.typescript)('npm run registry:validate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sunset-validate-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const validate = (args: string[]) => {
    const summary = join(dir, 'summary.md');
    writeFileSync(summary, '');
    const result = spawnSync(process.execPath, ['scripts/validate-registry.ts', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary },
    });
    return { ...result, summary: readFileSync(summary, 'utf8') };
  };

  // Each runs the script in a child process, which is slow on a busy runner.
  it('writes the review table only against a base', () => {
    expect(validate([]).summary).toBe('');
    const base = join(dir, 'base.yaml');
    writeFileSync(base, readFileSync(join(root, 'registry/models.yaml')));
    expect(validate(['--base', base]).summary).toContain(
      '0 added, 0 changed, 0 removed. Check every value against its excerpt.',
    );
  }, 30_000);

  it('fails when a release bundling the base could no longer use the registry', () => {
    // In the base, `claude-sonnet-4-5` is an entry of its own; here it is an alias. A release with
    // the base bundled keeps that entry, which then collides with the alias.
    const current = parse(readFileSync(join(root, 'registry/models.yaml'), 'utf8')) as Registry;
    const aliased = current.models.find((m) => m.aliases.includes('claude-sonnet-4-5'));
    if (!aliased) throw new Error('the registry no longer has the alias this test uses');
    const models = current.models.map((m) =>
      m === aliased ? { ...m, aliases: m.aliases.filter((a) => a !== 'claude-sonnet-4-5') } : m,
    );
    const own = { ...aliased, model_id: 'claude-sonnet-4-5', aliases: [] };
    models.push({ ...own, id: computeEntryId(own) });
    const base = join(dir, 'base.yaml');
    writeFileSync(base, stringify({ ...current, models }));
    const { stdout, status } = validate(['--base', base]);
    expect(status).toBe(1);
    expect(stdout).toMatch(
      /a release whose bundled registry is the base branch's couldn't use this one: .*claude-sonnet-4-5/,
    );
  }, 30_000);

  it('escapes annotation properties, such as the colon in an entry id', () => {
    // As of 2000, every entry's verified_on is in the future: an error for each, whatever the
    // registry holds.
    const { stdout, status } = validate(['--today', '2000-01-01']);
    expect(status).toBe(1);
    const annotation = stdout.split('\n').find((line) => line.startsWith('::error '));
    // `title=openai:ada` would end the properties at the colon.
    expect(annotation).toMatch(/^::error title=[a-z-]+%3A[^:,]+,file=registry\/models\.yaml::/);
  }, 30_000);
});
