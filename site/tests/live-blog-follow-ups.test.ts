import compatibility from "../../functions/lib/live-blog-compatibility.js";
import { describe, expect, it } from "vitest";
import { assertLiveBlogData, publicLiveBlogData } from "../../packages/content-core/src/live-blog";
import { assertLiveBlogReady, freezeLiveBlogData, parseLiveBlogDraft, prepareLiveBlogDraft, type LiveBlogDraft } from "../../packages/content-core/src/live-blog-draft";
import { renderLiveBlog } from "../../packages/content-core/src/live-blog-render";
import { liveBlogManifest, parseLiveBlogManifest } from "../../packages/content-core/src/live-blog-manifest";
import { installLiveBlogFollowUps } from "../src/lib/live-blog-follow-ups";
import { installLiveBlogPagination } from "../src/lib/live-blog-pagination";
import { liveBlogPostingJsonLd } from "../src/lib/live-blog-structured-data";
const first = "2026-11-03T23:00:00.000Z", later = "2026-11-03T23:01:00.000Z", last = "2026-11-03T23:02:00.000Z";
const text = (value: string) => ({ type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text: value }] }] });
const credits = [{ kind: "custom" as const, name: "Newsroom" }];
const reply = () => ({ id: "follow-a", body: text("More detail."), credits });
const draft = (): LiveBlogDraft => ({ schemaVersion: 1, coverageState: "ongoing", updates: [{ id: "entry", headline: "Results", body: text("First report"), credits, keyUpdate: true }] });
const freeze = (value = draft(), previous?: ReturnType<typeof freezeLiveBlogData>, at = first) => freezeLiveBlogData(value, { previous, at, freezeCredits: value => value });
const withReply = () => { const value = draft(); value.updates[0].followUps = [reply()]; return value; };

describe("live blog follow-ups", () => {
  it("emits the v3 companion marker and refuses older candidates even for an empty nested array", () => {
    const rendererSha = "a".repeat(40), writes = new Map<string, unknown>();
    compatibility.writeLiveBlogContractMarker({ firestore: { doc: (path: string) => path }, transaction: { set: (path: string, value: unknown) => writes.set(path, value) }, rendererSha });
    expect(writes.get(`${compatibility.LIVE_BLOG_CONTRACTS}/${rendererSha}`)).toEqual({ schemaVersion: 1, rendererSha, liveBlogContractVersion: 3 });
    const snapshot = { metadata: { liveBlog: freeze(withReply()) } };
    for (const liveBlogContractVersion of [undefined, 1, 2]) expect(compatibility.candidateSupportsOwnedLiveBlog({ visible: true }, snapshot, { liveBlogVersion: 1, liveBlogContractVersion })).toBe(false);
    expect(compatibility.candidateSupportsOwnedLiveBlog({ visible: true }, snapshot, { liveBlogVersion: 1, liveBlogContractVersion: 3 })).toBe(true);
    expect(compatibility.requiredLiveBlogContractVersion({ updates: [{ followUps: [] }] })).toBe(3);
  });
  it("keeps absent follow-ups absent and accepts valid nested reporting", () => {
    expect(freeze().updates[0]).not.toHaveProperty("followUps");
    expect(() => assertLiveBlogData(freeze(withReply()))).not.toThrow();
  });
  it("mints parent-scoped immutable ids and retains every published follow-up", () => {
    const value = withReply(); value.updates[0].id = "tmp-entry"; value.updates[0].followUps![0].id = "tmp-follow";
    let id = 0; const saved = prepareLiveBlogDraft(value, { mintId: () => `server-${++id}` });
    expect(saved.updates[0].followUps![0].id).toBe("server-2");
    expect(() => prepareLiveBlogDraft(withReply(), { previous: draft(), mintId: () => "new" })).toThrow(/server-generated/);
    const published = freeze(saved);
    const removed = structuredClone(saved); delete removed.updates[0].followUps;
    expect(() => assertLiveBlogReady(removed, published)).toThrow(/cannot be removed/);
  });
  it("adds without a parent correction, bumps both clocks and preserves parent publication and flags", () => {
    const before = freeze(); const after = freeze(withReply(), before, later);
    expect(after.updatedAt).toBe(later);
    expect(after.updates[0]).toMatchObject({ publishedAt: first, updatedAt: later, keyUpdate: true, headline: "Results" });
    expect(after.updates[0]).not.toHaveProperty("correction");
    expect(after.updates[0].followUps![0]).toMatchObject({ publishedAt: later, updatedAt: later });
    expect(freeze(withReply(), after, last)).toEqual(after);
  });
  it("requires a later blog revision even when changing an older parent", () => {
    const previous = freeze(); previous.updatedAt = later;
    expect(() => freeze(withReply(), previous, later)).toThrow(/later blog/);
  });
  it("corrects and withdraws the nested reporting while retaining its anchor and excluding the body", () => {
    const before = freeze(withReply()); const edit = withReply(); edit.updates[0].followUps![0].body = text("Corrected detail");
    expect(() => freeze(edit, before, later)).toThrow(/follow-up.*correction/);
    edit.updates[0].followUps![0].correction = "The earlier detail was incorrect.";
    const corrected = freeze(edit, before, later);
    expect(corrected.updates[0].followUps![0].publishedAt).toBe(first);
    edit.updates[0].followUps![0].withdrawal = "Could not verify.";
    const withdrawn = freeze(edit, corrected, last);
    expect(withdrawn.updates[0].followUps![0].body.content).toEqual([]);
    expect(JSON.stringify(publicLiveBlogData(withdrawn, last))).not.toContain("Corrected detail");
    expect(() => freeze(withReply(), withdrawn, last)).toThrow(/cannot be restored/);
    const leaked = structuredClone(withdrawn); leaked.updates[0].followUps![0].body = text("Leaked report");
    expect(() => assertLiveBlogData(leaked)).toThrow();
  });
  it("hides the entire withdrawn parent thread publicly, retains its private audit and refuses further changes", () => {
    const original = withReply(), published = freeze(original);
    const working = structuredClone(original); working.updates[0].withdrawal = "The parent report could not be verified.";
    const withdrawn = freeze(working, published, later);
    expect(working.updates[0].followUps![0].body).toEqual(reply().body);
    expect(withdrawn.updates[0]).not.toHaveProperty("followUps");
    expect(() => freeze(working, withdrawn, last)).not.toThrow();
    const privateAudit = structuredClone(withdrawn); privateAudit.updates[0].followUps = published.updates[0].followUps;
    expect(() => assertLiveBlogData(privateAudit)).toThrow();
    expect(publicLiveBlogData(privateAudit, later).updates[0]).not.toHaveProperty("followUps");
    const html = renderLiveBlog(withdrawn, { id: "post", asOf: later });
    expect(html).not.toContain("follow-ups__toggle"); expect(html).not.toContain("More detail.");
    for (const mutate of [
      (value: LiveBlogDraft) => value.updates[0].followUps!.push({ ...reply(), id: "tmp-new" }),
      (value: LiveBlogDraft) => { value.updates[0].followUps![0].body = text("Hidden edit"); },
      (value: LiveBlogDraft) => { value.updates[0].followUps![0].correction = "Hidden correction"; },
    ]) {
      const changed = structuredClone(working); mutate(changed);
      expect(() => prepareLiveBlogDraft(changed, { previous: working, published: withdrawn, mintId: () => "server-new" })).toThrow(/withdrawn update/);
    }
  });
  it("publishes a parent withdrawal with incomplete saved follow-ups retained only in audit", () => {
    const active = draft(), published = freeze(active);
    active.updates[0].followUps = [{ id: "saved-incomplete", body: text(""), credits: [] }];
    const withdrawn = structuredClone(active); withdrawn.updates[0].withdrawal = "Unverified report.";
    expect(() => parseLiveBlogDraft(withdrawn, { complete: true })).not.toThrow();
    expect(freeze(withdrawn, published, later).updates[0]).not.toHaveProperty("followUps");
    const cancelled = structuredClone(withdrawn); delete cancelled.updates[0].withdrawal;
    cancelled.updates[0].followUps![0].body = text("Draft reporting continues.");
    expect(() => prepareLiveBlogDraft(cancelled, { previous: withdrawn, published, mintId: () => "unused" })).not.toThrow();
  });
  it("keeps written order for equal publication times and removes an empty optional field", () => {
    const value = withReply(); value.updates[0].followUps = [{ ...reply(), id: "z-first" }, { ...reply(), id: "a-second" }];
    expect(freeze(value).updates[0].followUps!.map(item => item.id)).toEqual(["z-first", "a-second"]);
    value.updates[0].followUps = [];
    const parsed = parseLiveBlogDraft(value);
    expect(parsed.updates[0]).not.toHaveProperty("followUps");
    const published = freeze(value); expect(published.updates[0]).not.toHaveProperty("followUps");
    expect(compatibility.candidateSupportsOwnedLiveBlog({ visible: true }, { metadata: { liveBlog: published } }, { liveBlogVersion: 1 })).toBe(true);
  });
  it("rejects limits, unknown keys, invalid ids, duplicate ids, rich blocks and invalid credits", () => {
    for (const patch of [
      { id: "bad id" }, { privateNote: "private" }, { media: {} }, { credits: [] },
      { body: text("x".repeat(1001)) }, { body: { type: "doc", content: [{ type: "image", attrs: { src: "https://example.test/a.png" } }] } },
      { body: { type: "doc", content: [{ type: "heading", content: [{ type: "text", text: "Heading" }] }] } },
      { body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Code", marks: [{ type: "code" }] }] }] } },
    ]) { const value = withReply(); Object.assign(value.updates[0].followUps![0], patch); expect(() => parseLiveBlogDraft(value, { complete: true })).toThrow(); }
    const value = withReply(); value.updates[0].followUps = Array.from({ length: 21 }, (_, index) => ({ ...reply(), id: `f-${index}` }));
    expect(() => parseLiveBlogDraft(value)).toThrow(/20/);
    value.updates[0].followUps = [reply(), reply()]; expect(() => parseLiveBlogDraft(value)).toThrow();
    value.updates[0].followUps = [{ ...reply(), body: text("x".repeat(1000)) }]; expect(() => freeze(value)).not.toThrow();
    const published = freeze(withReply()); Object.assign(published.updates[0].followUps![0], { surprise: true });
    expect(() => assertLiveBlogData(published)).toThrow();
  });
  it("renders a collapsed accessible thread and expands an anchored follow-up, including in older pages", () => {
    const value = freeze(withReply());
    document.body.innerHTML = renderLiveBlog(value, { id: "post", asOf: first });
    const root = document.querySelector<HTMLElement>("[data-live-blog]")!;
    const toggle = root.querySelector<HTMLButtonElement>(".live-blog-follow-ups__toggle")!;
    const list = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(root.innerHTML).toContain("<noscript><style>");
    expect(toggle.textContent).toBe("1"); expect(toggle.getAttribute("aria-label")).toBe("1 follow-up"); expect(toggle.getAttribute("aria-expanded")).toBe("false"); expect(list.hidden).toBe(true);
    const followUp = list.querySelector("article")!;
    expect(followUp.getAttribute("data-live-blog-follow-up-updated-at")).toBe(first);
    expect(followUp.querySelector(".live-blog-follow-up__header .live-blog-follow-up__permalink")?.getAttribute("href")).toBe(`#${followUp.id}`);
    expect(toggle.closest(".live-blog__footer")?.querySelector(".live-blog__permalink")).not.toBeNull();
    const anchor = root.querySelector(".live-blog-follow-up")!.id;
    history.replaceState({}, "", `/#${anchor}`); installLiveBlogFollowUps(root); installLiveBlogPagination(root);
    expect(toggle.getAttribute("aria-expanded")).toBe("true"); expect(list.hidden).toBe(false);
    toggle.click(); expect(list.hidden).toBe(true); expect(toggle.getAttribute("aria-expanded")).toBe("false");
    history.replaceState({}, "", "/");
  });
  it("counts only updates in manifests, archives and structured data", () => {
    const value = freeze(withReply()); const manifest = liveBlogManifest("post", value);
    expect(manifest.totalCount).toBe(1); expect(manifest.updates).toHaveLength(1);
    expect(parseLiveBlogManifest(manifest).followUpsUpdatedAt).toBe(first);
    const json = liveBlogPostingJsonLd({ postId: "post", title: "Coverage", canonicalPath: "/posts/coverage/", datePublished: null, liveBlog: value, site: "https://example.test" });
    expect(json!.liveBlogUpdate).toHaveLength(1); expect(JSON.stringify(json)).not.toContain("More detail.");
  });
});
