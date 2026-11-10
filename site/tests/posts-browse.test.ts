import { describe, expect, it } from "vitest";
import server from "../../functions/lib/cms-settings-contract.js";
import { DEFAULT_SITE_NAVIGATION, cmsSettingsSchemaFor, currentCmsSettingsSchemaFor, validateCmsSettingsValues, cloneSettingsValues } from "../../packages/content-core/src/cms-settings";
import { DEFAULT_POSTS_BROWSE, validatePostsBrowse, type PostsBrowseConfig } from "../../packages/content-core/src/posts-browse";
import { projectSiteNavigationArtifact } from "../src/lib/site-navigation";
import { postsBrowseCollections, type BrowsePost } from "../src/lib/posts-browse";
const config: PostsBrowseConfig = { groups: [{ id: "schools", label: "Schools", icon: "heart", terms: [{ filter: "category", value: "Education" }, { filter: "tag", value: "schools & families" }], cover: { filter: "tag", value: "schools & families" } }] };
const posts: BrowsePost[] = [{ categories: ["Education"], tags: ["schools & families", "new subject"], image: { url: "/first.webp" } }, { categories: ["education", "Education"], tags: ["schools & families"] }];
describe("Posts browsing", () => {
  it("keeps v1 immutable and validates/clones the initial v2 arrangement identically on the server", () => {
    expect(cmsSettingsSchemaFor("site-navigation", 1)?.fields).not.toHaveProperty("postsBrowse");
    const schema = currentCmsSettingsSchemaFor("site-navigation")!;
    expect(schema.schemaVersion).toBe(2);
    const values = { ...DEFAULT_SITE_NAVIGATION, postsBrowse: DEFAULT_POSTS_BROWSE };
    expect(validateCmsSettingsValues(schema, values)).toBeNull();
    expect(server.validateCmsSettingsValues(server.currentCmsSettingsSchemaFor("site-navigation"), values)).toBeNull();
    const copied = cloneSettingsValues(schema, values);
    expect(copied.postsBrowse).toEqual(DEFAULT_POSTS_BROWSE);
    expect(copied.postsBrowse).not.toBe(DEFAULT_POSTS_BROWSE);
    expect(DEFAULT_POSTS_BROWSE.groups.flatMap(g => g.terms)).toHaveLength(248);
  });
  it.each([
    null,
    { groups: [{ ...config.groups[0], id: "unassigned-subjects" }] },
    { groups: [...config.groups, config.groups[0]] },
    { groups: [{ ...config.groups[0], icon: "unknown" }] },
    { groups: [{ ...config.groups[0], terms: [{ filter: "tag", value: "format:multimedia" }] }] },
    { groups: [{ ...config.groups[0], cover: { filter: "tag", value: "missing" } }] },
    { groups: [{ ...config.groups[0], terms: [{ filter: "tag", value: "" }] }] },
    { groups: [{ ...config.groups[0], href: "javascript:alert(1)" }] },
  ])("rejects invalid arrangements in both contracts", postsBrowse => {
    const schema = currentCmsSettingsSchemaFor("site-navigation")!, values = { ...DEFAULT_SITE_NAVIGATION, postsBrowse };
    const error = validateCmsSettingsValues(schema, values);
    expect(error).toBeTruthy();
    expect(server.validateCmsSettingsValues(server.currentCmsSettingsSchemaFor("site-navigation"), values)).toBe(error);
  });
  it.each([false, true])("rejects a coerced filter even when its cover agrees (%s)", withCover => {
    const term = { filter: ["tag"], value: "schools & families" };
    const postsBrowse = { groups: [{ ...config.groups[0], terms: [term], cover: withCover ? term : undefined }] };
    const error = "Choose an exact category or topic for every subject.";
    expect(validatePostsBrowse(postsBrowse)).toBe(error);
    expect(server.validateCmsSettingsValues(server.currentCmsSettingsSchemaFor("site-navigation"),
      { ...DEFAULT_SITE_NAVIGATION, postsBrowse })).toBe(error);
  });
  it("preserves exact links, case-insensitive Post counts and every unassigned subject", () => {
    const { collections, subjects } = postsBrowseCollections(posts, config);
    expect(subjects).toHaveLength(4);
    expect(subjects.filter(s => s.filter === "category").map(s => s.count)).toEqual([2, 2]);
    expect(subjects.find(s => s.value === "schools & families")?.href).toBe("/posts/?tag=schools+%26+families");
    expect(collections[0].image?.url).toBe("/first.webp");
    expect(collections.at(-1)?.items.map(s => s.value)).toEqual(["education", "new subject"]);
    expect(collections.flatMap(g => g.items).map(i => i.href).sort()).toEqual(subjects.map(i => i.href).sort());
  });
  it("preserves explicitly empty arrangements and never substitutes an unrelated cover image", () => {
    expect(validatePostsBrowse({ groups: [] })).toBeNull();
    expect(postsBrowseCollections(posts, { groups: [] }).collections.map(g => g.id)).toEqual(["unassigned-subjects"]);
    expect(postsBrowseCollections([{ categories: ["Education"], tags: [], image: { url: "/unrelated.webp" } }], config).collections[0].image).toBeUndefined();
  });
  it("uses the published arrangement while working values differ and reads historical v1", () => {
    const published = { schemaVersion: 2, values: { ...DEFAULT_SITE_NAVIGATION, postsBrowse: config }, sourceVersion: 3, publishedAt: "2026-11-04T16:00:00.000Z" };
    const result = projectSiteNavigationArtifact({ id: "site-navigation", schemaVersion: 2, version: 4, values: { ...DEFAULT_SITE_NAVIGATION, postsBrowse: { groups: [] } }, published });
    expect(result.status).toBe("published");
    if (result.status === "published") expect(result.data.postsBrowse).toEqual(config);
    expect(projectSiteNavigationArtifact({ id: "site-navigation", schemaVersion: 1, version: 3, values: DEFAULT_SITE_NAVIGATION, published: { ...published, schemaVersion: 1, values: DEFAULT_SITE_NAVIGATION } }).status).toBe("published");
  });
});
