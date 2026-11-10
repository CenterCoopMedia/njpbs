import { describe, expect, it } from "vitest";
import { assertLiveBlogData, publicLiveBlogData, resolveLiveBlogPresentation, type LiveBlogData } from "../../packages/content-core/src/live-blog";
import { freezeLiveBlogData, parseLiveBlogDraft, type LiveBlogDraft } from "../../packages/content-core/src/live-blog-draft";
import { LIVE_BLOG_CONTRACT_VERSION } from "../../packages/content-core/src/live-blog";
import compatibility from "../../functions/lib/live-blog-compatibility.js";
import postPublication from "../../functions/lib/no-build-post-publication.js";
import postState from "../../functions/lib/no-build-post-state.js";
import { liveBlogManifest, parseLiveBlogManifest } from "../../packages/content-core/src/live-blog-manifest";

const first = "2026-10-30T15:00:00.000Z";
const later = "2026-10-30T15:01:00.000Z";
const draft = (): LiveBlogDraft => ({ schemaVersion: 1, coverageState: "ongoing", updates: [] });
const blog = (): LiveBlogData => ({ ...draft(), updatedAt: first, updates: [] });
const freeze = (value: LiveBlogDraft, previous?: LiveBlogData) => freezeLiveBlogData(value, { previous, at: later, freezeCredits: credits => credits });

describe("live blog presentation settings", () => {
  it("keeps legacy data absent through parsing, freezing, projection and manifest", () => {
    const source = blog();
    expect(resolveLiveBlogPresentation(source)).toEqual({ reporterPhotos: true, reporterCards: true, playful: false });
    expect(parseLiveBlogDraft(draft())).not.toHaveProperty("presentation");
    expect(freeze(draft(), source)).toEqual(source);
    expect(publicLiveBlogData(source, later)).toEqual(source);
    expect(parseLiveBlogManifest(liveBlogManifest("post-one", source))).not.toHaveProperty("presentation");
  });

  it.each(["reporterPhotos", "reporterCards", "playful"] as const)("accepts and carries each boolean %s without adding defaults", key => {
    for (const setting of [false, true]) {
      const presentation = { [key]: setting };
      const value = { ...draft(), presentation };
      const frozen = freeze(value, blog());
      expect(parseLiveBlogDraft(value).presentation).toEqual(presentation);
      expect(() => assertLiveBlogData(frozen)).not.toThrow();
      expect(frozen).toMatchObject({ presentation, updatedAt: later });
      expect(publicLiveBlogData(frozen, later).presentation).toEqual(presentation);
      expect(parseLiveBlogManifest(liveBlogManifest("post-one", frozen)).presentation).toEqual(presentation);
      expect(resolveLiveBlogPresentation(frozen)).toEqual({ reporterPhotos: true, reporterCards: true, playful: false, [key]: setting });
    }
  });

  it("recognizes presentation-only revisions without changing unchanged entry clocks", () => {
    const source = blog();
    const changed = freeze({ ...draft(), presentation: { playful: true } }, source);
    expect(changed.updatedAt).toBe(later);
    expect(freeze({ ...draft(), presentation: { playful: true } }, changed)).toEqual(changed);
    expect(freeze(draft(), changed)).not.toHaveProperty("presentation");
    expect(resolveLiveBlogPresentation({ presentation: {} })).toEqual(resolveLiveBlogPresentation(source));
  });

  it.each([
    null, [], true, "false", { unknown: true }, { reporterPhotos: "false" }, { reporterCards: 0 }, { playful: null },
    { reporterPhotos: undefined }, { playful: false, extra: true },
  ])("refuses invalid settings at draft, published and manifest boundaries (%j)", presentation => {
    expect(() => parseLiveBlogDraft({ ...draft(), presentation })).toThrow();
    expect(() => assertLiveBlogData({ ...blog(), presentation })).toThrow();
    expect(() => parseLiveBlogManifest({ ...liveBlogManifest("post-one", blog()), presentation })).toThrow();
  });
});

describe("presentation reader compatibility", () => {
  it("emits version three from the compiled paired reader and refuses a legacy renderer downgrade", () => {
    expect(LIVE_BLOG_CONTRACT_VERSION).toBe(3);
    const snapshot = { metadata: { liveBlog: { ...blog(), presentation: { playful: true } } } };
    expect(compatibility.candidateSupportsOwnedLiveBlog({ visible: true }, snapshot, { liveBlogVersion: 1 })).toBe(false);
    expect(compatibility.candidateSupportsOwnedLiveBlog({ visible: true }, snapshot, { liveBlogVersion: 1, liveBlogContractVersion: 2 })).toBe(true);
    expect(compatibility.candidateSupportsOwnedLiveBlog({ visible: true }, { metadata: { liveBlog: blog() } }, { liveBlogVersion: 1 })).toBe(true);
  });

  it("keeps OLD’s strict shared capability and candidate key sets unchanged", () => {
    const capability = { schemaVersion: 2, rendererSha: "a".repeat(40), servingEnabled: true, generation: 1, liveBlogVersion: 1 };
    expect(postState.validateCapability(capability)).toEqual(capability);
    expect(() => postState.validateCapability({ ...capability, liveBlogContractVersion: 2 })).toThrow();
    const contract = { schemaVersion: 2, rendererSha: "a".repeat(40), enabled: true, authoritative: true, families: ["posts"], liveBlogVersion: 1 };
    expect(postState.candidateNoBuildContract(contract)).toEqual(contract);
    expect(() => postState.candidateNoBuildContract({ ...contract, liveBlogContractVersion: 2 })).toThrow();
  });

  it("writes a startup companion beside unchanged shared capability and candidate documents", () => {
    const rendererSha = "a".repeat(40), writes = new Map<string, unknown>();
    const firestore = { doc: (path: string) => path };
    const transaction = { set: (path: string, value: unknown) => writes.set(path, value) };
    const contract = { schemaVersion: 2, rendererSha, enabled: true, authoritative: true, families: ["posts"], liveBlogVersion: 1 };
    postPublication.writeNoBuildCandidateActivation(transaction, firestore, { contract, owners: [], state: null, staticOwner: null, staticReturn: null }, { commitSha: rendererSha, generation: 1 });
    compatibility.writeLiveBlogContractMarker({ firestore, transaction, rendererSha });
    const capability = writes.get("system/publicDeployment/noBuildPosts/capability");
    expect(postState.validateCapability(capability)).toEqual({ schemaVersion: 2, rendererSha, servingEnabled: true, generation: 1, liveBlogVersion: 1 });
    expect(writes.get(`${compatibility.LIVE_BLOG_CONTRACTS}/${rendererSha}`)).toEqual({ schemaVersion: 1, rendererSha, liveBlogContractVersion: 3 });
  });

  it("treats absent, unreadable and mismatched companion markers as version one", async () => {
    const rendererSha = "a".repeat(40);
    const firestore = { doc: (path: string) => path };
    for (const marker of [undefined, { schemaVersion: 1, rendererSha: "b".repeat(40), liveBlogContractVersion: 2 }, { schemaVersion: 1, rendererSha, liveBlogContractVersion: "2" }]) {
      const transaction = { get: async () => ({ data: () => marker }) };
      expect(await compatibility.readLiveBlogContractForRenderer({ firestore, transaction, rendererSha })).toBe(1);
    }
    expect(await compatibility.readLiveBlogContractForRenderer({ firestore, transaction: { get: async () => { throw new Error("unreadable"); } }, rendererSha })).toBe(1);
  });
});
