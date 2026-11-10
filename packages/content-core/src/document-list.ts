export const DOCUMENT_LIST_MAX = 100;
export const DOCUMENT_PUBLISHERS = { njpba: "NJPBA", njpbs: "NJ PBS" } as const;

export interface NoticeDocument {
  itemId: string;
  assetId: string;
  title: string;
  publisher?: keyof typeof DOCUMENT_PUBLISHERS;
  /** First addition to this list, assigned by the save transaction. */
  addedAt?: string;
}

export interface DocumentListData {
  documents: NoticeDocument[];
}

export function isNoticeAddedAt(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function isDocumentListData(value: unknown, complete = true): value is DocumentListData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => key !== "documents") || !Array.isArray(data.documents)
    || data.documents.length > DOCUMENT_LIST_MAX) return false;
  const ids = new Set<string>();
  return data.documents.every(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).some(key => !["itemId", "assetId", "title", "publisher", "addedAt"].includes(key))) return false;
    if (typeof item.itemId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(item.itemId) || ids.has(item.itemId)) return false;
    ids.add(item.itemId);
    return typeof item.assetId === "string" && (item.assetId === "" && !complete || /^[A-Za-z0-9_-]{1,128}$/.test(item.assetId))
      && typeof item.title === "string" && item.title.length <= 300 && (!complete || item.title.trim().length > 0)
      && (item.publisher === undefined || item.publisher === "njpba" || item.publisher === "njpbs")
      && (item.addedAt === undefined && !complete || isNoticeAddedAt(item.addedAt));
  });
}

export function newestNoticeDocuments(documents: readonly NoticeDocument[]): NoticeDocument[] {
  return [...documents].sort((a, b) => (Date.parse(b.addedAt ?? "") || 0) - (Date.parse(a.addedAt ?? "") || 0)
    || a.itemId.localeCompare(b.itemId, "en"));
}

export function noticeAddedDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" }).format(new Date(value));
}
