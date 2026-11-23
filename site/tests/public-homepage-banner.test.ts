import { describe, expect, it } from "vitest";
import { homepageBannerWindow } from "../../packages/content-core/src/homepage-banner-window";
import { renderHomepageAnnouncement } from "../../packages/content-core/src/homepage-announcement-render";
import {
  PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
  projectPublicHomepageBanner,
} from "../src/lib/public-homepage-banner";

const published = {
  schemaVersion: 1,
  values: {
    enabled: true,
    message: "Watch the NJ PBS community update.",
    linkLabel: "Read the update",
    linkHref: "/about/",
  },
  sourceVersion: 7,
  publishedAt: "2026-08-31T14:00:00.000Z",
};

describe("public homepage banner projection", () => {
  it("projects only the validated published snapshot", () => {
    expect(projectPublicHomepageBanner({
      id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      version: 8,
      values: {
        enabled: true,
        message: "Unpublished draft",
        linkLabel: "Draft link",
        linkHref: "/draft/",
      },
      published,
    })).toEqual({
      settingId: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      enabled: true,
      message: "Watch the NJ PBS community update.",
      link: { label: "Read the update", href: "/about/" },
      sourceVersion: 7,
      publishedAt: "2026-08-31T14:00:00.000Z",
    });
  });

  it("returns no artifact when the setting is missing or unpublished", () => {
    expect(projectPublicHomepageBanner(undefined)).toBeNull();
    expect(projectPublicHomepageBanner({
      id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      version: 2,
      values: { enabled: true, message: "Draft only" },
    })).toBeNull();
  });

  it("keeps a valid disabled published setting for exact receipt proof", () => {
    expect(projectPublicHomepageBanner({
      id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      version: 7,
      published: {
        ...published,
        values: { enabled: false, message: "A saved public update" },
      },
    })).toEqual({
      settingId: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      enabled: false,
      message: "A saved public update",
      sourceVersion: 7,
      publishedAt: "2026-08-31T14:00:00.000Z",
    });
  });

  it("keeps receipt evidence for an unconfigured standard mode without exposing the saved election content", () => {
    expect(projectPublicHomepageBanner({
      id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      version: 7,
      published: {
        ...published,
        schemaVersion: 5,
        values: {
          njDecides: false,
          standard: { enabled: false, message: "" },
          election: { enabled: true, message: "Election coverage", linkLabel: "Results", linkHref: "/results/" },
        },
      },
    })).toEqual({
      settingId: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      enabled: false,
      njDecides: false,
      message: "",
      sourceVersion: 7,
      publishedAt: "2026-08-31T14:00:00.000Z",
    });
  });

  it("projects current election content without including the saved standard banner", () => {
    expect(projectPublicHomepageBanner({
      id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      version: 7,
      published: {
        ...published,
        schemaVersion: 6,
        values: {
          njDecides: true,
          standard: { enabled: true, message: "Homepage update", linkLabel: "Read more", linkHref: "/about/",
            startsAt: "2026-11-06T23:00:00.000Z", backgroundColor: "#151d40" },
          election: { enabled: true, message: "Election coverage", linkLabel: "Results", linkHref: "/results/",
            endsAt: "2026-11-04T06:00:00.000Z" },
        },
      },
    })).toEqual({
      settingId: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      enabled: true,
      njDecides: true,
      message: "Election coverage",
      link: { label: "Results", href: "/results/" },
      endsAt: "2026-11-04T06:00:00.000Z",
      sourceVersion: 7,
      publishedAt: "2026-08-31T14:00:00.000Z",
    });
  });

  it("uses the standard schedule and colors only from the published standard mode", () => {
    const startsAt = "2026-11-03T23:00:00.000Z";
    const endsAt = "2026-11-04T06:00:00.000Z";
    const colors = { backgroundColor: "#151d40", textColor: "#fff0cc", linkColor: "#b5cbff" };
    const standardPresentation = { startsAt, endsAt, ...colors };
    const values = { njDecides: false, standard: { ...published.values, ...standardPresentation },
      election: { enabled: true, message: "Election only", endsAt: "2026-11-06T06:00:00.000Z" } };
    const data = projectPublicHomepageBanner({
      id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      version: 8,
      values: { ...values, standard: { ...values.standard, backgroundColor: "#212144" } },
      published: { ...published, schemaVersion: 6, values },
    });
    expect(data?.standardPresentation).toEqual(standardPresentation);
    expect(data?.endsAt).toBeUndefined();
    const schedule = { enabled: data?.enabled, ...data?.standardPresentation };
    expect(homepageBannerWindow(schedule, Date.parse(startsAt) - 1).visible).toBe(false);
    expect(homepageBannerWindow(schedule, Date.parse(startsAt)).visible).toBe(true);
    expect(homepageBannerWindow(schedule, Date.parse(endsAt)).visible).toBe(false);
    const markup = renderHomepageAnnouncement({ message: data!.message, link: data!.link, colors: data!.standardPresentation });
    expect(markup).toContain("--announcement-background:#151d40;--announcement-text:#fff0cc;--announcement-link:#b5cbff");

    const legacy = projectPublicHomepageBanner({
      id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      version: 7,
      published: { ...published, schemaVersion: 4, values: { ...published.values, startsAt, endsAt } },
    });
    expect(legacy?.standardPresentation).toBeUndefined();
  });

  it("projects an empty NJ Decides band and its optional schedule fields", () => {
    expect(projectPublicHomepageBanner({
      id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      version: 10,
      published: {
        schemaVersion: 2,
        values: {
          enabled: true,
          message: "",
          njDecides: true,
          liveLabel: "Live",
          startsAt: "2026-11-03T23:00:00.000Z",
          endsAt: "2026-11-04T06:00:00.000Z",
        },
        sourceVersion: 9,
        publishedAt: "2026-10-26T18:00:00.000Z",
      },
    })).toEqual({
      settingId: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      enabled: true,
      message: "",
      njDecides: true,
      liveLabel: "Live",
      startsAt: "2026-11-03T23:00:00.000Z",
      endsAt: "2026-11-04T06:00:00.000Z",
      sourceVersion: 9,
      publishedAt: "2026-10-26T18:00:00.000Z",
    });
  });

  it.each([
    [{ ...published, values: { enabled: true, message: "" } }],
    [{ ...published, values: { enabled: true, message: "Update", linkLabel: "Read" } }],
    [{ ...published, values: { enabled: true, message: "Update", linkLabel: "Read", linkHref: "javascript:alert(1)" } }],
    [{ ...published, sourceVersion: 0 }],
    [{ ...published, extra: true }],
  ])("rejects an invalid published snapshot", (invalidPublished) => {
    expect(() => projectPublicHomepageBanner({
      id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      version: 7,
      published: invalidPublished,
    })).toThrow(/homepage banner/i);
  });

  it("rejects every document id except the fixed public setting", () => {
    expect(() => projectPublicHomepageBanner({
      id: "another-setting",
      published,
    })).toThrow(/homepage banner/i);
  });
});
