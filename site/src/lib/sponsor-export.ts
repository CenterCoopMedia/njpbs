import { isCalendarDay } from "../../../packages/content-core/src/editorial-dates.ts";

export interface SponsorCardData {
  sponsorId: string;
  name: string;
  href: string | null;
  logoUrl: string | null;
  logoAlt: string;
  logoDecorative: boolean;
  tier?: string;
  description?: string;
}

type SponsorSource = Record<string, unknown> & { id: string };
type SponsorAsset = { id: string; url: string; mimeType: string };

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function website(value: unknown): string | null {
  const href = text(value);
  try {
    const url = new URL(href);
    if (["http:", "https:"].includes(url.protocol) && url.hostname && !url.username && !url.password &&
      !/[\u0000-\u001f\u007f]/.test(href)) return url.href;
  } catch {}
  return null;
}

/** Project admitted metadata; the public export boundary owns approval checks. */
export function sponsorCardData(record: SponsorSource, assets: ReadonlyMap<string, SponsorAsset> = new Map(), now = new Date()): SponsorCardData | null {
  if (record.type !== "sponsor" || record.deleted === true || record.status === "archived" || !sponsorActiveOn(record, now)) return null;
  const name = text(record.name);
  const href = website(record.href);
  if (!name) return null;
  const logoAssetId = text(record.logoAssetId);
  const asset = assets.get(logoAssetId);
  const logoUrl = asset && /^image\/(png|jpeg|webp|gif|avif)$/.test(asset.mimeType) && /^https:\/\//.test(asset.url) ? asset.url : null;
  return {
    sponsorId: record.id,
    name,
    href,
    logoUrl,
    logoAlt: record.logoDecorative === true ? "" : text(record.logoAlt),
    logoDecorative: record.logoDecorative === true,
    ...(text(record.tier) ? { tier: text(record.tier) } : {}),
    ...(text(record.description) ? { description: text(record.description) } : {}),
  };
}

export function sponsorActiveOn(record: SponsorSource, now: Date): boolean {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric",
    month: "2-digit", day: "2-digit" }).format(now);
  const from = text(record.activeFrom);
  const until = text(record.activeUntil);
  return (!from || (isCalendarDay(from) && from <= day)) && (!until || (isCalendarDay(until) && until >= day));
}
