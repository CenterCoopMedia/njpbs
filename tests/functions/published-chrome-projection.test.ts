import { expect, it } from "vitest";
import live from "../../functions/published-post-reader.js";
import legacy from "../fixtures/published-chrome-legacy.cjs";
import core from "../../functions/lib/published-chrome-projection.js";
import contract from "../../functions/lib/cms-settings-contract.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import deployment from "../../functions/lib/public-deployment.js";
import media from "../../functions/lib/media-contract.js";
import { chromeSettings, newsPageId } from "../../site/tests/fixtures/shadow-posts/chrome";
import { releaseSelector } from "../helpers/private-public-release-pair.js";
import sourceBody from "../../functions/lib/public-release-source-body.js";
const now = new Date("2026-10-28T12:00:00.000Z");
function document(id: string, slug?: string) {
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: { id, version: 1, title: "Published navigation", blocks: [], ...(slug ? { slug } : {}) },
    publishedAt: "2026-10-01T12:00:00.000Z", publishedBy: "editor" });
  return { version: 1, status: "published", publiclyVisible: true, publishAt: published.publishedAt, published };
}
function store(records: Map<string, any>) {
  const trace: unknown[] = [];
  const snapshot = (path: string) => ({ id: path.split("/").at(-1)!, ref: { path }, exists: records.has(path), data: () => records.get(path) });
  const firestore = { doc: (path: string) => ({ path }), collection: (path: string) => ({ path, field: "", value: "", count: 0, filters: [] as { field: string; value: unknown }[],
    where(field: string, _operator: string, value: unknown) { return { ...this, field, value, filters: [...this.filters, { field, value }] }; },
    select(..._fields: string[]) { return this; },
    limit(count: number) { return { ...this, count }; } }) };
  const transaction = { getAll: async (...refs: { path: string }[]) => { trace.push(["getAll", refs.map(ref => ref.path)]); return refs.map(ref => snapshot(ref.path)); }, get: async (ref: any) => {
    trace.push(["get", ref.path, ref.field ?? null, ref.value ?? null, ref.count ?? null]);
    if (!ref.field) return snapshot(ref.path);
    const rows = [...records].filter(([path, doc]) => path.startsWith(`${ref.path}/`) && ref.filters.every(({ field, value }: any) => field.split(".").reduce((v: any, key: string) => v?.[key], doc) === value))
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0, ref.count);
    return { docs: rows.map(([path]) => snapshot(path)) };
  } };
  return { firestore, transaction, trace };
}
function records() {
  return new Map<string, any>([...chromeSettings("Frozen newsletter").map(setting => [`cmsSettings/${setting.id}`, setting] as [string, any]),
    ["cmsPages/about", document("about")], [`cmsPages/${newsPageId}`, document(newsPageId, "in-the-news")]]);
}
const modes = ["normal", "unknown", "legacy", "hidden", "future", "news-query-limit", "brand-seed", "brand-upload", "brand-unready", "brand-mismatch", "invalid-settings"];
it.each(modes)("keeps legacy live-reader JSON byte-identical and frozen projection equal: %s", async mode => {
  const input = records();
  if (mode === "unknown") input.set("cmsPages/obsolete-route", document("about", "obsolete"));
  if (mode === "legacy") input.set("cmsPages/about", { ...document("about"), published: { blocks: [], publishedAt: "2026-10-01T12:00:00.000Z" } });
  if (mode === "hidden") input.set("cmsPages/about", { ...document("about"), publiclyVisible: false });
  if (mode === "future") input.set("cmsPages/about", { ...document("about"), publishAt: "2030-01-01T00:00:00.000Z" });
  if (mode === "news-query-limit") {
    input.set("cmsPages/aaa-obsolete", document("about", "in-the-news"));
    input.set("cmsPages/aab-obsolete", document("about", "in-the-news"));
    input.set(`cmsPages/page-${"a".repeat(32)}`, document(`page-${"a".repeat(32)}`, "in-the-news"));
  }
  if (mode.startsWith("brand-")) {
    input.set("cmsSettings/nj-decides-brand", { version: 2, published: { schemaVersion: 1, sourceVersion: 1,
      publishedAt: "2026-10-01T12:00:00.000Z", values: { ...contract.DEFAULT_NJ_DECIDES_SETTINGS, logoAssetId: "brand", logoAlt: "Frozen brand" } } });
    const image = { source: mode === "brand-seed" ? "site_seed" : "upload", lifecycle: "active", mimeType: "image/png",
      url: "https://media.njpbs.org/cms-media/fixture/brand.png", altText: "Brand", width: 800, height: 300 };
    input.set("media_assets/brand", image); input.set("media_assets_public/brand", media.mediaProjection(image));
    if (mode === "brand-mismatch") input.set("media_assets_public/brand", { ...media.mediaProjection(image), url: "https://media.njpbs.org/cms-media/fixture/different.png" });
    if (mode !== "brand-unready") input.set("system/publicDeployment", { ...deployment.initialPublicDeploymentPointer(), mediaLifecycleReady: true,
      activeGeneration: 1, activeDeploymentId: "original", activeCommitSha: "a".repeat(40), lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "original" });
  }
  if (mode === "invalid-settings") input.set("cmsSettings/public-site-chrome", { version: 1, published: { invalid: true } });
  const read = store(input), original = await legacy.readPublishedChrome(read.firestore, read.transaction, now);
  const currentRead = store(input);
  const current = await live.readPublishedChrome(currentRead.firestore, currentRead.transaction, now);
  // Coverage labels add one published settings dependency; every other legacy read remains exact.
  expect(currentRead.trace[0]).toEqual(["getAll", ["cmsSettings/site-navigation", "cmsSettings/public-site-chrome",
    "cmsSettings/nj-decides-brand", "cmsSettings/public-homepage-banner", "cmsSettings/coverage-labels"]]);
  expect(currentRead.trace.slice(1, -2)).toEqual(read.trace.slice(1));
  expect(currentRead.trace.slice(-2)).toEqual([
    ["get", "cmsPages", "publiclyVisible", true, 500],
    ["get", "cmsPosts", "publiclyVisible", true, 500],
  ]);
  expect(JSON.stringify(current)).toBe(JSON.stringify(original));
  expect(JSON.stringify(core.projectPublishedChromeRecords(input, now))).toBe(JSON.stringify(original));
});
it("keeps the strict banner refusal unchanged", async () => {
  const input = records(); input.set("cmsSettings/public-homepage-banner", { version: 1, published: { invalid: true } });
  const read = store(input);
  await expect(legacy.readPublishedChrome(read.firestore, read.transaction, now, { strictBanner: true })).rejects.toThrow();
  await expect(live.readPublishedChrome(read.firestore, read.transaction, now, { strictBanner: true })).rejects.toThrow();
  expect(() => core.projectPublishedChromeRecords(input, now, { strictBanner: true })).toThrow();
});

it("preserves the existing invalid home URL refusal", async () => {
  const input = records(); input.set("cmsPages/home", document("home", "incorrect-home-slug"));
  const read = store(input);
  await expect(legacy.readPublishedChrome(read.firestore, read.transaction, now)).rejects.toThrow("Published page has an invalid URL");
  await expect(live.readPublishedChrome(read.firestore, read.transaction, now)).rejects.toThrow("Published page has an invalid URL");
  expect(() => core.projectPublishedChromeRecords(input, now)).toThrow("Published page has an invalid URL");
});
it.each(["ready", "missing", "wrong-epoch", "wrong-generation", "missing-recovery"])(
  "checks live and frozen uploaded branding against actual pair media records: %s", async mode => {
    const input = records(), selector = releaseSelector();
    input.set("cmsSettings/nj-decides-brand", { version: 2, published: { schemaVersion: 1, sourceVersion: 1,
      publishedAt: "2026-10-01T12:00:00.000Z", values: { ...contract.DEFAULT_NJ_DECIDES_SETTINGS, logoAssetId: "brand", logoAlt: "Frozen brand" } } });
    const image = { source: "upload", lifecycle: "active", mimeType: "image/png",
      url: "https://media.njpbs.org/cms-media/fixture/brand.png", altText: "Brand", width: 800, height: 300 };
    input.set("media_assets/brand", image); input.set("media_assets_public/brand", media.mediaProjection(image));
    input.set("system/publicDeployment", selector);
    const pairMedia = { schemaVersion: 2, epoch: selector.epoch, activeGeneration: selector.activeGeneration,
      lastReservedGeneration: selector.activeGeneration, newestEligibleGeneration: selector.activeGeneration,
      references: [selector.selectedPair, selector.recoveryPair].map(pair => ({ pairId: pair.pairId, manifestDigest: "f".repeat(64) })) };
    if (mode === "wrong-epoch") pairMedia.epoch++;
    if (mode === "wrong-generation") pairMedia.activeGeneration++;
    if (mode === "missing-recovery") pairMedia.references.pop();
    if (mode !== "missing") input.set("system/publicDeployment/pairMedia/current", pairMedia);
    const boundary = store(input), current = await live.readPublishedChrome(boundary.firestore, boundary.transaction, now);
    const brand = current.settings.find((setting: any) => setting.id === "nj-decides-brand")!;
    if (mode === "ready") expect(brand.assets?.brand).toMatchObject({ url: image.url });
    else expect(brand.assets).toEqual({});
    // Frozen H retains the real schema-two root and pair-media authority.
    // Invalid frozen authority cannot manufacture legacy upload readiness.
    const frozenRecords = new Map(input);
    frozenRecords.set("system/publicDeployment", sourceBody.publicReleaseAuthorityDocument("system/publicDeployment", selector));
    const frozen = core.projectPublishedChromeRecords(frozenRecords, now);
    const frozenBrand = frozen.settings.find((setting: any) => setting.id === "nj-decides-brand")!;
    if (mode === "ready") expect(frozenBrand.assets?.brand).toMatchObject({ url: image.url });
    else expect(frozenBrand.assets).toEqual({});
    expect(frozen).toEqual(current);
    expect(boundary.trace).toContainEqual(["get", "system/publicDeployment/pairMedia/current", null, null, null]);
  });
