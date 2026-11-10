// @vitest-environment node
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createNoBuildCodePostWorker, type CodePostReply } from "../../workers/src/no-build-code-post-worker";
import { projectPublishedPostRead } from "../src/lib/published-post-shadow";
import { projectCmsPost } from "../src/lib/cms-posts-projection";
import fixture from "./fixtures/shadow-posts/post.json";
import { renderRichText } from "../../packages/content-core/src/content-model";
import type { Withdrawal } from "../../workers/src/durable-post-withdrawals";
import { createRequire } from "node:module";
const { readPostSettingsReceipt } = createRequire(import.meta.url)("../../functions/lib/no-build-post-settings-confirmation.js");

const rendererSha = "a".repeat(40), now = new Date("2026-10-08T12:00:00.000Z");
const path = "/posts/shadow-fixture/", origin = "https://njpbs.org";
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)])) : value;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const digest = (value: unknown) => sha(JSON.stringify(canonical(value)));
const html = (title: string, cards: string) => `<!doctype html><html><title>${title}</title><main>${cards}</main></html>`;
function harness(formattedBody = false, contentLinkMode?: "custom") {
  const published: any = structuredClone(fixture);
  published.document.published.blocks.push({ id: "newsletter", type: "record_card", order: 1, visible: true,
    data: { recordKind: "newsletter", recordId: "newsletter-one" } });
  published.joinedRecords = [{ id: "newsletter-one", type: "newsletter", version: 9, status: "draft", deleted: false,
    title: "Private working newsletter", approvedLibraryVersion: { id: "newsletter-one", type: "newsletter", version: 7,
      status: "approved", deleted: false, title: "Approved newsletter", signupUrl: "https://example.test/signup" } }];
  if (formattedBody) {
    published.document.published.blocks[0].data.content.content[0].content[1].marks[0].attrs.rel = "noopener noreferrer";
    published.document.published.blocks[0].data.content.content.unshift({ type: "heading", attrs: { level: 2, id: "details", class: null },
      content: [{ type: "text", text: "Details" }] });
  }
  if (contentLinkMode) Object.assign(published.document.published.metadata, { contentLinkMode, contentLinkUrl: "https://example.test/code-story", contentLinkNewTab: true });
  // This unchanged static projector supplies the committed code body oracle.
  const codeFrame = projectCmsPost(published.document, { now, assets: new Map() });
  // Frozen public DTO: The existing reader keeps heading level and link href,
  // and removes editor id/class/rel. Site CI needs no Functions packages.
  if (formattedBody) published.document.published.blocks[0].data.content = {
    type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Details" }] },
      ...structuredClone(fixture.document.published.blocks[0].data.content.content)],
  };
  let marker: Withdrawal | null = null, contextRevision = 4;
  let replyOverride: ((reply: any) => CodePostReply) | null = null;
  let duringRender: (() => void) | null = null;
  const reply = (requestPath = path): any => {
    const receipt = { schemaVersion: 1, postId: "shadow-fixture", sourceVersion: 7, canonicalPath: path, path: requestPath,
      rendererSha, snapshotDigest: digest(published.document.published), contextRevision,
      contextDigest: sha(`njpbs-public-context-v1:${contextRevision}`), codeContextDigest: "c".repeat(64),
      codeFrameDigest: digest(codeFrame), inputSourceDigest: digest(published), code: { schemaVersion: 1, digestAlgorithm: "sha256",
        buildBatchId: `cms-${"C".repeat(20)}`, generation: 3, commitSha: rendererSha,
        artifactDigest: "d".repeat(64), artifactReceiptDigest: "e".repeat(64), mediaManifestDigest: "f".repeat(64) } };
    const result = requestPath === path ? { kind: "code-post", receipt, published, codeFrame }
      : { kind: "code-post-alias", receipt, location: path };
    return replyOverride ? replyOverride(structuredClone(result)) : structuredClone(result);
  };
  const worker = createNoBuildCodePostWorker({ rendererSha, now: () => now, readWithdrawal: async () => marker,
    getDecision: async requested => reply(requested), render: async content => {
      duringRender?.();
      const block = content.posts[0].blocks[0];
      const prose = formattedBody && block.type === "prose" ? renderRichText(block.data.content) : "";
      return html(content.posts[0].title, prose + (content.recordCards ?? []).map(card => card.title).join(" "));
    } });
  return { published, worker, reply, request: (method = "GET", requested = path) => worker.fetch(new Request(origin + requested, { method })),
    override: (fn: typeof replyOverride) => { replyOverride = fn; }, onRender: (fn: typeof duringRender) => { duringRender = fn; },
    withdraw: () => { marker = { postId: "shadow-fixture", sourceVersion: 7, revision: 3, operationId: "A".repeat(20), ownedSlugs: ["shadow-fixture"], verifiedAt: 1234 }; },
    advanceContext: () => { contextRevision++; } };
}

it("retains the committed Post body while serving the current approved Newsletter card", async () => {
  const h = harness();
  let response = (await h.request())!;
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(html("A published fixture", "Approved newsletter"));
  const firstInput = response.headers.get("x-njpbs-input-source-sha256");
  h.published.joinedRecords[0].approvedLibraryVersion.title = "New approved newsletter";
  h.published.joinedRecords[0].approvedLibraryVersion.version = 8;
  h.advanceContext();
  response = (await h.request())!;
  expect(await response.text()).toBe(html("A published fixture", "New approved newsletter"));
  expect(response.headers.get("x-njpbs-content-source")).toBe("cms-code-post-context");
  expect(response.headers.get("x-njpbs-input-source-sha256")).not.toBe(firstInput);
  expect(response.headers.get("x-njpbs-publication-operation")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("omits a removed card and keeps HEAD and aliases on the same code frame", async () => {
  const h = harness();
  h.published.joinedRecords = [];
  expect(await (await h.request())!.text()).toBe(html("A published fixture", ""));
  const head = (await h.request("HEAD"))!;
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  expect(head.headers.get("x-njpbs-html-sha256")).toBe(sha(html("A published fixture", "")));
  const alias = (await h.request("GET", "/posts/old-fixture/"))!;
  expect(alias.status).toBe(308);
  expect(alias.headers.get("location")).toBe(path);
});

it.each(["body", "frame", "input", "release", "context"])("refuses changed %s evidence", async changed => {
  const h = harness();
  h.override(reply => {
    if (changed === "body") reply.published.document.published.metadata.title = "Different body";
    if (changed === "frame") reply.codeFrame.title = "Different committed frame";
    if (changed === "input") reply.receipt.inputSourceDigest = "0".repeat(64);
    if (changed === "release") reply.receipt.code.commitSha = "b".repeat(40);
    if (changed === "context") reply.receipt.contextDigest = "0".repeat(64);
    return reply;
  });
  const response = (await h.request())!;
  expect(response.status).toBe(503);
  expect(await response.text()).toBe("");
});

it("refuses a context change during render and lets a concurrent durable withdrawal win", async () => {
  const h = harness();
  h.onRender(h.advanceContext);
  expect((await h.request())!.status).toBe(503);
  h.onRender(h.withdraw);
  expect((await h.request())!.status).toBe(410);
});

it("keeps durable withdrawals absent through private authority failures", async () => {
  const h = harness();
  h.withdraw();
  h.override(() => { throw new Error("Private failure detail"); });
  const response = (await h.request())!;
  expect(response.status).toBe(410);
  expect(await response.text()).toBe("");
});

it("passes unrelated and newly owned Posts to their existing reader", async () => {
  const h = harness();
  h.override(() => ({ kind: "pass" }));
  expect(await h.request()).toBeNull();
  expect(await h.worker.fetch(new Request("https://njpbs.org/programs/example/"))).toBeNull();
  expect(await h.worker.fetch(new Request("https://other.example/posts/shadow-fixture/"))).toBeNull();
});

it("keeps formatted CODE body output exact when private input strips editor attributes", async () => {
  const h = harness(true);
  expect(h.reply().codeFrame).toEqual(projectPublishedPostRead(h.published, "shadow-fixture", rendererSha, now)!.posts[0]);
  const response = (await h.request())!;
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(html("A published fixture", '<h2>Details</h2><p>Published body with <a href="/about/">a link</a>.</p>Approved newsletter'));
});

it.each(["GET", "HEAD"])("serves the frozen code Post custom destination as 302 with %s", async method => {
  const h = harness(false, "custom");
  const response = (await h.request(method))!;
  expect(response.status).toBe(302); expect(response.headers.get("location")).toBe("https://example.test/code-story");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow"); expect(await response.text()).toBe("");
});

it("confirms the exact code Post redirect during a settings publication and refuses a substituted destination", async () => {
  const h = harness(false, "custom");
  const entry = { kind: "code-post", postId: "shadow-fixture", receipt: h.reply().receipt,
    contentRedirectUrl: "https://example.test/code-story" };
  const read = (fetchPublic: () => Promise<Response | null>) => readPostSettingsReceipt({ entry, target: { origin },
    headers: new Headers(), signal: new AbortController().signal, fetchPublic });
  await expect(read(() => h.request())).resolves.toEqual({ postId: "shadow-fixture", path, htmlDigest: null });
  await expect(read(async () => {
    const response = (await h.request())!;
    response.headers.set("location", "https://example.test/substituted");
    return response;
  })).rejects.toThrow("unavailable public receipt");
});
