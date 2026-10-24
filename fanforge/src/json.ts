/**
 * Tolerant JSON extraction.
 *
 * Local models are asked for JSON but they wrap it in prose, fence it, or trail
 * off mid-object. These helpers pull out the first usable JSON value and never
 * throw on malformed input.
 */

function scanBalanced(text: string, start: number): string | null {
  const openers: Record<string, string> = { '{': '}', '[': ']' };
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(openers[ch]);
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (stack.length === 0) return null;
      const expected = stack.pop();
      if (expected !== ch) return null;
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Extract the first JSON object/array from arbitrary model output. */
export function extractJson<T = unknown>(text: string): T | null {
  if (!text) return null;
  const trimmed = text.trim();

  // 1. whole string
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* continue */
  }

  // 2. fenced block
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fence) {
    const inner = fence[1].trim();
    try {
      return JSON.parse(inner) as T;
    } catch {
      const inner2 = extractJson<T>(inner);
      if (inner2) return inner2;
    }
  }

  // 3. first balanced value anywhere
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch !== '{' && ch !== '[') continue;
    const candidate = scanBalanced(trimmed, i);
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      /* try next start */
    }
  }
  return null;
}

/** Extract every JSON value in the text (used for lists of objects). */
export function extractJsonList<T = unknown>(text: string): T[] {
  const out: T[] = [];
  let rest = text ?? '';
  for (let guard = 0; guard < 500; guard++) {
    const idx = rest.search(/[{\[]/);
    if (idx < 0) break;
    const candidate = scanBalanced(rest, idx);
    if (!candidate) {
      rest = rest.slice(idx + 1);
      continue;
    }
    try {
      const parsed = JSON.parse(candidate);
      // A top-level array is a list of values, not a single value.
      if (Array.isArray(parsed)) out.push(...(parsed as T[]));
      else out.push(parsed as T);
    } catch {
      /* ignore */
    }
    rest = rest.slice(idx + candidate.length);
  }
  return out;
}

/** Coerce a loose value into an array of strings. */
export function toStringArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim()))
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return [];
    if (s.startsWith('[') || s.startsWith('{')) {
      const parsed = extractJson<unknown>(s);
      if (parsed !== null) return toStringArray(parsed);
    }
    return [s];
  }
  return [String(value)];
}

/**
 * Salvage the complete objects from a JSON array that was cut off.
 *
 * A model that runs out of tokens leaves a truncated array. The objects before
 * the cut are still good, and throwing them away loses real work.
 */
export function salvageJsonArray(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>);
        } catch {
          /* a broken object is skipped */
        }
        start = -1;
      }
    }
  }
  return out;
}

/** Coerce a value that should be a list of records into an array of records. */
export function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');
  }
  if (value && typeof value === 'object') return [value as Record<string, unknown>];
  return [];
}
