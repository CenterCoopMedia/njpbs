function isHex(character: string | undefined): boolean {
  return character !== undefined && /[0-9a-f]/i.test(character);
}

function replacementForCodePoint(codePoint: number): string {
  if (
    codePoint === 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return "\uFFFD";
  }
  return String.fromCodePoint(codePoint);
}

/** Decode CSS escapes according to CSS Syntax §4.3.7. */
export function decodeCssText(value: string): string {
  let decoded = "";

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }

    const next = value[index + 1];
    if (next === undefined) continue;
    if (next === "\n" || next === "\f") {
      index += 1;
      continue;
    }
    if (next === "\r") {
      index += value[index + 2] === "\n" ? 2 : 1;
      continue;
    }

    if (isHex(next)) {
      let end = index + 1;
      while (end < value.length && end <= index + 6 && isHex(value[end])) {
        end += 1;
      }
      decoded += replacementForCodePoint(
        Number.parseInt(value.slice(index + 1, end), 16),
      );
      if (/\s/.test(value[end] ?? "")) end += 1;
      index = end - 1;
      continue;
    }

    decoded += next;
    index += 1;
  }

  return decoded;
}

export function stripCssComments(css: string): string {
  let output = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < css.length; index += 1) {
    const character = css[index];
    if (quote) {
      output += character;
      if (character === "\\" && index + 1 < css.length) {
        output += css[index + 1];
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      output += character;
      continue;
    }

    if (character === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      output += " ";
      index = end < 0 ? css.length : end + 1;
      continue;
    }

    output += character;
  }

  return output;
}

type CssString = { value: string; end: number };

function readCssString(source: string, start: number): CssString | null {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") return null;

  let raw = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === quote) {
      return { value: decodeCssText(raw), end: index + 1 };
    }
    if (character === "\\" && index + 1 < source.length) {
      raw += character + source[index + 1];
      index += 1;
      continue;
    }
    raw += character;
  }

  return null;
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (/\s/.test(source[index] ?? "")) index += 1;
  return index;
}

function identifierAt(source: string, start: number): { value: string; end: number } | null {
  const match = source.slice(start).match(/^[-_a-zA-Z][-_a-zA-Z0-9]*/);
  return match ? { value: match[0], end: start + match[0].length } : null;
}

function findMatchingParen(source: string, open: number): number | null {
  let depth = 1;
  let quote: '"' | "'" | null = null;

  for (let index = open + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return null;
}

function functionBodies(css: string, names: ReadonlySet<string>): string[] {
  const source = stripCssComments(css);
  const bodies: string[] = [];
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    const identifier = identifierAt(source, index);
    if (!identifier) continue;
    const open = skipWhitespace(source, identifier.end);
    if (source[open] !== "(") {
      index = identifier.end - 1;
      continue;
    }
    const close = findMatchingParen(source, open);
    if (close === null) break;
    if (names.has(identifier.value.toLowerCase())) {
      bodies.push(source.slice(open + 1, close));
    }
    // Do not skip the body: nested url() calls must also be discovered.
    index = identifier.end - 1;
  }

  return bodies;
}

function urlBodyValue(body: string): string | null {
  const start = skipWhitespace(body, 0);
  const quoted = readCssString(body, start);
  if (quoted) return quoted.value.trim();
  const raw = body.slice(start).trim();
  return raw ? decodeCssText(raw) : null;
}

function splitTopLevel(source: string): string[] {
  const values: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      values.push(source.slice(start, index));
      start = index + 1;
    }
  }
  values.push(source.slice(start));
  return values;
}

export function cssUrlValues(css: string): string[] {
  return functionBodies(css, new Set(["url"]))
    .map(urlBodyValue)
    .filter((value): value is string => value !== null);
}

export function cssImageSetValues(css: string): string[] {
  const values: string[] = [];
  for (const body of functionBodies(
    css,
    new Set(["image-set", "-webkit-image-set"]),
  )) {
    for (const option of splitTopLevel(body)) {
      const start = skipWhitespace(option, 0);
      const string = readCssString(option, start);
      if (string?.value.trim()) values.push(string.value.trim());
    }
  }
  return values;
}

export function cssImportValues(css: string): string[] {
  const source = stripCssComments(css);
  const values: string[] = [];
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character !== "@") continue;

    const identifier = identifierAt(source, index + 1);
    if (!identifier || identifier.value.toLowerCase() !== "import") continue;
    let cursor = skipWhitespace(source, identifier.end);
    const string = readCssString(source, cursor);
    if (string) {
      if (string.value.trim()) values.push(string.value.trim());
      index = string.end - 1;
      continue;
    }

    const functionName = identifierAt(source, cursor);
    if (!functionName || functionName.value.toLowerCase() !== "url") continue;
    cursor = skipWhitespace(source, functionName.end);
    if (source[cursor] !== "(") continue;
    const close = findMatchingParen(source, cursor);
    if (close === null) continue;
    const value = urlBodyValue(source.slice(cursor + 1, close));
    if (value) values.push(value);
    index = close;
  }

  return values;
}
