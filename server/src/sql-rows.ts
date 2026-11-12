export type Row = Record<string, unknown>;

export function str(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Colonne ${key} inattendue`);
  return value;
}

export function strOrNull(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`Colonne ${key} inattendue`);
  return value;
}

export function int(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`Colonne ${key} inattendue`);
}

export function oneOf<T extends string>(row: Row, key: string, values: readonly T[]): T {
  const value = str(row, key);
  const found = values.find(candidate => candidate === value);
  if (found === undefined) throw new Error(`Valeur ${key} inattendue`);
  return found;
}

export function oneOfOrNull<T extends string>(row: Row, key: string, values: readonly T[]): T | null {
  return row[key] === null ? null : oneOf(row, key, values);
}
