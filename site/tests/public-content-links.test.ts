import { describe, expect, it } from "vitest";
import { resolvePublicContentHref } from "../src/lib/public-content-links";

describe("resolvePublicContentHref", () => {
  it("rewrites flat markdown links to public root routes", () => {
    expect(resolvePublicContentHref("faq.md")).toBe("/faq/");
    expect(resolvePublicContentHref("./accessibility.md")).toBe("/accessibility/");
    expect(resolvePublicContentHref("closed-captioning.md#complaints")).toBe(
      "/closed-captioning/#complaints",
    );
  });

  it("leaves external, same-page, and non-markdown links unchanged", () => {
    expect(resolvePublicContentHref("mailto:njpbs@montclair.edu")).toBe(
      "mailto:njpbs@montclair.edu",
    );
    expect(resolvePublicContentHref("tel:+18008826622")).toBe("tel:+18008826622");
    expect(resolvePublicContentHref("#help")).toBe("#help");
    expect(resolvePublicContentHref("/faq/")).toBe("/faq/");
  });
});
