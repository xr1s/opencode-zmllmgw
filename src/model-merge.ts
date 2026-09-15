/** Merge one model overlay without mutating either input. */
export function mergeRecordOverlay(
  base: Record<string, unknown> | undefined,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base ?? {}))
    result[key] = cloneValue(value);

  for (const [key, value] of Object.entries(overlay)) {
    const current = result[key];
    if (isRecord(value) && isRecord(current)) {
      result[key] = mergeRecordOverlay(current, value);
    } else {
      result[key] = cloneValue(value);
    }
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isRecord(value)) return mergeRecordOverlay(undefined, value);
  return value;
}
