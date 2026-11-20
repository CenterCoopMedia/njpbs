import { contentLinkRedirect } from "../../packages/content-core/src/content-link.ts";
import { SECURITY_HEADER_BASELINE } from "../../packages/content-core/src/public-security-headers";
import { PUBLIC_GONE_BRANCH_HEADER } from "./public-gone";
import { assertPublicationTarget, publicationTarget, type PublicationTarget } from "../../functions/lib/publication-target";
import { projectPublishedPostRead, type PublishedPostContent } from "../../site/src/lib/published-post-shadow";
import { WITHDRAWAL_UNKNOWN_HEADER, type Withdrawal } from "./durable-post-withdrawals";

import type { CodePostReceipt, CodePostReply } from "../../packages/content-core/src/code-post-context";
export type { CodePostReceipt, CodePostReply } from "../../packages/content-core/src/code-post-context";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)])) : value;
}
async function shaText(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
const digest = (value: unknown) => shaText(JSON.stringify(canonical(value)));
function failure(status = 503, withdrawalUnknown = false, goneBranch?: string) {
  return new Response(null, { status, headers: { ...SECURITY_HEADER_BASELINE,
    "cache-control": "no-store", "x-robots-tag": "noindex, nofollow",
    ...(status === 405 ? { Allow: "GET, HEAD" } : {}),
    ...(goneBranch ? { [PUBLIC_GONE_BRANCH_HEADER]: goneBranch } : {}),
    ...(withdrawalUnknown ? { [WITHDRAWAL_UNKNOWN_HEADER]: "unknown" } : {}) } });
}
function newerThan(marker: Withdrawal | null, receipt: CodePostReceipt) {
  return !marker || marker.postId === receipt.postId &&
    receipt.sourceVersion > marker.sourceVersion && receipt.code.generation > marker.revision;
}
async function receiptHeaders(receipt: CodePostReceipt, path: string, rendererSha: string) {
  const code = receipt?.code;
  if (!receipt || receipt.schemaVersion !== 1 || receipt.path !== path || receipt.rendererSha !== rendererSha ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.postId) || !Number.isSafeInteger(receipt.sourceVersion) || receipt.sourceVersion < 1 ||
      !/^\/posts\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(receipt.canonicalPath) ||
      !Number.isSafeInteger(receipt.contextRevision) || receipt.contextRevision < 1 ||
      receipt.contextDigest !== await shaText(`njpbs-public-context-v1:${receipt.contextRevision}`) ||
      code?.schemaVersion !== 1 || code.digestAlgorithm !== "sha256" || code.commitSha !== rendererSha ||
      !/^cms-[A-Za-z0-9]{20}$/.test(code.buildBatchId) || !Number.isSafeInteger(code.generation) || code.generation < 1 ||
      [receipt.snapshotDigest, receipt.codeContextDigest, receipt.codeFrameDigest, receipt.inputSourceDigest,
        code.artifactDigest, code.artifactReceiptDigest, code.mediaManifestDigest].some(value => !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error("Invalid code Post context receipt");
  }
  return new Headers({ ...SECURITY_HEADER_BASELINE, "cache-control": "no-store", "x-njpbs-content-source": "cms-code-post-context",
    "x-njpbs-renderer-sha": rendererSha, "x-njpbs-source-version": String(receipt.sourceVersion),
    "x-njpbs-context-sha256": receipt.contextDigest, "x-njpbs-public-context-revision": String(receipt.contextRevision),
    "x-njpbs-code-generation": String(code.generation), "x-njpbs-code-receipt-sha256": code.artifactReceiptDigest,
    "x-njpbs-code-context-sha256": receipt.codeContextDigest, "x-njpbs-code-post-frame-sha256": receipt.codeFrameDigest,
    "x-njpbs-input-source-sha256": receipt.inputSourceDigest, "x-njpbs-snapshot-sha256": receipt.snapshotDigest });
}

/** The frozen code Post body stays exact; current approved record joins can
 * change. Every response rechecks private authority and durable withdrawals. */
export function createNoBuildCodePostWorker({ rendererSha, target = publicationTarget(), getDecision, render, readWithdrawal,
  rendererReady = true, now = () => new Date() }: {
  rendererSha: string; target?: PublicationTarget; rendererReady?: boolean;
  getDecision(path: string, method: string): Promise<CodePostReply>;
  render(content: PublishedPostContent): Promise<string>; readWithdrawal(slug: string): Promise<Withdrawal | null>; now?: () => Date;
}) {
  target = assertPublicationTarget(target);
  return { async fetch(request: Request): Promise<Response | null> {
    const url = new URL(request.url), path = url.pathname, head = request.method === "HEAD";
    if (url.origin !== target.origin || !/^\/posts\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(path)) return null;
    let known: Withdrawal | null = null;
    let visible: CodePostReceipt | undefined;
    try {
      known = await readWithdrawal(path.slice(7, -1));
      const reply = await getDecision(path, head ? "HEAD" : "GET");
      if (reply.kind === "pass") return known ? failure(410, false, "code-post-tombstone-unowned") : null;
      if (reply.kind === "code-post-unavailable" || !rendererReady) {
        return known ? failure(410, false, "code-post-tombstone-authority") : failure();
      }
      if (!["GET", "HEAD"].includes(request.method)) return failure(405);
      const headers = await receiptHeaders(reply.receipt, path, rendererSha);
      if (!newerThan(known, reply.receipt)) return failure(410, false, "code-post-tombstone-conflict");
      visible = reply.receipt;
      known = null;
      let body: string | null = null;
      let status = reply.kind === "code-post-alias" ? 308 : 200;
      if (reply.kind === "code-post") {
        const content = projectPublishedPostRead(reply.published, reply.receipt.canonicalPath.slice(7, -1), rendererSha, now());
        if (!content || content.target.documentId !== reply.receipt.postId || content.target.sourceVersion !== reply.receipt.sourceVersion ||
            await digest(reply.published) !== reply.receipt.inputSourceDigest ||
            await digest(reply.codeFrame) !== reply.receipt.codeFrameDigest || await digest(content.posts[0]) !== reply.receipt.codeFrameDigest) {
          throw new Error("Code Post body or current joins changed");
        }
        headers.set("x-njpbs-input-sha256", await digest(content));
        const outbound = contentLinkRedirect(content.posts[0], headers);
        if (outbound) {
          status = 302; headers.set("location", outbound.headers.get("location")!); headers.set("x-robots-tag", "noindex, nofollow");
        } else {
          body = await render(content);
          if (new TextEncoder().encode(body).length > 2 * 1024 * 1024 || !/^\s*<!doctype html>/i.test(body) || !/<\/html>/i.test(body)) {
            throw new Error("Code Post HTML is incomplete");
          }
          headers.set("content-type", "text/html; charset=utf-8");
          headers.set("x-njpbs-html-sha256", await shaText(body));
        }
      } else {
        if (reply.location !== reply.receipt.canonicalPath || reply.location === path) throw new Error("Invalid code Post alias");
        headers.set("location", reply.location);
      }
      const current = await getDecision(path, head ? "HEAD" : "GET");
      const finalWithdrawal = await readWithdrawal(path.slice(7, -1));
      if (!newerThan(finalWithdrawal, reply.receipt)) return failure(410, false, "code-post-tombstone-race");
      if (await digest(current) !== await digest(reply)) throw new Error("Code Post authority changed");
      return new Response(head ? null : body, { status, headers });
    } catch {
      if (known) return failure(410, false, "code-post-tombstone-reader");
      try {
        const latest = await readWithdrawal(path.slice(7, -1));
        if (latest && (!visible || !newerThan(latest, visible))) return failure(410, false, "code-post-tombstone-reader");
        // A retained body still predates this marker even when live authority
        // verified a republish. Refuse the static fallback if rendering failed.
        if (latest) return failure(503, true);
      }
      catch { return failure(503, true); }
      return failure();
    }
  } };
}
