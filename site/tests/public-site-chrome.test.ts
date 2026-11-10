import { describe, expect, it } from "vitest";
import {
  DEFAULT_PUBLIC_SITE_CHROME_SETTINGS,
  PUBLIC_SITE_CHROME_SETTINGS_ID,
} from "../../packages/content-core/src/cms-settings";
import { newsletterSignupUrl } from "../src/data/launch-fallback";
import { resolvePublicSiteChromeNewsletter } from "../../packages/content-core/src/public-site-chrome";
import { projectPublicSiteChromeArtifact } from "../src/lib/public-site-chrome";

const publishedAt = "2026-09-21T19:00:00.000Z";
const newsletter = {
  newsletterEnabled: true,
  newsletterLabel: "Newsletter",
  newsletterHref: "/newsletter/",
  newsletterOpensInNewTab: false,
};

function document(published: Record<string, unknown>) {
  return {
    id: PUBLIC_SITE_CHROME_SETTINGS_ID,
    schemaVersion: 1,
    version: 4,
    values: { ...newsletter, newsletterLabel: "Working label" },
    published: { schemaVersion: 1, sourceVersion: 3, publishedAt, ...published },
  };
}

const defaultNewsletter = {
  enabled: true,
  label: "Subscribe to the newsletter",
  href: newsletterSignupUrl,
  opensInNewTab: false,
};

describe("public-site chrome settings", () => {
  it("keeps the current header action as the source default", () => {
    expect(resolvePublicSiteChromeNewsletter(undefined)).toEqual(defaultNewsletter);
    expect(DEFAULT_PUBLIC_SITE_CHROME_SETTINGS.newsletterHref).toBe(newsletterSignupUrl);
  });

  it("reports an absent or unpublished document without a bundle entry", () => {
    expect(projectPublicSiteChromeArtifact(undefined)).toEqual({ status: "missing" });
    expect(projectPublicSiteChromeArtifact({
      id: PUBLIC_SITE_CHROME_SETTINGS_ID,
      schemaVersion: 1,
      version: 1,
      values: newsletter,
    })).toEqual({ status: "unpublished" });
  });

  it("projects only the detached published snapshot", () => {
    const projected = projectPublicSiteChromeArtifact(document({ values: newsletter }));
    expect(projected.status).toBe("published");
    expect(projected.status === "published" && projected.data).toEqual({
      settingId: PUBLIC_SITE_CHROME_SETTINGS_ID,
      ...newsletter,
      sourceVersion: 3,
      publishedAt,
    });
  });

  it("falls back with the exact version for unsafe or page-relative links", () => {
    for (const newsletterHref of ["javascript:alert(1)", "newsletter", "//evil.example/"]) {
      expect(projectPublicSiteChromeArtifact(document({
        values: { ...newsletter, newsletterHref },
      }))).toMatchObject({ status: "invalid", sourceVersion: 3 });
      expect(resolvePublicSiteChromeNewsletter({ ...newsletter, newsletterHref }))
        .toEqual(defaultNewsletter);
    }
  });

  it("resolves a valid saved action and limits new tabs to web addresses", () => {
    expect(resolvePublicSiteChromeNewsletter({
      ...newsletter,
      newsletterEnabled: false,
      newsletterHref: "https://example.org/newsletter",
      newsletterOpensInNewTab: true,
    })).toEqual({
      enabled: false,
      label: "Newsletter",
      href: "https://example.org/newsletter",
      opensInNewTab: true,
    });
    expect(resolvePublicSiteChromeNewsletter({
      ...newsletter,
      newsletterHref: "mailto:news@example.org",
      newsletterOpensInNewTab: true,
    }).opensInNewTab).toBe(false);
  });
});
