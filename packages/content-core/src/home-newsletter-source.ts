import { isRichTextDoc, renderRichText, richTextIsEmpty } from "./content-model.ts";
import { HOME_DESTINATIONS } from "./home-composition-contract.ts";
import { isExactHttpsUrl } from "./exact-https-url.ts";
import { homeSourceImage, homeSourceInstant, homeSourceObject, homeSourceText, type HomeSourceImage } from "./home-source-curation.ts";

export interface HomeNewsletterSettings {
  newsletterIds: readonly string[];
  actionLabel: string;
  heading?: string;
  intro?: string;
}
export interface HomeNewsletterCard {
  id: string;
  sourceVersion: number;
  title: string;
  signupHref: string;
  actionLabel: string;
  summary?: string;
  frequency?: string;
  image?: HomeSourceImage;
}
export interface HomeNewsletterSource {
  source: "published_newsletters";
  cutoffAt: string;
  checkedAt: string | null;
  heading?: string;
  intro?: string;
  cards: HomeNewsletterCard[];
  missingIds: string[];
  emptyReason: "selection_unavailable" | "source_error" | null;
}
type NewsletterSnapshot = { status: "ready"; checkedAt: string; records: readonly unknown[] } | { status: "error" };

/** Consume the existing fixed-cutoff public record-card export, never working Newsletter documents. */
export function adaptHomeNewsletter(settings: HomeNewsletterSettings, snapshot: NewsletterSnapshot,
  cutoffAt: string): HomeNewsletterSource {
  const cutoff = homeSourceInstant(cutoffAt);
  if (cutoff === null || !homeSourceObject(settings) ||
    Object.keys(settings).some(key => !["newsletterIds", "actionLabel", "heading", "intro"].includes(key)) ||
    !Array.isArray(settings.newsletterIds) || settings.newsletterIds.length > 4 ||
    settings.newsletterIds.some(id => !homeSourceText(id, 128)) ||
    new Set(settings.newsletterIds).size !== settings.newsletterIds.length || !homeSourceText(settings.actionLabel, 120) ||
    settings.heading !== undefined && !homeSourceText(settings.heading, 120) ||
    settings.intro !== undefined && !homeSourceText(settings.intro, 2000)) throw new Error("Home Newsletter settings are invalid.");
  const result: HomeNewsletterSource = { source: "published_newsletters", cutoffAt, checkedAt: null,
    ...(settings.heading === undefined ? {} : { heading: settings.heading }),
    ...(settings.intro === undefined ? {} : { intro: settings.intro }),
    cards: [], missingIds: [], emptyReason: "source_error" };
  if (snapshot.status === "error") return result;
  const checked = homeSourceInstant(snapshot.checkedAt);
  if (snapshot.status !== "ready" || checked === null || checked > cutoff || !Array.isArray(snapshot.records)) throw new Error("Home Newsletter receipt is invalid.");
  const cards: HomeNewsletterCard[] = [];
  for (const id of settings.newsletterIds) {
    const matches = snapshot.records.filter(record => homeSourceObject(record) && record.kind === "newsletter" && record.id === id);
    const record = matches.length === 1 ? matches[0] : null;
    if (!homeSourceObject(record) || record.href !== null || !Number.isSafeInteger(record.sourceVersion) ||
      Number(record.sourceVersion) < 1 || !homeSourceObject(record.newsletter) || !homeSourceObject(record.newsletter.card)) continue;
    const card = record.newsletter.card;
    if (!homeSourceText(card.title, 300) || !isExactHttpsUrl(card.signupUrl, 2048) || card.signupUrl.includes("\\")) continue;
    const image = homeSourceImage(record.newsletter.image && homeSourceObject(record.newsletter.image)
      ? { url: record.newsletter.image.url, alt: card.imageDecorative === true ? "" : card.imageAlt ?? "" } : undefined);
    cards.push({ id, sourceVersion: Number(record.sourceVersion), title: card.title,
      signupHref: card.signupUrl, actionLabel: settings.actionLabel,
      ...(homeSourceText(card.summary, 2000) ? { summary: card.summary } : {}),
      ...(homeSourceText(card.frequency, 120) ? { frequency: card.frequency } : {}), ...(image ? { image } : {}) });
  }
  return { ...result, checkedAt: snapshot.checkedAt, cards,
    missingIds: settings.newsletterIds.filter(id => !cards.some(card => card.id === id)),
    emptyReason: cards.length ? null : "selection_unavailable" };
}

export interface HomePassportSource {
  source: "passport";
  actionHref: typeof HOME_DESTINATIONS.passport;
  content: { heading: string; bodyHtml: string; actionLabel: string } | null;
  emptyReason: "missing" | null;
}
/** Passport is one semantic group with its preserved, approved destination. */
export function adaptHomePassport(content: unknown, actionHref: string = HOME_DESTINATIONS.passport): HomePassportSource {
  if (actionHref !== HOME_DESTINATIONS.passport) throw new Error("Keep the approved Passport destination.");
  if (content === null || content === undefined) return { source: "passport", actionHref, content: null, emptyReason: "missing" };
  if (!homeSourceObject(content) || Object.keys(content).some(key => !["heading", "body", "actionLabel"].includes(key)) ||
    !homeSourceText(content.heading, 120) || !homeSourceText(content.actionLabel, 120) ||
    !isRichTextDoc(content.body) || richTextIsEmpty(content.body)) throw new Error("Home Passport content is invalid.");
  return { source: "passport", actionHref,
    content: { heading: content.heading, bodyHtml: renderRichText(content.body), actionLabel: content.actionLabel }, emptyReason: null };
}
