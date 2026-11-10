import type { EditorField } from "./editor-admin";

function segments(field: EditorField): string[] {
  return [...(field.path ?? []), field.key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stable identity for validation errors and control ids, including any metadata group path. */
export function fieldPathKey(field: EditorField): string {
  return segments(field).join(".");
}

export function hasFieldValue(values: Record<string, unknown>, field: EditorField): boolean {
  const path = segments(field);
  let cursor: Record<string, unknown> = values;
  for (let index = 0; index < path.length - 1; index += 1) {
    const next = cursor[path[index]!];
    if (!isRecord(next)) return false;
    cursor = next;
  }
  return Object.prototype.hasOwnProperty.call(cursor, path[path.length - 1]!);
}

export function readFieldValue(
  values: Record<string, unknown>,
  field: EditorField,
): unknown {
  const path = segments(field);
  let cursor: unknown = values;
  for (const key of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/**
 * Replace one root or nested field without mutating the source. Every object on the path is
 * copied, while siblings—including unknown legacy metadata—are preserved verbatim.
 */
export function writeFieldValue(
  values: Record<string, unknown>,
  field: EditorField,
  value: unknown,
): Record<string, unknown> {
  const path = segments(field);
  const root = { ...values };
  let source: Record<string, unknown> = values;
  let target: Record<string, unknown> = root;

  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]!;
    const sourceChild = isRecord(source[key]) ? source[key] : {};
    const targetChild = { ...sourceChild };
    target[key] = targetChild;
    source = sourceChild;
    target = targetChild;
  }

  target[path[path.length - 1]!] = value;
  return root;
}

/**
 * Remove one field without mutating the source. Empty objects created only by the edited path
 * are pruned, unless the same object existed in `preserveShapeFrom`. That baseline distinction
 * is important for metadata overrides: an absent `seo` group can disappear again when a new
 * override is undone, while a stored `seo: {}` must remain present so a partial save can clear
 * the server's previous nested values.
 */
export function removeFieldValue(
  values: Record<string, unknown>,
  field: EditorField,
  preserveShapeFrom?: Record<string, unknown>,
): Record<string, unknown> {
  if (!hasFieldValue(values, field)) return values;

  const path = segments(field);

  function removeAt(
    source: Record<string, unknown>,
    baseline: Record<string, unknown> | undefined,
    index: number,
  ): Record<string, unknown> {
    const key = path[index]!;
    const next = { ...source };
    if (index === path.length - 1) {
      delete next[key];
      return next;
    }

    const sourceChild = isRecord(source[key]) ? source[key] : {};
    const baselineChild = baseline && isRecord(baseline[key]) ? baseline[key] : undefined;
    const nextChild = removeAt(sourceChild, baselineChild, index + 1);
    if (Object.keys(nextChild).length === 0 && baselineChild === undefined) {
      delete next[key];
    } else {
      next[key] = nextChild;
    }
    return next;
  }

  return removeAt(values, preserveShapeFrom, 0);
}
