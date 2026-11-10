import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  PUBLIC_PAGES,
  PUBLIC_PAGE_IDS,
  PUBLIC_SITE_ORIGIN,
  isPublicPageId,
  publicPage,
  publicPageUrl,
  publicPagePath,
  publicPageAliases,
  isAvailablePageSlug,
} from "../../packages/content-core/src/public-pages";
import {
  launchArticlePageSlugs,
  launchFallbackPages,
  launchFallbackRoutePages,
} from "../src/data/launch-fallback";

import {
  classify, REDIRECTS_301, LEGACY_SINGLETONS_410,
  PURE_LEGACY_FAMILIES, LEGACY_TAIL_FAMILIES,
} from "../src/lib/legacy-redirects";

const requireModule = createRequire(import.meta.url);
const serverPageContract = requireModule("../../functions/lib/public-page-contract.js");
const { PAGE_EDITOR_TEMPLATES, PAGE_SECTIONS, PUBLIC_PAGE_DEFINITIONS } = requireModule(
  "../../functions/lib/public-page-contract.js",
) as {
  PAGE_EDITOR_TEMPLATES: Readonly<Record<string, string>>;
  PAGE_SECTIONS: Readonly<Record<string, string>>;
  PUBLIC_PAGE_DEFINITIONS: Readonly<
    Record<string, { path: string; family: string }>
  >;
};

describe("public page registry", () => {
  it("keeps the saved meeting-notices identity and reserves both route names", () => {
    const page = publicPage("public-meetings")!;
    expect(page).toMatchObject({ title: "Meeting notices", path: "/meeting-notices/" });
    expect(publicPageAliases(page, "/meeting-notices/")).toEqual(["/public-meetings/"]);
    for (const slug of ["public-meetings", "meeting-notices"]) {
      expect(isAvailablePageSlug("public-meetings", slug)).toBe(true);
      expect(serverPageContract.isAvailablePageSlug("public-meetings", slug)).toBe(true);
      expect(publicPagePath("public-meetings", { slug })).toBe("/meeting-notices/");
      expect(serverPageContract.publicPagePath("public-meetings", { slug })).toBe("/meeting-notices/");
      expect(isAvailablePageSlug(`page-${"a".repeat(32)}`, slug)).toBe(false);
      expect(serverPageContract.isAvailablePageSlug(`page-${"a".repeat(32)}`, slug)).toBe(false);
    }
    expect(publicPagePath("public-meetings", { slug: "custom-notices" })).toBe("/custom-notices/");
    expect(publicPageAliases(page, "/custom-notices/", ["previous-notices"])).toEqual([
      "/meeting-notices/", "/previous-notices/", "/public-meetings/",
    ]);
  });
  it("keeps custom and reserved URL decisions equal at the save and render boundaries", () => {
    const customId = `page-${"a".repeat(32)}`;
    const ids = [...PUBLIC_PAGE_IDS, customId, "unregistered"];
    const slugs = [undefined, "community", "donate", "posts", "architecture", "data-hub", "bad/path",
      "UPPER", "", "a".repeat(81), ...PUBLIC_PAGES.map(page => page.path.slice(1, -1))];
    for (const id of ids) {
      for (const slug of slugs) {
        expect(isAvailablePageSlug(id, slug)).toBe(serverPageContract.isAvailablePageSlug(id, slug));
        expect(publicPagePath(id, { slug }) ?? null).toBe(serverPageContract.publicPagePath(id, { slug }));
      }
    }
    expect(publicPagePath(customId)).toBeUndefined();
    expect(publicPagePath(customId, { slug: "community" })).toBe("/community/");
    expect(publicPagePath(customId, { slug: "donate" })).toBeUndefined();
    expect(publicPagePath("home", { slug: "community" })).toBeUndefined();
  });

  it("reserves the fixed Data Hub address for its CMS Page at both save and render boundaries", () => {
    const customId = `page-${"a".repeat(32)}`;
    for (const id of [...PUBLIC_PAGE_IDS.filter(id => id !== "data-hub"), customId]) {
      expect(isAvailablePageSlug(id, "data-hub")).toBe(false);
      expect(serverPageContract.isAvailablePageSlug(id, "data-hub")).toBe(false);
      expect(publicPagePath(id, { slug: "data-hub" })).toBeUndefined();
      expect(serverPageContract.publicPagePath(id, { slug: "data-hub" })).toBeNull();
    }
    expect(publicPagePath("data-hub",{slug:"data-hub"})).toBe("/data-hub/");
    expect(serverPageContract.publicPagePath("data-hub",{slug:"data-hub"})).toBe("/data-hub/");
    expect(publicPagePath("data-hub",{slug:"renamed-hub"})).toBeUndefined();
  });

  it("rejects page URLs intercepted by the deployed legacy edge map", () => {
    const paths = new Set([...Object.keys(REDIRECTS_301), ...LEGACY_SINGLETONS_410,
      ...PURE_LEGACY_FAMILIES, ...LEGACY_TAIL_FAMILIES]);
    const ids = [...PUBLIC_PAGE_IDS, `page-${"a".repeat(32)}`];
    for (const path of paths) {
      if (classify(path) === null) continue;
      for (const id of ids) {
        expect(isAvailablePageSlug(id, path.slice(1)), `${id}: ${path}`).toBe(id === "public-meetings" && path === "/public-meetings");
        expect(serverPageContract.isAvailablePageSlug(id, path.slice(1)), `${id}: ${path}`).toBe(id === "public-meetings" && path === "/public-meetings");
      }
    }
    expect(isAvailablePageSlug("give", "donate")).toBe(true);
    expect(classify("/donate/")).toBeNull();
  });

  it("keeps canonical page ids, paths, and aliases unique", () => {
    expect(new Set(PUBLIC_PAGE_IDS).size).toBe(PUBLIC_PAGE_IDS.length);
    const routes = PUBLIC_PAGES.flatMap((page) => [
      page.path,
      ...("aliases" in page ? page.aliases : []),
    ]);
    expect(new Set(routes).size).toBe(routes.length);
    expect(routes.every((path) => path === "/" || /^\/[a-z0-9-]+\/$/.test(path))).toBe(true);
    expect(PUBLIC_SITE_ORIGIN).toBe("https://njpbs.org");
    expect(publicPageUrl(PUBLIC_PAGES[0])).toBe("https://njpbs.org/");
  });

  it("gives every live page one editor template while keeping page identity separate", () => {
    for (const page of PUBLIC_PAGES) {
      expect(isPublicPageId(page.id)).toBe(true);
      expect(["home", "programLanding", "genericPage"]).toContain(page.editorTemplate);
      if (page.id !== "home") expect(page.id).not.toBe(page.editorTemplate);
    }

    expect(publicPage("watch")?.editorTemplate).toBe("programLanding");
    expect(publicPage("contact")?.editorTemplate).toBe("genericPage");
    expect(publicPage("staff")).toMatchObject({
      path: "/staff/",
      family: "staff",
      area: "station",
      editorTemplate: "genericPage",
    });
    expect(isPublicPageId("genericPage")).toBe(false);
  });

  it("keeps the deployed functions page contract in parity with the shared registry", () => {
    expect(PAGE_EDITOR_TEMPLATES).toEqual(
      Object.fromEntries(PUBLIC_PAGES.map((page) => [page.id, page.editorTemplate])),
    );
    expect(PAGE_SECTIONS).toEqual(
      Object.fromEntries(PUBLIC_PAGES.map((page) => [page.id, page.area])),
    );
    expect(PUBLIC_PAGE_DEFINITIONS).toEqual(
      Object.fromEntries(
        PUBLIC_PAGES.map((page) => [
          page.id,
          { path: page.path, family: page.family, ...("aliases" in page ? { aliases: [...page.aliases] } : {}) },
        ]),
      ),
    );
  });

  it("matches the article routes emitted by the public catch-all", () => {
    expect([...launchArticlePageSlugs].sort()).toEqual(
      PUBLIC_PAGES.filter((page) => page.family === "article")
        .map((page) => page.path.slice(1, -1))
        .sort(),
    );
  });

  it("accounts for every fallback document and route, including the donate alias", () => {
    const fallbackIds = PUBLIC_PAGES.filter((page) => page.family === "service").map(
      (page) => page.id,
    );
    expect(Object.keys(launchFallbackPages).sort()).toEqual(
      [...fallbackIds, "schedule", "donate"].sort(),
    );
    expect(launchFallbackRoutePages.map((page) => page.slug).sort()).toEqual(
      [...fallbackIds, "donate"].sort(),
    );
    expect(publicPage("give")?.aliases).toEqual(["/donate/"]);
  });
});
