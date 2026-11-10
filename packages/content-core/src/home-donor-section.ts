import { escapeHtml, type CardGridBlock } from "./content-model.ts";
import { homeDetailText } from "./home-composition-contract.ts";
import { homeBandBackground, renderHomeBandBackground, type HomeBandAssets } from "./home-band-background.ts";
import { adaptHomeDonorAction } from "./home-donor-source.ts";

// Explicit authoring proposal using recorded Support copy. Never inserted on read
// or conversion. Joe approved the editable default action label on October 13.
export function createHomeDonorBlock(id: string): CardGridBlock {
  return { id, section: "home-donor", type: "card_grid", order: 0, visible: true, data: { cards: [{
    title: "Give to NJ PBS through your donor advised fund",
    body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text",
      text: "Already have a donor advised fund? It's one of the easiest ways to support NJ PBS." }] }] },
    label: "Learn more", href: "/support/",
  }] } };
}

/** Shared saved donor output for the actual Home route and its phone preview. */
export function renderHomeDonor(block: CardGridBlock, { complete = true, assets = {} }: { complete?: boolean; assets?: HomeBandAssets } = {}): string {
  if (!block.visible) return "";
  if (block.section !== "home-donor" || block.data.cards.length !== 1) throw new Error("Home giving requires its named action.");
  const card = block.data.cards[0];
  const summary = homeDetailText(card.body);
  if (summary === null) throw new Error("Home giving requires a plain-text summary.");
  if (typeof card.label !== "string") throw new Error("Home giving requires its action label.");
  const incomplete = !card.title.trim() || !card.label.trim();
  // Incomplete private previews omit only this plank. Still validate the saved
  // destination and summary; publication uses the strict complete path.
  const source = adaptHomeDonorAction({ heading: !complete && !card.title.trim() ? "_" : card.title,
    actionLabel: !complete && !card.label.trim() ? "_" : card.label, href: card.href,
    ...(summary.trim() ? { summary } : {}) });
  if (incomplete) return "";
  const content = source.content!;
  const background = homeBandBackground(block.data.backgroundImageAssetId, assets);
  const headingId = `home-${block.id}-heading`;
  return `<section class="home-donor wrap" data-home-section="home-donor" aria-labelledby="${escapeHtml(headingId)}">
    ${renderHomeBandBackground(background)}<div class="home-band__content">
    <h2 id="${escapeHtml(headingId)}">${escapeHtml(content.heading)}</h2>${content.summary ? `<p>${escapeHtml(content.summary)}</p>` : ""}
    <a class="btn btn--primary" href="${source.actionHref}">${escapeHtml(content.actionLabel)}</a></div></section>`;
}
