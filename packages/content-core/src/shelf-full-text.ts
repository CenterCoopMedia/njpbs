import { escapeHtml } from "./content-model";
import { homeLinkAttributes } from "./home-section-render";

interface ShelfTextItem {
  title: string;
  href: string;
  external?: boolean;
  rel?: "noopener" | "noopener noreferrer";
  description?: string;
  metadata?: string;
}

/** A native shelf-level alternative to clipped cards. No script or saved state. */
export function renderShelfFullText(title: string, items: readonly ShelfTextItem[]): string {
  if (!items.length) return "";
  const cards = items.map(item => `<li><a${homeLinkAttributes(item.href, item.external, item.rel)}>${escapeHtml(item.title)}${item.external ? '<span class="sr-only"> (opens in new tab)</span>' : ""}</a>${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}${item.metadata ? `<p>${escapeHtml(item.metadata)}</p>` : ""}</li>`).join("");
  return `<details class="shelf-full-text"><summary><span class="shelf-full-text__show">Show full text</span><span class="shelf-full-text__less">Show less</span><span class="sr-only"> for ${escapeHtml(title)}</span></summary><ul role="list">${cards}</ul></details>`;
}
