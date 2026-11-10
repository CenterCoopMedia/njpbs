import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { NAV_DESTINATIONS } from "../src/lib/nav-destinations";
import { ICON_NAMES } from "../src/lib/icon-names";
import { MAX_CUSTOM_NAVIGATION_ITEMS, isSafeNavigationUrl } from "../src/lib/custom-navigation";

const server = createRequire(import.meta.url)("../../functions/lib/navigation-preferences.js");
const rules = readFileSync(fileURLToPath(new NodeURL("../../firestore.rules", import.meta.url)), "utf8");
const quotedValues = (source: string) => [...source.matchAll(/'([^']+)'/g)].map(match => match[1]);

describe("navigation client and server contract", () => {
  it("keeps the ten-entry boundary on both validation paths", () => {
    expect(MAX_CUSTOM_NAVIGATION_ITEMS).toBe(10);
    expect(server.MAX_CUSTOM_NAVIGATION_ITEMS).toBe(10);
  });
  it("admits each current built-in destination ID on both write boundaries", () => {
    const allowed = rules.match(/let allowedIds = ids\.concat\(\[([\s\S]*?)\]\);/);
    expect(allowed).not.toBeNull();
    const expected = new Set(NAV_DESTINATIONS.map(item => item.id));
    expect(new Set(quotedValues(allowed![1]))).toEqual(expected);
    expect(new Set(server.BUILTIN_NAVIGATION_IDS)).toEqual(expected);
  });
  it("admits the existing icon vocabulary on the server", () => {
    expect(new Set(server.ICON_NAMES)).toEqual(new Set(ICON_NAMES));
  });
  it.each([
    ["/content/pages/home", true], ["/media?search=NJ#results", true],
    ["/live-production", true], ["/live-production?session=rehearsal", true],
    ["/live-production-other", false],
    ["/cuez-storydesk", true], ["/cuez-storydesk?tab=import", true], ["/cuez-other", false],
    ["https://example.test:8443/news?q=NJ#top", true],
    ["javascript:alert(1)", false], ["//example.test", false],
    ["/content/../admin", false], ["/content/%2Fother", false],
    ["https://staff:secret@example.test", false], ["https://example.test/has space", false],
  ])("agrees on the safe URL decision for %s", (url, expected) => {
    expect(isSafeNavigationUrl(url)).toBe(expected);
    expect(server.isSafeNavigationUrl(url)).toBe(expected);
  });
});
