/** A display name from Co-Authors Plus, never a WordPress posting account. */
export function spotlightDisplayByline(value) {
  if (typeof value !== "string") return undefined;
  const byline = value.trim();
  const first = byline.replace(/, et al\.$/, "");
  if (!byline || byline.length > 2000 || /[\u0000-\u001f\u007f<>@]/.test(byline) ||
      /^(?:jmooney|NJ Spotlight(?: News)?)$/i.test(first)) return undefined;
  return byline;
}

/** Only the explicit publisher field can supply a Spotlight card byline. */
export function spotlightCardByline(card) {
  return card?.bylineSource === "coauthors-plus" ? spotlightDisplayByline(card.byline) : undefined;
}
