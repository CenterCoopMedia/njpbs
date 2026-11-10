// @vitest-environment node
import { describe, expect, it } from "vitest";
import { exportRecordCards } from "../src/lib/record-card-resolution";
import { createHomeNewsletterSnapshot, readHomeServiceSources } from "../../packages/content-core/src/home-service-sources";
import copy from "./fixtures/home-sources/newsletter-public-copy.json";
import fixture from "./fixtures/home-v2-selections.json";
import { boundHomeNewsletterCatalog, readHomeEditorialCatalog, homeCatalogJson } from "../../packages/content-core/src/home-source-catalog";

const cutoffAt = "2026-10-11T14:44:00Z";
const record = { id: "published-newsletter", type: "newsletter", status: "draft", version: 2,
  title: "Private working title", signupUrl: "https://private.example.test/", imageAssetId: "working-art",
  approvedLibraryVersion: { type: "newsletter", status: "approved", version: 1,
    title: copy.title, summary: copy.summary, signupUrl: copy.signupUrl, imageAssetId: "approved-art", imageAlt: "Approved Newsletter artwork",
    body: { type: "doc", content: [] } } };
const assets = [{ id: "approved-art", url: "https://media.njpbs.org/cms-media/newsletter.webp", mimeType: "image/webp", width: 1280, height: 720 }];
const exported = () => exportRecordCards([record], [], new Date(cutoffAt), assets);

describe("public Home Newsletter source projection", () => {
  it("retains only the approved public fields and artwork from the real export owner", () => {
    const output = createHomeNewsletterSnapshot(exported(), cutoffAt, cutoffAt);
    expect(output).toEqual({ status: "ready", checkedAt: cutoffAt, records: [{
      id: record.id, kind: "newsletter", href: null, sourceVersion: 1,
      newsletter: { card: { title: copy.title, signupUrl: copy.signupUrl, summary: copy.summary,
        imageAlt: "Approved Newsletter artwork" }, image: { url: assets[0].url } },
    }] });
    expect(JSON.stringify(output)).not.toMatch(/Private|working-art/);
    expect(createHomeNewsletterSnapshot([record], cutoffAt, cutoffAt)).toEqual({ status: "ready", checkedAt: cutoffAt, records: [] });
  });

  it("bounds only eligible Newsletters and retains a saved selection beyond the recent picker window", () => {
    const unrelated = Array.from({ length: 1500 }, (_, index) => ({ id: `program-${index}`, kind: "program" }));
    expect(createHomeNewsletterSnapshot([...unrelated, ...exported()], cutoffAt, cutoffAt)).toEqual(createHomeNewsletterSnapshot(exported(), cutoffAt, cutoffAt));
    const newsletters = Array.from({ length: 201 }, (_, index) => ({ ...exported()[0], id: `newsletter-${String(index).padStart(3, "0")}` }));
    const result = createHomeNewsletterSnapshot(newsletters, cutoffAt, cutoffAt, ["newsletter-200"]);
    if (result.status !== "ready") throw new Error("Expected approved source");
    expect(result.records).toHaveLength(200);
    expect(result.records.some(record => (record as { id: string }).id === "newsletter-200")).toBe(true);
    expect(new Set(result.records.map(record => (record as { id: string }).id)).size).toBe(200);
  });

  it("preserves explicit error/empty snapshots and refuses future, duplicate or unprojected input", () => {
    const value = { newsletters: createHomeNewsletterSnapshot(exported(), cutoffAt, cutoffAt) };
    expect(readHomeServiceSources(value, cutoffAt)).toEqual(value);
    expect(readHomeServiceSources({ newsletters: { status: "error" } }, cutoffAt)).toEqual({ newsletters: { status: "error" } });
    expect(() => readHomeServiceSources({ newsletters: { status: "ready", checkedAt: "2026-10-12T00:00:00Z", records: [] } }, cutoffAt)).toThrow();
    expect(() => readHomeServiceSources({ newsletters: { status: "ready", checkedAt: cutoffAt, records: [...exported(), ...exported()] } }, cutoffAt)).toThrow();
    expect(() => readHomeServiceSources({ newsletters: { status: "ready", checkedAt: cutoffAt, records: exported() } }, cutoffAt)).toThrow();
    expect(() => readHomeServiceSources({ ...value, privateData: "unprojected" }, cutoffAt)).toThrow();
    expect(() => readHomeServiceSources(Object.assign(Object.create(value), { unexpected: true }), cutoffAt)).toThrow();
    expect(() => readHomeServiceSources({ newsletters: Object.assign(Object.create({ status: "error" }), { unexpected: true }) }, cutoffAt)).toThrow();
  });
  it("fits public byte capacity without trimming unsafe input or replacing a saved eligible ID", () => {
    const time = fixture.editorial.catalog.cutoffAt;
    const records = Array.from({ length: 200 }, (_, index) => ({ id: `long-${String(index).padStart(3, "0")}`,
      kind: "newsletter", href: null, sourceVersion: 1, newsletter: { card: { title: "T".repeat(300),
        summary: "S".repeat(300), signupUrl: "https://example.org/" + "a".repeat(1900) } } }));
    const candidate = { ...fixture.editorial.catalog, services: { newsletters: createHomeNewsletterSnapshot(records, time, time) } };
    expect(() => readHomeEditorialCatalog(candidate)).toThrow("too large");
    const fitted = boundHomeNewsletterCatalog(candidate, ["long-199"]);
    expect(new TextEncoder().encode(homeCatalogJson(fitted)).byteLength).toBeLessThanOrEqual(400_000);
    if (fitted.services!.newsletters.status !== "ready") throw new Error("Expected eligible choices");
    expect(fitted.services!.newsletters.records.some(record => (record as { id: string }).id === "long-199")).toBe(true);
    expect(fitted.sources).toEqual(readHomeEditorialCatalog(fixture.editorial.catalog).sources);
    const unsafe = structuredClone(candidate);
    if (unsafe.services.newsletters.status !== "ready") throw new Error("Expected eligible choices");
    (unsafe.services.newsletters.records[199] as { newsletter: { card: { signupUrl: string } } }).newsletter.card.signupUrl = "javascript:alert(1)";
    expect(() => boundHomeNewsletterCatalog(unsafe)).toThrow();
  });
});
