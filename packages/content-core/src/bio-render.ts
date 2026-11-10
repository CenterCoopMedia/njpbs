import { escapeHtml } from "./safe-href.ts";
import { isBioCardData, type BioCardData, type BioIdentity } from "./bio-profiles.ts";

function identityRows(data: BioIdentity): string {
  const party = data.party?.trim() ? `<span class="bio-fact"><span class="bio-card__sr">Party: </span>${escapeHtml(data.party)}</span>` : "";
  const area = data.area?.trim() ? `<span class="bio-fact">${data.kind === "organization" ? '<span class="bio-fact__label">Based in</span> ' : '<span class="bio-card__sr">Area: </span>'}${escapeHtml(data.area)}</span>` : "";
  return `${party}${area}`;
}

/** A native disclosure stays useful without client JavaScript. Image HTML comes from the shared asset renderer. */
export function renderBioCard(data: BioCardData, imageHtml = ""): string {
  if (!isBioCardData(data, true)) return "";
  const photo = imageHtml ? `<span class="bio-card__photo">${imageHtml}</span>` : "";
  const credit = imageHtml && data.image?.caption?.trim()
    ? `<p class="bio-card__credit">${escapeHtml(data.image.caption)}</p>` : "";
  const date = new Date(`${data.asOf}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return `<details class="bio-card bio-card--${data.kind}"><summary class="bio-card__summary">${photo}<span class="bio-card__identity"><strong class="bio-card__name">${escapeHtml(data.name)}</strong><span class="bio-card__context"><span class="bio-card__role">${escapeHtml(data.role)}</span>${identityRows(data)}</span></span><span class="bio-card__action"><span class="bio-card__more">Bio</span><span class="bio-card__less">Close</span><span class="bio-card__chevron" aria-hidden="true">⌄</span></span></summary><div class="bio-card__body"><p>${escapeHtml(data.summary)}</p>${credit}<p class="bio-card__source"><a href="${escapeHtml(data.sourceUrl)}">${escapeHtml(data.sourceLabel)}</a><span> · Checked <time datetime="${data.asOf}">${date}</time></span></p></div></details>`;
}
