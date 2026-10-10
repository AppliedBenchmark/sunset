/** `table[key]` for the table's own keys only: a plain object also inherits `constructor`, `toString`, … */
export function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
