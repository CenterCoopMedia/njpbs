import { describe, expect, it } from "vitest";
import { assertLiveBlogReady, assertLiveBlogRetainsPublished, freezeLiveBlogData, LIVE_BLOG_MAX_REGISTERED_AUTHORS, parseLiveBlogDraft, prepareLiveBlogDraft, type LiveBlogDraft } from "../../packages/content-core/src/live-blog-draft";
import { publicLiveBlogData, previewLiveBlogData, liveBlogMediaAssetIds } from "../../packages/content-core/src/live-blog";
import { renderLiveBlog } from "../../packages/content-core/src/live-blog-render";

const first = "2026-10-25T15:00:00.000Z";
const later = "2026-10-25T15:01:00.000Z";
const text = (value: string) => ({ type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text: value }] }] });
const draft = (): LiveBlogDraft => ({ schemaVersion: 1, coverageState: "ongoing", updates: [{
  id: "entry-a", headline: "Council votes", body: text("The vote was 6 to 1."),
  credits: [{ kind: "custom", name: "NJ PBS staff" }], keyUpdate: false,
}] });
const freeze = (value = draft(), previous?: ReturnType<typeof freezeLiveBlogData>, at = first) =>
  freezeLiveBlogData(value, { previous, at, freezeCredits: credits => credits });

describe("whole-Post live blog revisions", () => {
  it("previews unfinished entries privately without relaxing public or approval validation", () => {
    const value = draft(); Object.assign(value.updates[0], { headline: "", body: text(""), credits: [] });
    const preview = freezeLiveBlogData(value, { at: first, preview: true, freezeCredits: credits => credits });
    expect(previewLiveBlogData(preview, first)).toEqual(preview);
    expect(renderLiveBlog(preview, { id: "post", asOf: first, preview: true })).toContain("Draft update");
    expect(renderLiveBlog(preview, { id: "post", asOf: first, preview: true })).toContain("Draft byline not provided");
    expect(() => publicLiveBlogData(preview, first)).toThrow();
    expect(() => renderLiveBlog(preview, { id: "post", asOf: first })).toThrow();
    expect(() => assertLiveBlogReady(value)).toThrow();
    const previous = freeze(); const changed = draft(); changed.updates[0].headline = "Editing before adding the correction";
    expect(freezeLiveBlogData(changed, { previous, at: later, preview: true, freezeCredits: credits => credits }).updates[0].headline).toBe(changed.updates[0].headline);
    expect(() => freeze(changed, previous, later)).toThrow(/correction/);
  });

  it("validates attachments with the existing Post media contract and strips client video copies", () => {
    const value = draft();
    value.updates[0].media = { kind: "image", data: { assetId: "photo", alt: "" } };
    expect(parseLiveBlogDraft(value).updates[0].media).toEqual(value.updates[0].media);
    expect(() => freeze(value)).toThrow(/media/);
    value.updates[0].media.data.alt = "People outside the polling place";
    const previous = freeze(value);
    const changed = structuredClone(value); changed.updates[0].media!.data.caption = "A new caption";
    expect(() => freeze(changed, previous, later)).toThrow(/correction/);
    changed.updates[0].withdrawal = "The location in the image was incorrect.";
    if (changed.updates[0].media?.kind === "image") changed.updates[0].media.data.alt = "";
    expect(freeze(changed, previous, later).updates[0]).not.toHaveProperty("media");
    value.updates[0].media = { kind: "library-video", data: { sourceId: "video-library", assetId: "video", title: "Results briefing", public: { private: "client spoof" } as never } };
    expect(parseLiveBlogDraft(value).updates[0].media?.data).not.toHaveProperty("public");
    expect(() => freeze(value)).not.toThrow();
    value.updates[0].media = { kind: "embed", data: { url: "javascript:alert(1)", title: "Unsafe" } };
    expect(() => parseLiveBlogDraft(value)).toThrow(/media/);
  });

  it("bounds media lookup work and changes election branding without restamping entries", () => {
    const value = draft();
    value.updates = Array.from({ length: 101 }, (_, index) => ({ ...draft().updates[0], id: `entry-${index}`, media: { kind: "image", data: { assetId: "photo", alt: "A photo" } } }));
    expect(() => parseLiveBlogDraft(value)).toThrow(/100 entries/);
    value.updates.pop(); expect(parseLiveBlogDraft(value).updates).toHaveLength(100);
    value.updates.push({ ...draft().updates[0], id: "withdrawn-entry", withdrawal: "This report was withdrawn.",
      media: { kind: "image", data: { assetId: "withdrawn-photo", alt: "Previous reporting" } } });
    expect(parseLiveBlogDraft(value).updates).toHaveLength(101);
    expect(liveBlogMediaAssetIds(value)).toHaveLength(100);
    delete value.updates[100].withdrawal;
    expect(() => parseLiveBlogDraft(value)).toThrow(/100 entries/);
    const previous = freeze();
    const branded = freeze({ ...draft(), branding: "nj-decides-2026" }, previous, later);
    expect(branded).toMatchObject({ branding: "nj-decides-2026", updatedAt: later, updates: previous.updates });
    expect(() => parseLiveBlogDraft({ ...draft(), branding: "invented" })).toThrow();
  });

  it("projects only public rich-text attributes and enforces the frozen cutoff", () => {
    const value = freeze();
    value.updates[0].body.attrs = { staffNote: "PRIVATE draft annotation" };
    value.updates[0].body.content[0].attrs = { selection: "PRIVATE selection" };
    value.updates[0].body.content[0].content![0].marks = [{ type: "link", attrs: { href: "/about/", allowLegacyHost: true, staffNote: "PRIVATE mark" } }];
    const selected = publicLiveBlogData(value, later);
    expect(JSON.stringify(selected)).not.toContain("PRIVATE");
    expect(selected.updates[0].body.content[0].content![0].marks).toEqual([{ type: "link", attrs: { href: "/about/", allowLegacyHost: true } }]);
    expect(value.updates[0].body.attrs).toEqual({ staffNote: "PRIVATE draft annotation" });
    expect(() => publicLiveBlogData(value, "2026-10-25T14:59:00.000Z")).toThrow(/newer/);
  });

  it("requires correction lifecycle validation at approval before directory freezing", () => {
    const previous = freeze();
    const changed = draft(); changed.updates[0].headline = "Revised council vote";
    expect(() => assertLiveBlogReady(changed, previous)).toThrow(/new visible correction/);
    changed.updates[0].correction = "An earlier headline misstated the vote.";
    expect(assertLiveBlogReady(changed, previous)).toEqual(changed);
    expect(() => assertLiveBlogReady(changed)).toThrow(/previously published/);
  });
  it("bounds distinct directory identities while allowing repeated bylines across the archive", () => {
    const value = draft();
    value.updates = Array.from({ length: LIVE_BLOG_MAX_REGISTERED_AUTHORS + 1 }, (_, index) => ({ ...draft().updates[0], id: `entry-${index}`,
      credits: [{ kind: "registered", authorId: `au_${index.toString(16).padStart(32, "0")}` }],
    }));
    expect(() => parseLiveBlogDraft(value)).toThrow(/64 distinct/);
    value.updates.pop();
    expect(parseLiveBlogDraft(value).updates).toHaveLength(64);
    value.updates = Array.from({ length: 200 }, (_, index) => ({ ...value.updates[0], id: `entry-${index}` }));
    expect(parseLiveBlogDraft(value).updates).toHaveLength(200);
  });
  it("accepts incomplete drafts without assigning public clocks", () => {
    const value = draft();
    Object.assign(value.updates[0], { id: "tmp-entry", headline: "", body: text(""), credits: [] });
    expect(parseLiveBlogDraft(value)).toEqual(value);
    expect(() => parseLiveBlogDraft(value, { complete: true })).toThrow(/headline/);
    expect(() => freeze(value)).toThrow(/Save/);
    value.updates[0].id = "entry-a";
    expect(() => freeze(value)).toThrow(/headline/);
  });

  it.each([
    { ...draft(), updatedAt: first },
    { ...draft(), updates: [{ ...draft().updates[0], publishedAt: first }] },
    { ...draft(), updates: [{ ...draft().updates[0], privateNotes: "private" }] },
    { ...draft(), updates: [draft().updates[0], draft().updates[0]] },
    { ...draft(), updates: [{ ...draft().updates[0], body: "<p>unsafe</p>" }] },
  ])("refuses clocks, private siblings, duplicate links and HTML (%#)", value => {
    expect(() => parseLiveBlogDraft(value)).toThrow();
  });

  it("mints ids on the server and rejects invented canonical ids", () => {
    expect(() => prepareLiveBlogDraft(draft(), { mintId: () => "minted" })).toThrow(/server-generated/);
    const value = draft(); value.updates[0].id = "tmp-a";
    const saved = prepareLiveBlogDraft(value, { mintId: () => "minted" });
    expect(saved.updates[0].id).toBe("minted");
    expect(value.updates[0].id).toBe("tmp-a");
    expect(prepareLiveBlogDraft(saved, { previous: saved, mintId: () => { throw new Error("unexpected mint"); } })).toEqual(saved);
  });

  it("keeps publication and edit clocks for an unchanged revision", () => {
    const previous = freeze();
    expect(freeze(draft(), previous, later)).toEqual(previous);
    const ended = { ...draft(), coverageState: "ended" as const };
    expect(freeze(ended, previous, later)).toMatchObject({ updatedAt: later, updates: previous.updates });
  });

  it("does not treat Firestore map-key ordering as a correction", () => {
    const previous = freeze();
    const reordered = JSON.parse(JSON.stringify(draft(), (_key, value) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse()) : value));
    expect(freeze(reordered, previous, later)).toEqual(previous);
  });

  it("requires a fresh visible correction and never reorders an edited entry", () => {
    const previous = freeze();
    const changed = draft(); changed.updates[0].body = text("The vote was 5 to 2.");
    expect(() => freeze(changed, previous, later)).toThrow(/correction/);
    changed.updates[0].correction = "The earlier vote count was incorrect.";
    expect(() => freeze(changed, previous, first)).toThrow(/later/);
    const corrected = freeze(changed, previous, later);
    expect(corrected.updates[0]).toMatchObject({ publishedAt: first, updatedAt: later, correction: changed.updates[0].correction });
    changed.updates[0].headline = "Council vote confirmed";
    expect(() => freeze(changed, corrected, "2026-10-25T15:02:00.000Z")).toThrow(/new visible correction/);
  });

  it("retains links and history while excluding withdrawn reporting from the public snapshot", () => {
    const previous = freeze();
    const withdrawn = draft(); withdrawn.updates[0].withdrawal = "This report could not be verified.";
    const snapshot = freeze(withdrawn, previous, later);
    expect(snapshot.updates[0]).toMatchObject({ id: "entry-a", headline: "Update withdrawn", body: { type: "doc", content: [] }, publishedAt: first, updatedAt: later });
    const html = renderLiveBlog(snapshot, { id: "post-a", asOf: later });
    expect(html).toContain("Withdrawn:</strong> This report could not be verified.");
    expect(html).not.toContain("The vote was");
    expect(html).not.toContain("Council votes");
    expect(() => assertLiveBlogRetainsPublished(undefined, snapshot)).toThrow(/retained/);
    expect(() => assertLiveBlogRetainsPublished({ ...draft(), updates: [] }, snapshot)).toThrow(/cannot be removed/);
    expect(() => assertLiveBlogRetainsPublished(undefined, snapshot)).toThrow(/must be retained/);
    expect(() => assertLiveBlogRetainsPublished(undefined, { ...snapshot, updates: [] })).not.toThrow();
    expect(() => assertLiveBlogRetainsPublished(draft(), snapshot)).toThrow(/cannot be restored/);
    expect(previous.updates[0].body).toEqual(text("The vote was 6 to 1."));
    expect(withdrawn.updates[0].body).toEqual(previous.updates[0].body);
    withdrawn.updates[0].credits = [{ kind: "custom", name: "A draft-only change" }];
    expect(freeze(withdrawn, snapshot, later)).toEqual(snapshot);
    expect(freeze(withdrawn, snapshot, "2026-10-25T15:02:00.000Z")).toEqual(snapshot);
  });
});
