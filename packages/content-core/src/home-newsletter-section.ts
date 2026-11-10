import { escapeHtml, parseBlocks, type NewsletterSignupBlock } from "./content-model.ts";
import { isHomeSelectionReceipt } from "./home-source-selection.ts";
import { resolveHomeNewsletter, type HomeEditorialCatalog } from "./home-source-catalog.ts";
import { homeBandBackground, type HomeBandAssets } from "./home-band-background.ts";
import { newsletterSignupUrl } from "./launch-fallback.ts";

/** Today's standard band, shared by the template and empty saved Home sections. */
export function renderStandardHomeNewsletter(blockId?: string, backgroundUrl = "/brand/newsletter/abstract-blue-folds.webp"): string {
  const headingId = blockId ? `${blockId}-heading` : "newsletter-band-heading";
  return `<section class="newsletter-band"${blockId ? ' data-home-section="home-newsletter"' : ""} aria-labelledby="${escapeHtml(headingId)}">
    <img class="newsletter-band__backdrop" src="${escapeHtml(backgroundUrl)}" alt="" width="2172" height="724" loading="lazy" fetchpriority="low" decoding="async" />
    <div class="newsletter-band__inner"><div class="newsletter-band__copy"><span class="newsletter-band__eyebrow">Stay connected</span>
      <h2 id="${escapeHtml(headingId)}">Get the NJ PBS email newsletter</h2>
      <p>Station news and programming updates, delivered to your inbox.</p></div>
      <a class="btn newsletter-band__signup" href="${escapeHtml(newsletterSignupUrl)}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 6 9 7 9-7" /></svg>Sign up by email</a>
    </div></section>`;
}

export function createHomeNewsletterBlock(id: string): NewsletterSignupBlock {
  return { id, type: "newsletter_signup", section: "home-newsletter", order: 0, visible: true,
    data: { newsletterIds: [], actionLabel: "Sign up by email" } };
}
export function homeNewsletterDataError(data: NewsletterSignupBlock["data"], complete: boolean): string | null {
  if (data.newsletterIds.length > 1 || data.newsletterIds.some(id => !/^[A-Za-z0-9_-]{1,128}$/.test(id)) ||
      typeof data.actionLabel !== "string" || data.actionLabel.length > 120 ||
      (data.heading ?? "").length > 120 || (data.intro ?? "").length > 2000 ||
      /[\u0000-\u001f\u007f]/.test((data.heading ?? "") + (data.intro ?? "") + data.actionLabel) ||
      (data.newsletterIds.length > 0) !== (data.selectionReceipt !== undefined) ||
      data.selectionReceipt !== undefined && !isHomeSelectionReceipt(data.selectionReceipt) ||
      complete && data.newsletterIds.length > 0 && !data.actionLabel.trim()) {
    return "Home Newsletter requires an empty slot or one published selection with plain-text copy and button text.";
  }
  return null;
}
/** Identical inert escaped bar for public Home and the component phone preview. */
export function renderHomeNewsletter(block: NewsletterSignupBlock, catalog: HomeEditorialCatalog | undefined,
  { complete = true, assets = {} }: { complete?: boolean; assets?: HomeBandAssets } = {}): string {
  if (!parseBlocks([block], { complete: false }).ok || block.section !== "home-newsletter" ||
      homeNewsletterDataError(block.data, complete && block.visible)) throw new Error("Invalid Home Newsletter bar.");
  if (!block.visible) return "";
  const background = homeBandBackground(block.data.backgroundImageAssetId, assets);
  if (block.data.newsletterIds.length === 0) {
    return renderStandardHomeNewsletter(block.id, background);
  }
  if (!block.data.actionLabel?.trim() || !catalog) return "";
  const source = resolveHomeNewsletter(block, catalog), card = source.cards[0];
  if (!card) return "";
  const backgroundUrl = background ?? card.image?.url ?? "/brand/newsletter/abstract-blue-folds.webp";
  const headingId = `${block.id}-heading`;
  return `<section class="newsletter-band" data-home-section="home-newsletter" aria-labelledby="${escapeHtml(headingId)}">
    <img class="newsletter-band__backdrop" src="${escapeHtml(backgroundUrl)}" alt="${escapeHtml(background ? "" : card.image?.alt ?? "")}" width="2172" height="724" loading="lazy" fetchpriority="low" decoding="async" />
    <div class="newsletter-band__inner"><div class="newsletter-band__copy"><span class="newsletter-band__eyebrow">Stay connected</span>
      <h2 id="${escapeHtml(headingId)}">${escapeHtml(source.heading ?? card.title)}</h2>
      ${source.intro ?? card.summary ? `<p>${escapeHtml(source.intro ?? card.summary ?? "")}</p>` : ""}</div>
      <a class="btn newsletter-band__signup" href="${escapeHtml(card.signupHref)}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 6 9 7 9-7" /></svg>${escapeHtml(card.actionLabel)}</a>
    </div></section>`;
}
