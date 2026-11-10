import { describe, expect, it } from "vitest";
import { projectPublishedRecordRead } from "../src/lib/published-record-render";
import { now, recordDocument, recordRead, rendererSha } from "./fixtures/published-records/fixtures";

describe("compiled Program/Event immutable inputs", () => {
  it.each(["programs", "events"] as const)("projects %s details, aliases and index with exact context", async family => {
    const read = recordRead(family);
    const document = read.documents[0];
    const canonical = `/${family}/${document.published.metadata.slug}/`;
    const alias = `/${family}/${document.published.metadata.previousSlugs[0]}/`;
    for (const path of [canonical, alias, `/${family}/`, ...(family === "programs" ? ["/shows/", canonical.replace("programs", "shows"), alias.replace("programs", "shows")] : [])]) {
      const content = await projectPublishedRecordRead(read, path, rendererSha, now);
      expect(content?.target.pagePath).toBe(path);
      expect(content?.target.contextDigest).toBe(read.sourceSeal.contextDigest);
      expect(JSON.stringify(content)).not.toContain("PRIVATE");
      expect(Object.isFrozen(content)).toBe(true);
    }
    expect(await projectPublishedRecordRead(read, `/${family}/unknown/`, rendererSha, now)).toBeNull();
  });
  it.each(["programs", "events"] as const)("omits all withdrawn %s aliases and retains an empty index", async family => {
    const read = recordRead(family, rendererSha, "withdrawn");
    const document = read.documents[0];
    const bases = family === "programs" ? ["programs", "shows"] : ["events"];
    for (const base of bases) {
      for (const slug of [document.published.metadata.slug, ...document.published.metadata.previousSlugs]) {
        expect(await projectPublishedRecordRead(read, `/${base}/${slug}/`, rendererSha, now)).toBeNull();
      }
      const content = await projectPublishedRecordRead(read, `/${base}/`, rendererSha, now);
      expect(content?.programs).toEqual([]);
      expect(content?.events).toEqual([]);
      expect(content?.target.documentId).toBeNull();
      expect(content?.target.sourceVersion).toBeNull();
    }
  });
  it.each(["programs", "events"] as const)("keeps a genuinely empty %s family renderable", async family => {
    const content = await projectPublishedRecordRead(recordRead(family, rendererSha, "empty"), `/${family}/`, rendererSha, now);
    expect(content?.programs).toEqual([]);
    expect(content?.events).toEqual([]);
    expect(content?.target.renderedAt).toBe(now.toISOString());
  });
  it("refuses wrong, incomplete, duplicated and colliding family snapshots", async () => {
    const read = recordRead("programs");
    await expect(projectPublishedRecordRead({ ...read, complete: false }, "/programs/", rendererSha, now)).rejects.toThrow();
    await expect(projectPublishedRecordRead({ ...read, documents: [...read.documents, read.documents[0]] }, "/programs/", rendererSha, now)).rejects.toThrow();
    const other = recordDocument("program", "program-two");
    other.published.metadata.previousSlugs = [read.documents[0].published.metadata.slug];
    await expect(projectPublishedRecordRead({ ...read, documents: [...read.documents, other] }, "/programs/", rendererSha, now)).rejects.toThrow();
    await expect(projectPublishedRecordRead(read, "/events/", rendererSha, now)).rejects.toThrow();
  });
  it("rejects source/context races and unsafe media/URLs", async () => {
    const read = recordRead("programs");
    await expect(projectPublishedRecordRead(read, "/programs/", "b".repeat(40), now)).rejects.toThrow();
    await expect(projectPublishedRecordRead({ ...read, sourceSeal: { ...read.sourceSeal, contextDigest: "f".repeat(64) } }, "/programs/", rendererSha, now)).rejects.toThrow();
    const metadata = read.documents[0].published.metadata;
    if (!("watchUrl" in metadata)) throw new Error("Expected Program fixture");
    metadata.watchUrl = "https://evil.example/watch";
    await expect(projectPublishedRecordRead(read, "/programs/", rendererSha, now)).rejects.toThrow();
    const events = recordRead("events");
    events.assets[0].url = "javascript:alert(1)";
    await expect(projectPublishedRecordRead(events, "/events/", rendererSha, now)).rejects.toThrow();
  });
});
