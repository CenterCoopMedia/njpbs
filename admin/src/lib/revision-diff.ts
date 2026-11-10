type PlainRecord = Record<string, unknown>;

export interface RevisionFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface RevisionBlockChange {
  id: string;
  type: string;
  kind: "added" | "removed" | "changed";
  beforeIndex: number | null;
  afterIndex: number | null;
  moved: boolean;
  visibilityChanged: boolean;
  typeChanged: boolean;
  changedDataFields: string[];
  dataChanges: RevisionFieldChange[];
  envelopeChanges: RevisionFieldChange[];
}

export interface RevisionDiff {
  fields: RevisionFieldChange[];
  blocks: RevisionBlockChange[];
  media: { added: string[]; removed: string[] };
}

function asRecord(value: unknown): PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as PlainRecord)
    : {};
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as PlainRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function blockIdentity(value: unknown, index: number): string {
  const record = asRecord(value);
  return typeof record.id === "string" && record.id.length > 0
    ? record.id
    : `block-${index + 1}`;
}

function blockType(value: unknown): string {
  const type = asRecord(value).type;
  return typeof type === "string" && type.length > 0 ? type : "unknown block";
}

function dataFieldChanges(before: unknown, after: unknown): RevisionFieldChange[] {
  const beforeData = asRecord(asRecord(before).data);
  const afterData = asRecord(asRecord(after).data);
  return [...new Set([...Object.keys(beforeData), ...Object.keys(afterData)])]
    .filter((key) => !valuesEqual(beforeData[key], afterData[key]))
    .sort()
    .map((field) => ({ field, before: beforeData[field], after: afterData[field] }));
}

function envelopeFieldChanges(before: PlainRecord, after: PlainRecord): RevisionFieldChange[] {
  return ["order", "section", "layout"]
    .filter((field) => !valuesEqual(before[field], after[field]))
    .map((field) => ({ field, before: before[field], after: after[field] }));
}

function mediaIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  const seen = new Set<object>();

  function visit(candidate: unknown, key: string | null, depth: number): void {
    if (ids.size >= 500 || depth > 12) return;
    if (
      typeof candidate === "string" &&
      (key === "assetId" || key?.endsWith("AssetId")) &&
      candidate.length > 0
    ) {
      ids.add(candidate);
      return;
    }
    if (typeof candidate !== "object" || candidate === null || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach((item) => visit(item, null, depth + 1));
    } else {
      Object.entries(candidate as PlainRecord).forEach(([childKey, item]) =>
        visit(item, childKey, depth + 1),
      );
    }
    seen.delete(candidate);
  }

  visit(value, null, 0);
  return ids;
}

function blockChanges(before: PlainRecord, after: PlainRecord): RevisionBlockChange[] {
  const beforeBlocks = Array.isArray(before.blocks) ? before.blocks : [];
  const afterBlocks = Array.isArray(after.blocks) ? after.blocks : [];
  const beforeById = new Map(
    beforeBlocks.map((block, index) => [blockIdentity(block, index), { block, index }]),
  );
  const afterById = new Map(
    afterBlocks.map((block, index) => [blockIdentity(block, index), { block, index }]),
  );

  return [...new Set([...beforeById.keys(), ...afterById.keys()])]
    .sort()
    .flatMap((id): RevisionBlockChange[] => {
      const previous = beforeById.get(id);
      const next = afterById.get(id);
      if (!previous && next) {
        const dataChanges = dataFieldChanges(null, next.block);
        return [{
          id,
          type: blockType(next.block),
          kind: "added",
          beforeIndex: null,
          afterIndex: next.index,
          moved: false,
          visibilityChanged: false,
          typeChanged: false,
          changedDataFields: dataChanges.map(({ field }) => field),
          dataChanges,
          envelopeChanges: [],
        }];
      }
      if (previous && !next) {
        const dataChanges = dataFieldChanges(previous.block, null);
        return [{
          id,
          type: blockType(previous.block),
          kind: "removed",
          beforeIndex: previous.index,
          afterIndex: null,
          moved: false,
          visibilityChanged: false,
          typeChanged: false,
          changedDataFields: dataChanges.map(({ field }) => field),
          dataChanges,
          envelopeChanges: [],
        }];
      }
      if (!previous || !next) return [];

      const previousRecord = asRecord(previous.block);
      const nextRecord = asRecord(next.block);
      const moved = previous.index !== next.index;
      const visibilityChanged = previousRecord.visible !== nextRecord.visible;
      const typeChanged = previousRecord.type !== nextRecord.type;
      const dataChanges = dataFieldChanges(previous.block, next.block);
      const changedDataFields = dataChanges.map(({ field }) => field);
      const envelopeChanges = envelopeFieldChanges(previousRecord, nextRecord);
      if (
        !moved &&
        !visibilityChanged &&
        !typeChanged &&
        changedDataFields.length === 0 &&
        envelopeChanges.length === 0
      ) {
        return [];
      }
      return [{
        id,
        type: blockType(next.block),
        kind: "changed",
        beforeIndex: previous.index,
        afterIndex: next.index,
        moved,
        visibilityChanged,
        typeChanged,
        changedDataFields,
        dataChanges,
        envelopeChanges,
      }];
    });
}

export function buildRevisionDiff(beforeValue: unknown, afterValue: unknown): RevisionDiff {
  const before = asRecord(beforeValue);
  const after = asRecord(afterValue);
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => field !== "blocks" && !valuesEqual(before[field], after[field]))
    .sort()
    .map((field) => ({ field, before: before[field], after: after[field] }));
  const beforeMedia = mediaIds(before);
  const afterMedia = mediaIds(after);
  return {
    fields,
    blocks: blockChanges(before, after),
    media: {
      added: [...afterMedia].filter((id) => !beforeMedia.has(id)).sort(),
      removed: [...beforeMedia].filter((id) => !afterMedia.has(id)).sort(),
    },
  };
}
