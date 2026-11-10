// The before/after diff the admin UI derives from each audit entry. Issue #205 requires every
// content and permission action to record actor, UTC timestamp, and useful change evidence.
// Audit writers store the snapshots; this pure shared core computes a field-level view at read
// time so an administrator does not have to compare two whole documents by eye.

export type Json = null | boolean | number | string | Date | Json[] | { [key: string]: Json };

export type FieldChange =
  | { readonly path: string; readonly kind: "added"; readonly after: Json }
  | { readonly path: string; readonly kind: "removed"; readonly before: Json }
  | {
      readonly path: string;
      readonly kind: "changed";
      readonly before: Json;
      readonly after: Json;
    };

export interface AuditDiff {
  readonly changes: readonly FieldChange[];
}

function isPlainObject(value: unknown): value is { [key: string]: Json } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value instanceof Date) return `D:${value.toISOString()}`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key] as Json)}`)
      .join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return `#${String(value)}`;
  return JSON.stringify(value) ?? "null";
}

function equalJson(first: Json, second: Json): boolean {
  return canonical(first) === canonical(second);
}

function asMap(state: Json | null): { [key: string]: Json } | null {
  if (state === null) return null;
  if (isPlainObject(state)) return state;
  throw new Error("diffStates expects an object or null for each document state");
}

function walk(
  prefix: string,
  before: { [key: string]: Json } | null,
  after: { [key: string]: Json } | null,
  output: FieldChange[],
): void {
  const keys = new Set<string>();
  if (before !== null) for (const key of Object.keys(before)) keys.add(key);
  if (after !== null) for (const key of Object.keys(after)) keys.add(key);

  for (const key of keys) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    const beforeValue = before === null ? undefined : before[key];
    const afterValue = after === null ? undefined : after[key];
    if (beforeValue !== undefined && afterValue === undefined) {
      output.push({ path, kind: "removed", before: beforeValue });
      continue;
    }
    if (beforeValue === undefined && afterValue !== undefined) {
      output.push({ path, kind: "added", after: afterValue });
      continue;
    }
    if (beforeValue === undefined || afterValue === undefined) continue;
    if (isPlainObject(beforeValue) && isPlainObject(afterValue)) {
      walk(path, beforeValue, afterValue, output);
      continue;
    }
    if (!equalJson(beforeValue, afterValue)) {
      output.push({
        path,
        kind: "changed",
        before: beforeValue,
        after: afterValue,
      });
    }
  }
}

export function diffStates(before: Json | null, after: Json | null): AuditDiff {
  const changes: FieldChange[] = [];
  walk("", asMap(before), asMap(after), changes);
  changes.sort((first, second) =>
    first.path < second.path ? -1 : first.path > second.path ? 1 : 0,
  );
  return { changes };
}
