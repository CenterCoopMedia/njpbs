import { parseFragment } from "parse5";

export function countSafeExternalLinks(html, href) {
  const nodes = [parseFragment(html)];
  let count = 0;
  for (const node of nodes) {
    nodes.push(...(node.childNodes ?? []));
    if (node.tagName !== "a") continue;
    const attributes = Object.fromEntries(node.attrs.map(({ name, value }) => [name, value]));
    if (attributes.href === href && attributes.target === "_blank" &&
        (attributes.rel ?? "").split(/\s+/).includes("noopener")) count += 1;
  }
  return count;
}

/** Authored links are removable; the public shell still owns its two Donate links. */
export function serviceDonationLinks(html, href, pageId) {
  const nodes = [parseFragment(html)];
  let composed = false;
  let actual = 0;
  for (const node of nodes) {
    const attrs = Object.fromEntries((node.attrs ?? []).map(({ name, value }) => [name, value]));
    if (node.tagName === "div" && attrs["data-cms-page"] === pageId &&
      attrs["data-service-composition-version"] === "1" &&
      (attrs.class ?? "").split(/\s+/).includes("cms-page--service-composition")) {
      composed = true;
      continue;
    }
    nodes.push(...(node.childNodes ?? []));
    if (node.tagName === "a" && attrs.href === href && attrs.target === "_blank" &&
      (attrs.rel ?? "").split(/\s+/).includes("noopener")) actual += 1;
  }
  return { composed, actual, expected: composed ? 2 : 4 };
}
