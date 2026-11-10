import type { NewsletterRecord } from "./content-model";

function bodySummary(record: NewsletterRecord): string {
  const text = (node: unknown): string => {
    if (!node || typeof node !== "object") return "";
    const part = node as { text?: unknown; content?: unknown };
    if (typeof part.text === "string") return part.text;
    return Array.isArray(part.content) ? part.content.map(text).join(" ") : "";
  };
  return text(record.body).replace(/\s+/g, " ").trim().slice(0, 300);
}

export interface NewsletterCardData {
  title: string;
  signupUrl: string;
  frequency?: string;
  summary?: string;
  imageAssetId?: string;
  imageAlt?: string;
  imageDecorative?: boolean;
}

/** Shared card projection. A signup link appears only when its destination is HTTPS. */
export function newsletterCardData(record: NewsletterRecord): NewsletterCardData | null {
  if (!record || record.type !== "newsletter" || !record.title?.trim()) return null;
  const raw = record.signupUrl?.trim();
  let signupUrl: string | undefined;
  if (raw) {
    try {
      const url = new URL(raw);
      if (url.protocol === "https:" && url.hostname && !url.username && !url.password && !/[\u0000-\u001F\u007F]/.test(raw)) signupUrl = url.href;
    } catch { /* An invalid provider address leaves the library card without a link. */ }
  }
  if (!signupUrl) return null;
  const summary = record.summary?.trim() || bodySummary(record);
  return {
    title: record.title.trim(),
    signupUrl,
    ...(record.frequency?.trim() ? { frequency: record.frequency.trim() } : {}),
    ...(summary ? { summary } : {}),
    ...(record.imageAssetId?.trim() ? {
      imageAssetId: record.imageAssetId.trim(),
      imageAlt: record.imageDecorative === true ? "" : (record.imageAlt ?? ""),
      imageDecorative: record.imageDecorative === true,
    } : {}),
  };
}
