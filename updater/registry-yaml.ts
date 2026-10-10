// Writes registry/models.yaml in its committed layout, so an updater PR changes only the lines of
// the entries it touches. `formatRegistry(parse(file))` reproduces the file byte for byte
// (test/updater/registry-yaml.test.ts); a generic YAML dump would reformat all of it.
import type { Registry, RegistryEntry } from '../src/core/types.ts';

/**
 * A single-quoted YAML scalar, or a double-quoted one when the value has a line break or another
 * control character: single quotes can't escape those, and a raw line break doesn't parse back.
 * A JSON string is a valid double-quoted YAML scalar.
 */
function quote(value: string): string {
  const control = [...value].some((c) => (c.codePointAt(0) as number) < 0x20 || c === '\u007f');
  if (control) return JSON.stringify(value);
  return `'${value.replace(/'/g, "''")}'`;
}

const nullable = (value: string | null, format: (v: string) => string = quote) =>
  value === null ? 'null' : format(value);

function formatEntry(entry: RegistryEntry): string {
  const lines = [
    `- id: ${quote(entry.id)}`,
    `  provider: ${entry.provider}`,
    `  platform: ${entry.platform}`,
    `  model_id: ${quote(entry.model_id)}`,
    `  version: ${nullable(entry.version)}`,
  ];
  if (entry.regions !== undefined) {
    lines.push(
      `  regions: ${entry.regions === null ? 'null' : `[${entry.regions.map(quote).join(', ')}]`}`,
    );
  }
  lines.push(
    `  aliases: ${entry.aliases.length ? `[${entry.aliases.map(quote).join(', ')}]` : '[]'}`,
    `  status: ${entry.status}`,
    `  deprecation_date: ${nullable(entry.deprecation_date)}`,
    `  retirement_date: ${nullable(entry.retirement_date)}`,
    `  retirement_date_qualifier: ${entry.retirement_date_qualifier}`,
  );
  if (entry.recommended_replacements.length === 0) {
    lines.push('  recommended_replacements: []');
  } else {
    lines.push('  recommended_replacements:');
    for (const r of entry.recommended_replacements) {
      lines.push(`    - { model_id: ${quote(r.model_id)}, platform: ${r.platform} }`);
    }
  }
  lines.push(
    `  drop_in: ${entry.drop_in}`,
    `  source: ${entry.source}`,
    `  source_url: ${entry.source_url}`,
    `  source_excerpt: ${nullable(entry.source_excerpt)}`,
    `  verified_on: ${quote(entry.verified_on)}`,
    `  notes: ${nullable(entry.notes)}`,
  );
  return lines.join('\n');
}

/**
 * The file text for `registry`. `header` is the comment block the file starts with (kept from the
 * file being replaced).
 */
export function formatRegistry(registry: Registry, header: string): string {
  const parts = [
    header,
    `schema_version: ${registry.schema_version}`,
    `registry_version: ${registry.registry_version}`,
    `generated_at: ${quote(registry.generated_at)}`,
    registry.models.length ? 'models:' : 'models: []',
    ...registry.models.map(formatEntry),
  ];
  return `${parts.join('\n')}\n`;
}

/** The leading comment lines of a models.yaml file. */
export function headerOf(text: string): string {
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('#')) break;
    lines.push(line);
  }
  return lines.join('\n');
}
