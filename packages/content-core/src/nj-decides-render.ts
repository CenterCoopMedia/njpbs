import { escapeHtml, safeHref } from "./safe-href";
import { resolveNjDecidesBrand, type NjDecidesAssets } from "./nj-decides-brand";
import flag from "./nj-decides-flag.svg?raw";

export interface NjDecidesBandOptions {
  copy?: string;
  liveLabel?: string;
  links?: readonly { label: string; href: string }[];
  branding?: unknown;
  assets?: NjDecidesAssets;
}

/** One escaped production renderer serves the public band and Boardwalk preview. */
export function renderNjDecidesBand({ copy = "", liveLabel = "", links = [], branding, assets }: NjDecidesBandOptions = {}): string {
  const { values, logo, background, dark } = resolveNjDecidesBrand(branding, assets);
  const styles = {
    "--color-nj-decides-field": values.backgroundColor,
    "--color-nj-decides-ink": values.textColor,
    "--color-nj-decides-link": values.linkColor,
    "--color-nj-decides-rule": values.ruleColor,
    "--color-nj-decides-accent": values.accentColor,
    "--color-nj-decides-focus": values.textColor,
    "--nj-decides-star-opacity": dark ? "0.14" : "1",
  };
  const style = Object.entries(styles).map(([name, value]) => `${name}:${value}`).join(";");
  const image = background ? `<img class="nj-decides-band__background" src="${escapeHtml(background.url)}" alt="" width="${background.width}" height="${background.height}" loading="lazy">`
    : '<div class="nj-decides-band__stars" aria-hidden="true"></div>';
  const actions = links.slice(0, 2).flatMap(link => {
    const href = safeHref(link.href);
    return href && link.label.trim() ? [`<a href="${escapeHtml(href)}">${escapeHtml(link.label)}</a>`] : [];
  }).join("");
  const label = liveLabel.trim() ? `<span class="nj-decides-band__live-label">${escapeHtml(liveLabel.trim())}</span>` : "";
  const text = copy.trim() ? `<p>${escapeHtml(copy.trim())}</p>` : "";
  return `<div class="nj-decides nj-decides-band" style="${escapeHtml(style)}" data-nj-decides-band>${image}${values.flagEnabled ? `<div class="nj-decides-band__flag" aria-hidden="true">${flag}</div>` : ""}<div class="nj-decides-band__identity"><img class="nj-decides__logo" src="${escapeHtml(logo.url)}" alt="${escapeHtml(logo.alt)}" width="${logo.width}" height="${logo.height}"></div><div class="nj-decides-band__copy">${label}${text}${actions ? `<div class="nj-decides-band__links">${actions}</div>` : ""}</div></div>`;
}
