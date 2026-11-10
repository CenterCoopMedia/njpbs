/** Public article snapshots only. Never import the staff research catalog here. */
import { isExactHttpsUrl } from "./exact-https-url.ts";

export interface BioIdentity {
  profileId: string;
  kind: "person" | "organization";
  name: string;
  role: string;
  party?: string;
  area?: string;
}

export interface BioCardImage {
  assetId: string;
  alt: string;
  altDecorative?: boolean;
  caption?: string;
}

export interface BioCardData extends BioIdentity {
  summary: string;
  sourceUrl: string;
  sourceLabel: string;
  /** The date these public-facing facts were checked, not a live-data promise. */
  asOf: string;
  image?: BioCardImage;
}

export const BIO_LIMITS = Object.freeze({
  profileId: 120, name: 120, role: 180, party: 60, area: 160,
  summary: 600, sourceUrl: 2000, sourceLabel: 120, alt: 300, caption: 300,
});

const IDENTITY_KEYS = ["profileId", "kind", "name", "role", "party", "area"];
const CARD_KEYS = [...IDENTITY_KEYS, "summary", "sourceUrl", "sourceLabel", "asOf", "image"];

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function closed(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).every(key => typeof key === "string" && keys.includes(key));
}

function text(value: unknown, limit: number, required: boolean): value is string {
  return typeof value === "string" && value.length <= limit &&
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value) &&
    (!required || value.trim().length > 0);
}

function identityFields(value: Record<string, unknown>, complete: boolean): boolean {
  return typeof value.profileId === "string" &&
    ((!complete && value.profileId === "") || /^[A-Za-z0-9_-]{1,120}$/.test(value.profileId)) &&
    (value.kind === "person" || value.kind === "organization") &&
    text(value.name, BIO_LIMITS.name, complete) && text(value.role, BIO_LIMITS.role, complete) &&
    (value.party === undefined || text(value.party, BIO_LIMITS.party, false)) &&
    (value.area === undefined || text(value.area, BIO_LIMITS.area, false));
}

function validSource(value: unknown, complete: boolean): boolean {
  if (!text(value, BIO_LIMITS.sourceUrl, complete)) return false;
  if (!complete && value === "") return true;
  return isExactHttpsUrl(value, BIO_LIMITS.sourceUrl);
}

function validDay(value: unknown, complete: boolean): boolean {
  if (!complete && value === "") return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validImage(value: unknown, complete: boolean): boolean {
  if (!record(value) || !closed(value, ["assetId", "alt", "altDecorative", "caption"])) return false;
  if (typeof value.assetId !== "string" ||
    !((!complete && value.assetId === "") || /^[A-Za-z0-9_-]{1,128}$/.test(value.assetId))) return false;
  if (value.altDecorative !== undefined && typeof value.altDecorative !== "boolean") return false;
  if (!text(value.alt, BIO_LIMITS.alt, complete && value.altDecorative !== true)) return false;
  if (value.altDecorative === true && value.alt !== "") return false;
  return value.caption === undefined || text(value.caption, BIO_LIMITS.caption, false);
}

/** Drafts may be incomplete; unknown keys and unsafe URLs are never accepted. */
export function isBioCardData(value: unknown, complete = false): value is BioCardData {
  return record(value) && closed(value, CARD_KEYS) && identityFields(value, complete) &&
    text(value.summary, BIO_LIMITS.summary, complete) && validSource(value.sourceUrl, complete) &&
    text(value.sourceLabel, BIO_LIMITS.sourceLabel, complete) && validDay(value.asOf, complete) &&
    (value.image === undefined || validImage(value.image, complete));
}

/** Finds cards and unsupported legacy bio marks before a publication snapshot is frozen. */
export function containsBio(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsBio);
  if (!record(value)) return false;
  return value.type === "bio" || value.type === "bio_card" || Object.values(value).some(containsBio);
}

export function bioPlacementError(kind: string, document: unknown): string | null {
  return kind !== "post" && containsBio(document)
    ? "Bio cards are available only inside Posts."
    : null;
}
