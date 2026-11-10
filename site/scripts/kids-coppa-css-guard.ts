import {
  parseUrlReference,
  type UrlReference,
} from "./kids-coppa-url-guard";
import {
  cssImageSetValues,
  cssImportValues,
  cssUrlValues,
} from "./kids-coppa-css-lex";

// CSS can fetch without an HTML attribute: url() covers backgrounds and fonts,
// quoted @import forms do not contain url(), and image-set() permits a bare
// string URL. The lexical helpers ignore comments and strings that are not in a
// request-bearing grammar position, then decode CSS escapes before URL parsing.
export function cssUrlReferences(
  css: string,
  baseUrl: string,
): UrlReference[] {
  const references = new Map<string, UrlReference>();
  const add = (raw: string): void => {
    const value = raw.trim();
    if (
      !value ||
      value.startsWith("#") ||
      value.toLowerCase().startsWith("data:")
    ) {
      return;
    }
    const parsed = parseUrlReference(value, baseUrl);
    references.set(`${value}\0${parsed.error ?? ""}`, parsed);
  };

  for (const value of [
    ...cssUrlValues(css),
    ...cssImportValues(css),
    ...cssImageSetValues(css),
  ]) {
    add(value);
  }

  return [...references.values()];
}
