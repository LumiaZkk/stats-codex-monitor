// Bounded JSON parser with duplicate-object-key rejection. No reviver or prototype writes.
export function parseStrictJson(text: string): unknown {
  let index = 0;
  const fail = (): never => { throw new Error('invalid_or_duplicate_json'); };
  const space = () => { while (/[\t\n\r ]/.test(text[index] ?? '') && index < text.length) index++; };
  const string = () => {
    const start = index; if (text[index++] !== '"') return fail();
    while (index < text.length) {
      const c = text[index++];
      if (c === '"') { try { return JSON.parse(text.slice(start,index)) as string; } catch { return fail(); } }
      if (c === '\\') index++;
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (depth > 32) fail(); space(); const c = text[index];
    if (c === '"') return string();
    if (c === '{') {
      index++; space(); const result: Record<string, unknown> = {}; const seen = new Set<string>();
      if (text[index] === '}') { index++; return result; }
      while (index < text.length) {
        space(); const key = string(); if (seen.has(key)) fail(); seen.add(key); space(); if (text[index++] !== ':') fail();
        Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true }); space(); const next = text[index++];
        if (next === '}') return result; if (next !== ',') fail();
      }
      return fail();
    }
    if (c === '[') {
      index++; space(); const result: unknown[] = [];
      if (text[index] === ']') { index++; return result; }
      while (index < text.length) {
        result.push(value(depth + 1)); space(); const next = text[index++];
        if (next === ']') return result; if (next !== ',') fail();
      }
      return fail();
    }
    const start = index; while (index < text.length && !/[\t\n\r ,\]}]/.test(text[index])) index++;
    if (start === index) fail();
    try { const parsed = JSON.parse(text.slice(start,index)); if (parsed !== null && typeof parsed !== 'boolean' && typeof parsed !== 'number') fail(); return parsed; } catch { return fail(); }
  };
  const parsed = value(0); space(); if (index !== text.length) fail(); return parsed;
}
