import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { derivePublicReleasePairPublicReceipts } from "../../site/scripts/public-release-pair-public-receipts";
import { createNoBuildPostWorker } from "../../workers/src/no-build-post-worker";
import target from "../../functions/lib/publication-target.js";
import staticReturn from "../../functions/lib/no-build-post-static-return.js";
import postState from "../../functions/lib/no-build-post-state.js";
import { releasePair } from "../helpers/private-public-release-pair";
import { loadPublicContentStatus, readPublicContentStatus } from "../../admin/src/lib/public-content-status";
vi.mock("../../admin/src/lib/staff-site-read", () => ({ fetchStaffSiteRead: (...args: Parameters<typeof fetch>) => fetch(...args) }));
vi.mock("../../admin/src/lib/dev-origins", () => ({ publicSiteOrigin: "https://dev-public.example.org" }));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const pair = releasePair("b", "b".repeat(40));
const baseline = { schemaVersion: 1, digestAlgorithm: "sha256", buildBatchId: "new-code", generation: 10, commitSha: pair.commitSha,
  artifactDigest: "a".repeat(64), artifactReceiptDigest: "b".repeat(64), mediaManifestDigest: "c".repeat(64) };
const baselineStatus = { ...baseline, collections: ["cmsPages", "cmsPosts"], routes: [{ path: "/", source: "site" }] };
afterEach(() => vi.unstubAllGlobals());
async function receipts(operation: number, visible = true, staticOwner = false, secondOwner = false, republishedStatic = false, capabilityGeneration?: number, linked = false) {
  const contextDigest = hash(`njpbs-public-context-v1:${operation + 1}`);
  const owner = { schemaVersion: 1, postId: "story", operationId: String(operation).repeat(20), sourceVersion: operation + 7,
    slug: "story", ownedSlugs: ["old-story", "story"], visible, generation: operation + 10,
    mode: staticOwner ? "static" : "dynamic", rendererSha: pair.commitSha };
  const documentFor = (slug: string, sourceVersion: number, previousSlugs: string[] = []) => ({ version: sourceVersion, publiclyVisible: visible,
    status: visible ? "published" : "draft", published: { sourceVersion, metadata: { type: "post", slug, previousSlugs, ...(linked ? { contentLinkMode: "custom", contentLinkUrl: "https://example.test/report" } : {}) },
      blocks: [], authorIds: [], publishedAt: "2026-10-28T04:00:00.000Z" } });
  const documents = new Map<string, any>([["system/publicDeployment", { activeGeneration: 10, state: "idle", activeCommitSha: pair.commitSha }],
    ["system/publicDeployment/contexts/public", { schemaVersion: 1, revision: operation + 1 }], ["system/noBuildPostAdmission", { revision: 3 }],
    ["system/publicDeployment/noBuildPostOwners/story", owner], ["cmsPosts/story", documentFor(republishedStatic ? "renamed-story" : owner.slug,
      owner.sourceVersion + (republishedStatic ? 5 : 0), republishedStatic ? ["story", "retired-story"] : [])]]);
  if (secondOwner) {
    documents.set("system/publicDeployment/noBuildPostOwners/another", { ...owner, postId: "another", slug: "another", ownedSlugs: ["another"] });
    documents.set("cmsPosts/another", documentFor("another", owner.sourceVersion));
  }
  if (capabilityGeneration !== undefined) documents.set("system/publicDeployment/noBuildPosts/capability", {
    schemaVersion: 2, rendererSha: pair.commitSha, servingEnabled: true, generation: capabilityGeneration });
  const posts = await Promise.all([...documents].filter(([path]) => path.startsWith("system/publicDeployment/noBuildPostOwners/")).map(async ([, state]) => {
    state = postState.effectiveNoBuildPostState(state, postState.validateCapability(documents.get("system/publicDeployment/noBuildPosts/capability")));
    if (state.mode === "static") {
      const input = await staticReturn.currentStaticInput({ state, firestore: { doc: (path: string) => path },
        transaction: { get: async (path: string) => ({ data: () => documents.get(path) }) } } as any);
      const files = ["/posts/", "/feeds/news.xml", "/api/v1/content.json", "/pagefind/pagefind.js", "/search/meaning-index.json", "/_publication.json", "/_content-status.json", "/sitemap.xml",
        ...(input.visible ? [`/posts/${input.slug}/`] : [])].map(path => ({ path, bytes: 1, digest: hash("x") }));
      const result = await staticReturn.readStaticDecision({ state: { ...state, staticProof: { ...input, files } },
        firestore: { doc: (path: string) => path }, transaction: { get: async (path: string) => ({ data: () => documents.get(path) }) },
        pointer: documents.get("system/publicDeployment"), rendererSha: pair.commitSha, path: `/posts/${input.slug}/` } as any);
      return result.receipt;
    }
    return { schemaVersion: 1, postId: state.postId, operationId: state.operationId, rendererSha: pair.commitSha, sourceVersion: state.sourceVersion,
      slug: state.slug, ownedSlugs: state.ownedSlugs, visible: state.visible, admissionRevision: 3, contextDigest, generation: state.generation };
  }));
  const decision = secondOwner ? { kind: "receipts", catalog: { schemaVersion: 1, rendererSha: pair.commitSha, admissionRevision: 3,
    contextDigest, generation: Math.max(10, ...posts.map(post => post.generation)), posts } } : { kind: "receipts", receipt: posts[0] };
  const live = createNoBuildPostWorker({ target: target.publicationTarget("development"), rendererSha: pair.commitSha,
    getDecision: async () => decision as any, render: async () => { throw new Error("Receipt check never renders"); },
    cache: { match: async () => undefined, put: async () => {} }, fetchAsset: async request => Response.json(new URL(request.url).pathname === "/_publication.json" ? baseline : baselineStatus) });
  const response = await live.fetch(new Request("https://dev-public.example.org/_publication.json"));
  expect(response?.status).toBe(200);
  const current = documents.get("cmsPosts/story").published;
  const targets = visible ? [{ status: linked ? 302 : 200, receipt: { path: `/posts/${current.metadata.slug}/`, target: { projection: { kind: "public-post", target: { documentId: "story", sourceVersion: current.sourceVersion } } } } }] : [];
  const files = await derivePublicReleasePairPublicReceipts({ pair, documents, baselinePublication: encode(baseline), baselineStatus: encode(baselineStatus),
    targets: targets as any, ownedPaths: new Set(["/posts/story/", "/posts/old-story/"]) });
  const publication = JSON.parse(new TextDecoder().decode(files[0].bytes)), status = JSON.parse(new TextDecoder().decode(files[1].bytes));
  expect(publication).toEqual(await response!.json());
  expect(status).toMatchObject(publication);
  return { publication, status };
}
it.each([[false, false], [false, true], [true, true]])("reproduces the real Worker identity after one and two frozen operations (static %s, catalog %s)", async (staticOwner, catalog) => {
  const first = await receipts(1, true, staticOwner, catalog), second = await receipts(2, true, staticOwner, catalog);
  expect(first.publication.buildBatchId).not.toBe(second.publication.buildBatchId);
  expect(second.publication.generation).toBe(12);
  expect(readPublicContentStatus(second.status, second.publication)).toContainEqual({ path: "/posts/story/", source: "cms", contentKey: hash("cmsPosts/story"), sourceVersion: 9 });
});
it("refreshes Admin's cached inventory after a frozen operation and removes withdrawals", async () => {
  let current = await receipts(1);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("_content-status") ? current.status : current.publication)));
  const first = await loadPublicContentStatus(new AbortController().signal);
  current = await receipts(2, false);
  const next = await loadPublicContentStatus(new AbortController().signal, first);
  expect(next).not.toBe(first); expect(next.routes.some(row => row.path === "/posts/story/")).toBe(false);
  expect(() => readPublicContentStatus(next, baseline)).toThrow();
  expect(() => readPublicContentStatus(current.status, baseline)).toThrow("do not match");
});
it("refreshes Admin's Page-only pair inventory when the release identity stays unchanged", async () => {
  const derive = async (sourceVersion: number, visible = true) => {
    const files = await derivePublicReleasePairPublicReceipts({ pair,
      documents: new Map([["system/publicDeployment/contexts/public", { revision: sourceVersion }]]),
      baselinePublication: encode(baseline), baselineStatus: encode(baselineStatus),
      targets: visible ? [{ status: 200, receipt: { path: "/contact/", target: { projection: {
        kind: "public-page", target: { documentId: "contact", sourceVersion } } } } }] as any : [],
      ownedPaths: new Set(["/contact/"]) });
    return { publication: JSON.parse(new TextDecoder().decode(files[0].bytes)), status: JSON.parse(new TextDecoder().decode(files[1].bytes)) };
  };
  let current = await derive(7);
  const initialPublication = current.publication;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("_content-status") ? current.status : current.publication)));
  const first = await loadPublicContentStatus(new AbortController().signal);
  current = await derive(8);
  expect(current.publication).toEqual(initialPublication);
  const next = await loadPublicContentStatus(new AbortController().signal, first);
  expect(next.routes).toContainEqual({ path: "/contact/", source: "cms", contentKey: hash("cmsPages/contact"), sourceVersion: 8 });
  current = await derive(9, false);
  const withdrawn = await loadPublicContentStatus(new AbortController().signal, next);
  expect(withdrawn.routes.some(row => row.path === "/contact/")).toBe(false);
});
it("refuses a sole static owner's receipt when H lacks its exact static proof bytes", async () => {
  const documents = new Map<string, any>([["system/publicDeployment/contexts/public", { revision: 2 }],
    ["system/publicDeployment/noBuildPostOwners/story", { postId: "story", operationId: "S".repeat(20), mode: "static",
      generation: 11, sourceVersion: 8, visible: true, slug: "story", ownedSlugs: ["story"] }],
    ["cmsPosts/story", { version: 8, publiclyVisible: true, published: { sourceVersion: 8, metadata: { type: "post", slug: "story" } } }]]);
  await expect(derivePublicReleasePairPublicReceipts({ pair, documents, baselinePublication: encode(baseline), baselineStatus: encode(baselineStatus),
    targets: [], ownedPaths: new Set() })).rejects.toMatchObject({ reason: "pair-static-owner-receipt-unavailable" });
});
it.each([true, false])("matches actual static current input after a republish/rename (visible %s)", async visible => {
  const result = await receipts(1, visible, true, true, true);
  expect(result.status.routes.some((row: { path: string }) => row.path === "/posts/renamed-story/")).toBe(visible);
  if (visible) expect(result.status.routes).toContainEqual({ path: "/posts/renamed-story/", source: "cms", contentKey: hash("cmsPosts/story"), sourceVersion: 13 });
});
it.each([false, true])("matches live effective capability generation above retained dynamic owners (catalog %s)", async catalog => {
  const result = await receipts(1, true, false, catalog, false, 42);
  expect(result.publication.generation).toBe(42);
});
it("preserves the live static exemption from a higher dynamic capability generation", async () => {
  const result = await receipts(1, true, true, true, true, 42);
  expect(result.publication.generation).toBe(11);
});

it.each(["programs", "events"])("keeps the live canonical %s inventory row when former/mirror HTML is 200", async family => {
  const paths = [`/${family}/former/`, `/${family}/one/`, ...(family === "programs" ? ["/shows/former/", "/shows/one/"] : [])];
  const documents = new Map<string, any>([["system/publicDeployment/contexts/public", { revision: 2 }],
    ["cmsPosts/one", { published: { sourceVersion: 7, metadata: { type: family === "programs" ? "program" : "event", slug: "one", previousSlugs: ["former"] } } }]]);
  const targets = paths.map(path => ({ status: 200, receipt: { path, target: { projection: { kind: "public-record-family",
    target: { family, documentId: "one", sourceVersion: 7, pagePath: path } } } } }));
  const files = await derivePublicReleasePairPublicReceipts({ pair, documents, baselinePublication: encode(baseline), baselineStatus: encode(baselineStatus),
    targets: targets as any, ownedPaths: new Set(paths) });
  const status = JSON.parse(new TextDecoder().decode(files.find(file => file.path === "/_content-status.json")!.bytes));
  expect(status.routes.filter((row: any) => row.source === "cms")).toEqual([
    { path: `/${family}/one/`, source: "cms", contentKey: hash("cmsPosts/one"), sourceVersion: 7 },
  ]);
  documents.get("cmsPosts/one").published.sourceVersion = 8;
  await expect(derivePublicReleasePairPublicReceipts({ pair, documents, baselinePublication: encode(baseline), baselineStatus: encode(baselineStatus),
    targets: targets as any, ownedPaths: new Set(paths) })).rejects.toMatchObject({ code: "input-unavailable" });
});

it.each([false, true])("matches live receipts and Admin inventory for linked Posts (static %s)", async staticOwner => {
  const result = await receipts(1, true, staticOwner, true, staticOwner, undefined, true);
  const canonical = staticOwner ? "/posts/renamed-story/" : "/posts/story/";
  expect(readPublicContentStatus(result.status, result.publication)).toContainEqual({ path: canonical,
    source: "cms", contentKey: hash("cmsPosts/story"), sourceVersion: staticOwner ? 13 : 8 });
});
it.each([
  ["public-post-shadow", "cmsPosts", "story", "/posts/story/"],
  ["public-page", "cmsPages", "contact", "/contact/"],
  ["public-page-context", "cmsPages", "donate", "/donate/"],
])("retains a canonical 302 %s route in serialized Admin status and omits aliases/withdrawals", async (kind, collection, documentId, canonical) => {
  const documents = new Map<string, any>([["system/publicDeployment/contexts/public", { revision: 2 }]]);
  const target = { documentId, sourceVersion: 7, source: "cms" };
  const row = (path: string, status: number) => ({ status, receipt: { path, target: { projection: { kind, target } } } });
  const files = await derivePublicReleasePairPublicReceipts({ pair, documents, baselinePublication: encode(baseline), baselineStatus: encode(baselineStatus),
    targets: [row("/former/", 308), row("/withdrawn/", 410), row(canonical, 302)] as any, ownedPaths: new Set([canonical, "/former/", "/withdrawn/"]) });
  const publication = JSON.parse(new TextDecoder().decode(files[0].bytes));
  const status = JSON.parse(new TextDecoder().decode(files[1].bytes));
  const routes = readPublicContentStatus(status, publication);
  expect(routes.filter(row => row.source === "cms")).toEqual([{ path: canonical, source: "cms", contentKey: hash(`${collection}/${documentId}`), sourceVersion: 7 }]);
});
