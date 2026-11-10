import { describe, expect, it } from "vitest";
import { DEFAULT_NJ_DECIDES_SETTINGS, DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS } from "../../packages/content-core/src/cms-settings";
import { projectChrome, projectPublishedPostRead } from "../src/lib/published-post-shadow";
import { chromeSettings } from "./fixtures/shadow-posts/chrome";
import post from "./fixtures/shadow-posts/post.json";

function fourSettings() {
  return [...chromeSettings(),
    { id: "nj-decides-brand", version: 4, values: { private: "Working draft" },
      published: { schemaVersion: 1, sourceVersion: 3, publishedAt: "2026-10-26T17:00:00.000Z", values: { ...DEFAULT_NJ_DECIDES_SETTINGS } } },
    { id: "public-homepage-banner", version: 4, values: { private: "Working draft" },
      published: { schemaVersion: 2, sourceVersion: 3, publishedAt: "2026-10-26T17:00:00.000Z", values: { ...DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS } } },
  ];
}

describe("published Post chrome release compatibility", () => {
  it.each([2, 4])("projects %i known settings through the Post read", count => {
    const settings = fourSettings().slice(0, count);
    const content = projectPublishedPostRead({ ...post, settings }, "shadow-fixture", "a".repeat(40), new Date("2026-10-27T12:00:00Z"))!;
    expect(content.settings.map(setting => setting.settingId)).toEqual(settings.map(setting => setting.id));
    expect(JSON.stringify(content.settings)).not.toContain("Working draft");
    expect(content.settings.every(setting => setting.sourceVersion === 3)).toBe(true);
  });

  it("ignores extra unknown IDs without inspecting or copying their values", () => {
    const settings = fourSettings();
    const future = { id: "future-chrome", published: { invalidForThisRenderer: true } };
    const projected = projectChrome({ settings: [...settings, future, future, { id: "another-new-setting" }] });
    expect(projected).toEqual(projectChrome({ settings }));
    const content = projectPublishedPostRead({ ...post, settings: [...settings, future] },
      "shadow-fixture", "a".repeat(40), new Date("2026-10-27T12:00:00Z"))!;
    expect(content.settings).toEqual(projected.settings);
    expect(JSON.stringify(content)).not.toContain("future-chrome");
  });

  it.each([0, 1, 2, 3])("still refuses an invalid published snapshot for known setting %i", index => {
    const settings = fourSettings();
    settings[index].published.sourceVersion = 0;
    expect(() => projectChrome({ settings: [...settings, { id: "future-chrome" }] })).toThrow();
  });

  it.each([0, 1, 2, 3])("still refuses duplicate known setting %i", index => {
    const settings = fourSettings();
    expect(() => projectChrome({ settings: [...settings, settings[index]] })).toThrow("Duplicate published chrome");
  });

  it.each([0, 1, 2, 3])("still validates the values of known setting %i", index => {
    const settings = fourSettings();
    Object.assign(settings[index].published, { values: { unrecognized: true } });
    expect(() => projectChrome({ settings: [...settings, { id: "future-chrome" }] })).toThrow();
  });

  it.each([null, [], {}, { id: 1 }, { id: "" }])("refuses a malformed setting identity %j", document => {
    expect(() => projectChrome({ settings: [...fourSettings(), document] })).toThrow("Invalid published setting");
  });

  it("keeps the published input size bound even for ignored documents", () => {
    expect(() => projectPublishedPostRead({ ...post, settings: [{ id: "future-chrome", values: "x".repeat(2 * 1024 * 1024) }] },
      "shadow-fixture", "a".repeat(40), new Date("2026-10-27T12:00:00Z"))).toThrow("Published read too large");
  });
});
