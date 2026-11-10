import type { Token } from "./TokenInput";

export interface TokenLimits {
  maxLength: number;
  maxCount?: number;
  /** Bulk editing: typing a tag that is already a mixed token puts it on every item. */
  promoteMixed?: boolean;
  /** Exact stored taxonomy, such as Home hero tags, can distinguish letter case. */
  caseSensitive?: boolean;
}

export interface AddResult {
  tokens: Token[];
  /** Tokens added, plus mixed tokens made solid. */
  accepted: number;
  /** Trimmed entries that were refused, in entry order, so the field can keep them. */
  rejected: string[];
  error: string;
}

export const tagKey = (value: string) => value.toLocaleLowerCase("en-US");

// Most tag fields refuse case variants; exact-taxonomy fields can keep both.
export function addTokens(tokens: Token[], values: string[], { maxCount, maxLength, promoteMixed = false, caseSensitive = false }: TokenLimits): AddResult {
  const key = caseSensitive ? (value: string) => value : tagKey;
  const next = [...tokens];
  const seen = new Set(next.map((token) => key(token.value)));
  const rejected: string[] = [];
  let error = "";
  let promoted = 0;
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const existing = next.find((token) => key(token.value) === key(value));
    if (promoteMixed) {
      // Prefer the exact spelling, since stored case variants can both be tokens.
      const exact = next.findIndex((token) => token.value === value);
      const index = exact >= 0 ? exact : next.findIndex((token) => key(token.value) === key(value));
      if (index >= 0 && next[index].mixed) {
        next[index] = { value: next[index].value };
        promoted += 1;
        continue;
      }
    }
    if (value.length > maxLength) error = `Keep each tag to ${maxLength} characters or fewer.`;
    else if (seen.has(key(value))) error = `${existing?.value ?? value} is already a tag.`;
    else if (maxCount !== undefined && next.length >= maxCount) error = `Use ${maxCount} tags or fewer.`;
    else {
      next.push({ value });
      seen.add(key(value));
      continue;
    }
    rejected.push(value);
  }
  return { tokens: next, accepted: next.length - tokens.length + promoted, rejected, error };
}

/** Splits on commas and line breaks; the last part is still being typed. */
export function splitEntry(value: string): { complete: string[]; rest: string } {
  const parts = value.split(/[,\n]/);
  const rest = parts.pop() ?? "";
  return { complete: parts, rest };
}

/** The text left in the field after a split: refused entries first, then the unfinished part. */
export function remainingText(rejected: string[], rest: string): string {
  if (rejected.length === 0) return rest;
  const tail = rest.trimStart();
  return tail ? [...rejected, tail].join(", ") : rejected.join(", ");
}

/** Stored tags may differ only in case, so keys use the exact value plus its occurrence. */
export function tokenKeys(tokens: Token[]): string[] {
  const counts = new Map<string, number>();
  return tokens.map((token) => {
    const count = counts.get(token.value) ?? 0;
    counts.set(token.value, count + 1);
    return `${token.value}\u0000${count}`;
  });
}
