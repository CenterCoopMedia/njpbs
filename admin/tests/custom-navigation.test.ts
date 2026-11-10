import { describe, expect, it } from "vitest";
import { isSafeNavigationUrl, normalizeNavigationUrl, parseCustomNavigation, type CustomNavItem } from "../src/lib/custom-navigation";
import { parseNavigationPreferences, resolveNavigation, storedFromResolved, moveDestination, setDestinationHidden } from "../src/lib/navigation-preferences";
import { customNavDestinations, customSettingsDestinations } from "../src/lib/custom-nav-destinations";
import { eligibleNavDestinations, NAV_DESTINATIONS } from "../src/lib/nav-destinations";
import type { Principal } from "../../packages/content-core/src/rbac";
const principal: Principal = { id: "fixture", grants: [{ role: "super_admin" }] };
const link: CustomNavItem = { id: "custom:station", kind: "link", label: "Station", destination: { kind: "url", url: "https://example.test/station" } };
const section: CustomNavItem = { id: "custom:desk", kind: "section", label: "My desk", links: [
  { id: "custom:post", kind: "link", label: "My post", destination: { kind: "post", id: "post-123" } },
  { id: "custom:page", kind: "link", label: "Home page", destination: { kind: "page", id: "home" } },
] };

describe("custom navigation contract", () => {
  it.each(["https://example.test", "https://example.test/path?q=hello#top", "/", "/content/post/post-123/edit", "/account/settings", "/admin/settings/costs"])("allows safe destination %s", url => expect(isSafeNavigationUrl(url)).toBe(true));
  it.each(["javascript:alert(1)", "data:text/html,test", "http://example.test", "//example.test", "/\\example.test", "/\n/example.test", "https://user:pass@example.test", "https://", "/unknown", "/content/../admin/settings", "/content/%2e%2e/admin", "/content/%2f%2fevil", "https://example.test/has space"])("refuses unsafe destination %s", url => expect(isSafeNavigationUrl(url)).toBe(false));
  it("normalizes pasted same-origin CMS addresses", () => {
    expect(normalizeNavigationUrl(" https://cms.example.test/content?q=post ", "https://cms.example.test")).toBe("/content?q=post");
    expect(normalizeNavigationUrl("https://other.test/content", "https://cms.example.test")).toBe("https://other.test/content");
  });
  it("migrates v3 without moving or hiding any additional entry", () => {
    expect(parseNavigationPreferences({ version: 3, order: ["posts", "home"], hidden: ["media"] })).toEqual({ version: 4, order: ["posts", "home"], hidden: ["media"], custom: [] });
  });
  it("round trips a link and a section with immutable content IDs", () => {
    const preferences = { version: 4, order: ["custom:station", "home", "custom:desk"], hidden: [], custom: [link, section] };
    expect(parseNavigationPreferences(JSON.parse(JSON.stringify(preferences)))).toEqual(preferences);
    const destinations = customNavDestinations(preferences, principal);
    expect(destinations[1].subitems?.map(item => item.to)).toEqual(["/content/post/post-123/edit", "/content/pages/home/edit"]);
    expect(destinations[0].external).toBe(true);
  });
  it("rejects unsafe, malformed, duplicate and oversized custom items", () => {
    expect(parseCustomNavigation([{ ...link, destination: { kind: "url", url: "javascript:alert(1)" } }])).toBeNull();
    expect(parseCustomNavigation([{ ...link, label: " " }])).toBeNull();
    expect(parseCustomNavigation([{ ...link, label: "x".repeat(61) }])).toBeNull();
    expect(parseCustomNavigation([{ ...link, destination: { kind: "url", url: `https://example.test/${"x".repeat(2048)}` } }])).toBeNull();
    expect(parseCustomNavigation([link, link])).toBeNull();
    expect(parseCustomNavigation([{ ...section, links: [{ ...section }] }])).toBeNull();
    expect(parseCustomNavigation(Array.from({ length: 11 }, (_, i) => ({ ...link, id: `custom:${i}` })))).toBeNull();
    expect(parseCustomNavigation([{ ...section, links: Array.from({ length: 10 }, (_, i) => ({ ...link, id: `custom:${i}` })) }])).toBeNull();
  });
  it("accepts the ten-entry boundary for links and section children", () => {
    const links = Array.from({ length: 10 }, (_, i) => ({ ...link, id: `custom:${i}` }));
    expect(parseCustomNavigation(links)).toEqual(links);
    const boundedSection = { ...section, links: links.slice(0, 9) };
    expect(parseCustomNavigation([boundedSection])).toEqual([boundedSection]);
  });
  it("reorders and hides custom entries with built-in entries and retains them on save", () => {
    const stored = { version: 4, order: ["custom:station", "home"], hidden: [], custom: [link] };
    const eligible = [...eligibleNavDestinations(principal), ...customSettingsDestinations([link])];
    const initial = resolveNavigation(stored, eligible);
    const moved = moveDestination(initial, "custom:station", 1);
    const hidden = setDestinationHidden(moved, "custom:station", true);
    const saved = storedFromResolved(hidden, stored, [...NAV_DESTINATIONS, ...customSettingsDestinations([link])]);
    expect(saved.custom).toEqual([link]);
    expect(saved.hidden).toContain("custom:station");
    expect(saved.order.indexOf("custom:station")).toBe(1);
    expect(setDestinationHidden(hidden, "home", true).find(row => row.destination.id === "home")?.hidden).toBe(false);
  });
  it("keeps capability checks above URL and section preferences", () => {
    const guideOnly: Principal = { id: "guide", grants: [{ role: "staff" }] };
    const restricted: CustomNavItem = { ...link, destination: { kind: "url", url: "/admin/settings" } };
    expect(customNavDestinations({ version: 4, order: [], hidden: [], custom: [restricted, section] }, guideOnly)).toEqual([]);
    expect(customNavDestinations({ version: 4, order: [], hidden: ["custom:post"], custom: [section] }, principal)[0].subitems?.map(item => item.id)).toEqual(["custom:page"]);
  });
  it.each(["support", "watch", "compliance"])("keeps custom page links for a %s-scoped editor", area => {
    const scoped: Principal = { id: "scoped", grants: [{ role: "editor", sections: [area] }] };
    const pageLink: CustomNavItem = { ...link, destination: { kind: "page", id: `page-${"a".repeat(32)}` } };
    const homeLink: CustomNavItem = { ...link, id: "custom:home", destination: { kind: "page", id: "home" } };
    const preferences = { version: 4, order: [], hidden: [], custom: [pageLink, homeLink] };
    expect(customNavDestinations(preferences, scoped).map(entry => entry.id)).toEqual([pageLink.id]);
    expect(customNavDestinations(preferences, { id: "scoped", grants: [{ role: "staff" }] })).toEqual([]);
  });
  it("fails closed on an unsafe render input", () => {
    expect(customNavDestinations({ version: 4, order: [], hidden: [], custom: [{ ...link, destination: { kind: "url", url: "data:text/html,x" } }] }, principal)).toEqual([]);
  });
});
