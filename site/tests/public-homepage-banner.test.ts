import { describe, expect, it } from "vitest";
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
