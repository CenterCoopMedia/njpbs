import { generate, ident, parse } from "css-tree";

/**
 * Read inline display order without treating comments or other properties as CSS.
 * Unknown values stay subject to the size check; only an effective `none` exempts.
 * Stylesheet rules and ancestors are outside this build-time check.
 * @param {string} style
 * @returns {string | null}
 */
export function inlineDisplay(style) {
  let display = null;
  let important = false;
  try {
    const declarations = parse(style, {
      context: "declarationList",
      onParseError(error) { throw error; },
    });
    for (const declaration of declarations.children) {
      if (declaration.type !== "Declaration") continue;
      const property = ident.decode(declaration.property).toLowerCase();
      if (property !== "display" && property !== "all") continue;
      if (important && !declaration.important) continue;
      display = property === "display" ? generate(declaration.value).toLowerCase() : "reset";
      important = Boolean(declaration.important);
    }
    return display;
  } catch {
    // A malformed style cannot prove that an image is out of layout.
    return "unknown";
  }
}
