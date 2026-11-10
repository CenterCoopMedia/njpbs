import { contentLinkReadFits } from "../../../packages/content-core/src/content-link.ts";
import { publicPage, isPublicPagePath } from "../../../packages/content-core/src/public-pages";
import { projectPublishedPageRead, projectPageRenderDependencies, projectPageScheduleInputs, type PublishedPageContent } from "./published-page-render";
import type { HomeSourceSnapshot } from "./home-sources";
import { refreshPublishedPageHomeSources, homeProjectionCutoff } from "./published-page-render";

export type PublicPageContextContent = Omit<PublishedPageContent, "kind" | "target"> & {
  readonly kind: "public-page-context";
  readonly target: Readonly<{ documentId: string; pagePath: string; rendererSha: string;
    contextRevision: number; contextDigest: string; codeGeneration: number; source: "cms" | "site";
    sourceVersion?: number }>;
};
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** No editorial operation is manufactured for a committed frame. The source
 * seal identifies the shared public context that owns its shell/dependencies. */
export async function projectPublicPageContextRead(input: unknown, rendererSha: string, now: Date,
  sources: { homeSources?: HomeSourceSnapshot } = {}): Promise<PublicPageContextContent> {
  if (!object(input) || input.kind !== "published-page-context" || typeof input.pageId !== "string" ||
      typeof input.path !== "string" || !publicPage(input.pageId) || !isPublicPagePath(input.pageId, input.path) ||
      !object(input.sourceSeal) || input.sourceSeal.rendererSha !== rendererSha || !/^[a-f0-9]{40}$/.test(rendererSha) ||
      !Number.isSafeInteger(input.sourceSeal.contextRevision) || Number(input.sourceSeal.contextRevision) < 1 ||
      !/^[a-f0-9]{64}$/.test(String(input.sourceSeal.contextDigest)) ||
      !Number.isSafeInteger(input.sourceSeal.codeGeneration) || Number(input.sourceSeal.codeGeneration) < 1 ||
      (input.page !== null && !object(input.page)) ||
      !contentLinkReadFits(input, 8 * 1024 * 1024)) throw new Error("Invalid public Page context read");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`njpbs-public-context-v1:${input.sourceSeal.contextRevision}`));
  const digest = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
  if (digest !== input.sourceSeal.contextDigest) throw new Error("Public Page context seal differs");
  const projected = input.page === null ? null : await projectPublishedPageRead({ ...input, kind: "published-page" },
    input.pageId, rendererSha, now, sources.homeSources);
  if (!projected && input.pageId.startsWith("page-")) throw new Error("Custom Pages require a public editorial snapshot");
  if (!projected && input.path !== publicPage(input.pageId)!.path && !(input.pageId === "give" && input.path === "/donate/")) {
    throw new Error("This Page path has no committed frame");
  }
  const dependencies = projected ?? projectPageRenderDependencies(input, input.pageId, rendererSha, now);
  if (input.pageId === "home" && !sources.homeSources) throw new Error("Home frame requires exact source pools");
  const homeSources = input.pageId === "home" ? projected?.homeSources ??
    await refreshPublishedPageHomeSources(sources.homeSources!, dependencies.posts, undefined, rendererSha,
      homeProjectionCutoff(input, sources.homeSources!, now), sources.homeSources!.publication,
      dependencies.recordCards, dependencies.newsletterCards, dependencies.newsletterUnavailable) : undefined;
  if (projected && projected.target.pagePath !== input.path) throw new Error("Context Page does not own this path");
  const schedule = projected?.schedule ?? await projectPageScheduleInputs(input, input.pageId, rendererSha);
  return freeze({ ...dependencies, kind: "public-page-context", pages: projected?.pages ?? [],
    target: { documentId: input.pageId, pagePath: input.path, rendererSha,
      contextRevision: Number(input.sourceSeal.contextRevision), contextDigest: digest,
      codeGeneration: Number(input.sourceSeal.codeGeneration), source: projected ? "cms" : "site",
      ...(projected ? { sourceVersion: projected.target.sourceVersion } : {}) },
    ...(homeSources ? { homeSources } : {}), ...(schedule ? { schedule } : {}) });
}
