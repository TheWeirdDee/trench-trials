/**
 * Deterministic JSON serialization: object keys sorted recursively, arrays preserved
 * in order. Two calls with the same logical content always produce the same string,
 * which is required for the commitment hash to be reproducible by the verifier
 * (npm run verify, and the in-browser check at the verdict) independent of property
 * insertion order. No Node imports, so the browser can use it too.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
