// Validates registry/ and, for a pull request, writes the review table of what it changes.
//
//   npm run registry:validate                          validate; exit 1 on errors
//   npm run registry:validate -- --base <models.yaml>  also review what changed since <base>, and
//                                                      check that a release bundling <base> can use it
//   npm run registry:validate -- --today 2026-10-08    fix the date for the verified_on check
//
// In GitHub Actions, issues become annotations and the review table goes to the job summary.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as core from '@actions/core';
import { parse } from 'yaml';
import { systemClock } from '../src/adapters/clock.ts';
import { validateRegistryDir } from '../src/adapters/registry-files.ts';
import { parseRegistry } from '../src/adapters/registry-source.ts';
import { parseIsoDate } from '../src/core/dates.ts';
import type { Registry } from '../src/core/types.ts';
import { plural } from '../src/report/common.ts';
import { diffRegistries, registryReviewMarkdown } from '../src/report/registry-review.ts';

const { values } = parseArgs({
  options: { base: { type: 'string' }, today: { type: 'string' } },
});

const today = values.today ? parseIsoDate(values.today) : systemClock.today();
if (!today) {
  console.error(`--today must be YYYY-MM-DD, got ${values.today}`);
  process.exit(2);
}

const dir = fileURLToPath(new URL('../registry', import.meta.url));
const report = await validateRegistryDir(dir, today);
const inActions = process.env.GITHUB_ACTIONS === 'true';

// Released versions read registry/models.yaml from main, adding the entries of their bundled copy
// that they can't read in it. A change that makes that fail (an entry turned into another one's
// alias, say) leaves every such release on its bundled copy, so it is an error here.
if (report.registry && values.base && existsSync(values.base)) {
  const base = parseRegistry(readFileSync(values.base, 'utf8'));
  if ('registry' in base) {
    const read = parseRegistry(readFileSync(`${dir}/models.yaml`, 'utf8'), {
      external: true,
      bundled: base.registry.models,
    });
    if ('problem' in read) {
      report.issues.push({
        level: 'error',
        file: 'models.yaml',
        subject: null,
        message: `a release whose bundled registry is the base branch's couldn't use this one: it is ${read.problem}. Within schema_version 1 the registry may only grow (docs/registry.md, "Changing the format").`,
      });
    }
  }
}

for (const issue of report.issues) {
  if (inActions) {
    // @actions/core escapes the message and properties, which can hold page text.
    const annotate = issue.level === 'error' ? core.error : core.warning;
    annotate(issue.message, { file: `registry/${issue.file}`, title: issue.subject ?? issue.file });
  } else {
    const where = `registry/${issue.file}${issue.subject ? ` ${issue.subject}` : ''}`;
    console.log(`${issue.level.padEnd(7)} ${where}: ${issue.message}`);
  }
}

const errors = report.issues.filter((i) => i.level === 'error').length;
const warnings = report.issues.length - errors;
const entries = report.registry?.models.length ?? 0;
console.log(
  `\n${plural(entries, 'entry', 'entries')}; ${plural(errors, 'error')}, ${plural(warnings, 'warning')}.`,
);

// Without a base there is nothing to compare with: a push to main would list every entry as added.
if (report.registry && values.base) {
  // A missing base file (models.yaml is new on this branch) means everything is new.
  const base = existsSync(values.base)
    ? (parse(readFileSync(values.base, 'utf8')) as Registry | null)
    : null;
  const review = registryReviewMarkdown(
    diffRegistries(base?.models ? base : null, report.registry),
  );
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, review);
  else console.log(`\n${review}`);
}

process.exitCode = errors ? 1 : 0;
