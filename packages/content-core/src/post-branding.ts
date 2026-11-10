import { escapeHtml } from "./content-model.ts";
import { DEFAULT_NJ_DECIDES_SETTINGS, validateCoverageLabels, type CoverageLabel } from "./cms-settings.ts";

/** The publication label is separate from the headline, byline, and taxonomy. */
export const SPOTLIGHT_PUBLICATION_LABEL = "NJ Spotlight News";

export function renderPostBranding(spotlightNews: unknown, placement: "headline" | "card" = "headline",
  label?: CoverageLabel, linked = placement === "headline"): string {
  const publication = spotlightNews === true
    ? `<span class="post-publication post-publication--${placement}" data-publication="nj-spotlight-news">${SPOTLIGHT_PUBLICATION_LABEL}</span>` : "";
  if (!label || validateCoverageLabels([label])) return publication;
  const tag = linked && label.href ? "a" : "span";
  const colors = label.id === "nj-decides-2026"
    ? `--coverage-red:${DEFAULT_NJ_DECIDES_SETTINGS.ruleColor};--coverage-blue:${DEFAULT_NJ_DECIDES_SETTINGS.textColor}`
    : `--coverage-bar:${label.backgroundColor}`;
  const eyebrow = `<${tag} class="post-coverage post-coverage--${placement}" data-coverage-label="${escapeHtml(label.id)}" style="${colors}"${tag === "a" ? ` href="${escapeHtml(label.href!)}"` : ""}>${escapeHtml(label.name)}</${tag}>`;
  return `<span class="post-branding-group">${eyebrow}${publication}</span>`;
}
