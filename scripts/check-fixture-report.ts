// Compares a JSON report from the Action with a fixture repo's expected.json, so the
// self-test workflow checks the bundled Action against the same expectations as the unit tests.
//
//   node scripts/check-fixture-report.ts <fixture dir> <report.json>
//
// Findings must match exactly (location, severity, rule, model); unresolved references, mentions
// and suppressions are compared by location. The Action reports paths from the repository root,
// so the fixture directory is stripped from them first.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [fixture, reportPath] = process.argv.slice(2);
if (!fixture || !reportPath) {
  console.error('usage: node scripts/check-fixture-report.ts <fixture dir> <report.json>');
  process.exit(2);
}

interface Located {
  location: { path: string; line: number; column: number };
}
interface Report {
  findings: (Located & { severity: string; rule: string; model_id: string })[];
  unresolved: Located[];
  mentions: Located[];
  suppressed: Located[];
}
type Expected = Record<'findings' | 'unresolved' | 'mentions' | 'suppressed', string[]>;

const expected = JSON.parse(readFileSync(join(fixture, 'expected.json'), 'utf8')) as Expected;
const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report;
const prefix = `${fixture.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/?$/, '/')}`;
const at = ({ location: l }: Located) =>
  `${l.path.startsWith(prefix) ? l.path.slice(prefix.length) : l.path}:${l.line}:${l.column}`;
const firstWords = (n: number) => (line: string) => line.split(' ').slice(0, n).join(' ');

const checks: [string, string[], string[]][] = [
  [
    'findings',
    expected.findings.map(firstWords(4)),
    report.findings.map(
      (f) => `${at(f)} ${f.severity} ${f.rule.replace(/^sunset\//, '')} ${f.model_id}`,
    ),
  ],
  ['unresolved', expected.unresolved.map(firstWords(1)), report.unresolved.map(at)],
  ['mentions', expected.mentions.map(firstWords(1)), report.mentions.map(at)],
  ['suppressed', expected.suppressed.map(firstWords(1)), report.suppressed.map(at)],
];

/** A workflow command property value, escaped as @actions/core escapes it. */
const property = (value: string): string =>
  value
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C');

let failed = false;
for (const [name, want, got] of checks) {
  const missing = want.filter((x) => !got.includes(x));
  const extra = got.filter((x) => !want.includes(x));
  if (missing.length === 0 && extra.length === 0 && want.length === got.length) continue;
  failed = true;
  console.log(`::error title=${property(fixture)}::${name} differ from expected.json`);
  for (const m of missing) console.log(`  missing: ${m}`);
  for (const e of extra) console.log(`  extra:   ${e}`);
}
console.log(`${fixture}: ${failed ? 'MISMATCH' : 'ok'} (${report.findings.length} findings)`);
process.exitCode = failed ? 1 : 0;
