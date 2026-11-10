import { expect, it } from "vitest";
import { projectPublicPageContextRead } from "../src/lib/public-page-context-render";
import { fallbackPageRead, fallbackPageIds, publishedPageRead, retainedHomeSources, now } from "./fixtures/published-pages/fixtures";

const sha = "a".repeat(40);
it.each(fallbackPageIds)("projects the existing %s frame with current public dependencies and no editorial identity", async pageId => {
  const input = fallbackPageRead(pageId);
  const content = await projectPublicPageContextRead(input, sha, now, pageId === "home" ? { homeSources: retainedHomeSources() } : {});
  expect(content.pages).toEqual([]);
  expect(content.target).toMatchObject({ documentId: pageId, source: "site", codeGeneration: 5, contextRevision: 4 });
  expect(content.target.sourceVersion).toBeUndefined();
  expect(Object.isFrozen(content.settings)).toBe(true);
  expect(JSON.stringify(content)).not.toContain("PRIVATE");
});
it("uses an unowned published CMS Page without changing its real version or route", async () => {
  const read = publishedPageRead("contact");
  const content = await projectPublicPageContextRead({ ...read, kind: "published-page-context", pageId: "contact", path: read.page.path,
    sourceSeal: { ...read.sourceSeal, codeGeneration: 5 } }, sha, now);
  expect(content.target).toMatchObject({ source: "cms", sourceVersion: 7 });
  expect(content.pages[0].title).toBe("Published Page & context");
});
it("refuses forged context seals, custom fallback frames, noncanonical CMS routes and missing Home sources", async () => {
  for (const mutate of [
    (input: ReturnType<typeof fallbackPageRead>) => { input.sourceSeal.codeGeneration = 0; },
    (input: ReturnType<typeof fallbackPageRead>) => { input.sourceSeal.contextRevision++; },
    (input: ReturnType<typeof fallbackPageRead>) => { input.pageId = `page-${"3".repeat(32)}`; input.path = "/custom/"; },
  ]) {
    const input = fallbackPageRead("contact"); mutate(input);
    await expect(projectPublicPageContextRead(input, sha, now)).rejects.toThrow();
  }
  const read = publishedPageRead("contact");
  await expect(projectPublicPageContextRead({ ...read, kind: "published-page-context", pageId: "contact", path: "/station-contact/",
    sourceSeal: { ...read.sourceSeal, codeGeneration: 5 } }, sha, now)).rejects.toThrow("does not own");
  await expect(projectPublicPageContextRead(fallbackPageRead("home"), sha, now)).rejects.toThrow("exact source pools");
  const sources = retainedHomeSources(); sources.editorial!.receipt.digest = "b".repeat(64);
  await expect(projectPublicPageContextRead(fallbackPageRead("home"), sha, now, { homeSources: sources })).rejects.toThrow("source seal");
});
it.each(["schedule", "live"])("keeps %s pending until the exact lineup/PDF owner is available", async pageId => {
  await expect(projectPublicPageContextRead(fallbackPageRead(pageId), sha, now)).rejects.toThrow("Schedule render input differs from its qualified context");
});

it("admits the distinct committed Donate frame but refuses invented site-frame aliases", async () => {
  const input = fallbackPageRead("give"); input.path = "/donate/";
  expect((await projectPublicPageContextRead(input, sha, now)).target).toMatchObject({ source: "site", pagePath: "/donate/" });
  const invented = fallbackPageRead("contact"); invented.path = "/old-contact/";
  await expect(projectPublicPageContextRead(invented, sha, now)).rejects.toThrow("no committed frame");
});
