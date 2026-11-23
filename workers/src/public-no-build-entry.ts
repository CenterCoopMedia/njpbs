import { observePublicIsolateStart, type IsolateStartEnvironment } from "./public-isolate-start";
import { publicRecordFamily, readDurableRecordAuthority } from "./durable-record-withdrawals";
import { servePublicRequest } from "./public-worker";
import { createNoBuildPageWorker, isPageScheduleExportPath } from "./no-build-page-worker";
import { readDurablePageWithdrawal } from "./durable-page-withdrawals";
import { publicationTarget } from "../../functions/lib/publication-target";
import { createTransitionalPostReadWorker } from "./transitional-post-read-worker";
import { renderPublishedPost, renderPublishedPage, renderPublicPageContext, rendererSha } from "../../site/.public-post-renderer/server/entry.mjs";
import type { PublicContentEntrypoint } from "../../cms-api/src/index";
import { readDurablePostWithdrawal } from "./durable-post-withdrawals";
import { createNoBuildCodePostWorker } from "./no-build-code-post-worker";
import { createPublicContentLastGood } from "./public-content-last-good";
import { createContentBaselineAssetReader } from "./public-content-baseline";
import { pendingAuthorResponse } from "./public-author-pending";
import { rollbackCacheControl, rollbackProbe, rollbackRead, versionedProof } from "./rollback-proof";

type PublicEnv = Omit<Env, "CMS_API"> & IsolateStartEnvironment & {
  CMS_API: Service<typeof PublicContentEntrypoint>;
  NO_BUILD_POST_RENDERER_SHA?: string;
  NO_BUILD_PAGE_RENDERER_SHA?: string;
  NO_BUILD_CODE_POST_RENDERER_SHA?: string;
  NO_BUILD_RECORD_RENDERER_SHA?: string;
  /** Set only by the development upload; production leaves it unset. */
  PUBLICATION_ENVIRONMENT?: string;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
};
type Target = ReturnType<typeof publicationTarget>;

export default {
  async fetch(request: Request, env: PublicEnv, ctx: ExecutionContext): Promise<Response> {
    observePublicIsolateStart(env);
    const target = publicationTarget(env.PUBLICATION_ENVIRONMENT === "development" ? "development" : "production");
    const url = new URL(request.url);
    if (url.origin !== target.origin) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
    // Only development answers the version-selected rollback proof reads.
    const read = target.environment === "development" ? rollbackRead(url, request.method) : null;
    const probe = request.headers.get(rollbackProbe);
    if (!read || !probe || request.headers.get("cache-control") !== rollbackCacheControl) {
      return serve(request, env, ctx, target, false);
    }
    const version = env.CF_VERSION_METADATA?.id;
    if (!version || probe !== (read === "edge" ? "current" : version)) {
      return versionedProof(new Response(null, { status: 503 }), version);
    }
    try {
      return versionedProof(await serve(request, env, ctx, target, read === "schedule"), version);
    } catch {
      return versionedProof(new Response(null, { status: 503 }), version);
    }
  },
} satisfies ExportedHandler<PublicEnv>;

async function serve(request: Request, env: PublicEnv, ctx: ExecutionContext, target: Target, scheduleProof: boolean): Promise<Response> {
  const assets = (assetRequest: Request) => env.ASSETS.fetch(assetRequest);
  const fetchAsset = env.DURABLE_POST_WITHDRAWALS ? createContentBaselineAssetReader({
    target, rendererSha, store: env.DURABLE_POST_WITHDRAWALS, fetchAsset: assets }) : assets;
  if (env.NO_BUILD_PAGE_RENDERER_SHA || env.DURABLE_POST_WITHDRAWALS || isPageScheduleExportPath(new URL(request.url).pathname)) {
    const pages = createNoBuildPageWorker({ target, rendererSha, cache: caches.default,
      rendererReady: env.NO_BUILD_PAGE_RENDERER_SHA === rendererSha,
      withdrawalsOnly: !env.NO_BUILD_PAGE_RENDERER_SHA,
      render: renderPublishedPage, renderContext: renderPublicPageContext,
      fetchAsset,
      lastGood: env.DURABLE_POST_WITHDRAWALS ? createPublicContentLastGood({
        store: env.DURABLE_POST_WITHDRAWALS, target, rendererSha }) : undefined,
      waitUntil: task => ctx.waitUntil(task),
      readWithdrawal: path => readDurablePageWithdrawal(env.DURABLE_POST_WITHDRAWALS, target.workerName, path),
      scheduleProof,
      getDecision: (path, method) => env.CMS_API.getNoBuildPage(path, rendererSha, method, true, scheduleProof) });
    const response = await pages.fetch(request);
    if (response) return response;
  }
  const codePosts = createNoBuildCodePostWorker({ target, rendererSha, render: renderPublishedPost,
    rendererReady: !env.NO_BUILD_POST_RENDERER_SHA || env.NO_BUILD_POST_RENDERER_SHA === rendererSha,
    readWithdrawal: slug => readDurablePostWithdrawal(env.DURABLE_POST_WITHDRAWALS, target.workerName, slug),
    getDecision: (path, method) => env.CMS_API.getNoBuildCodePost(path, rendererSha, method) });
  const noBuildPosts = createTransitionalPostReadWorker({
    target, rendererSha, render: renderPublishedPost, cache: caches.default,
    rendererReady: !env.NO_BUILD_POST_RENDERER_SHA || env.NO_BUILD_POST_RENDERER_SHA === rendererSha,
    recordRendererReady: env.NO_BUILD_RECORD_RENDERER_SHA === rendererSha,
    readRecordAuthority: path => readDurableRecordAuthority(env.DURABLE_POST_WITHDRAWALS, target.workerName, path),
    waitUntil: task => ctx.waitUntil(task),
    lastGood: env.DURABLE_POST_WITHDRAWALS ? createPublicContentLastGood({
      store: env.DURABLE_POST_WITHDRAWALS, target, rendererSha }) : undefined,
    fetchAsset,
    readWithdrawal: slug => readDurablePostWithdrawal(env.DURABLE_POST_WITHDRAWALS, target.workerName, slug),
    readCodePost: env.NO_BUILD_CODE_POST_RENDERER_SHA === rendererSha ? codeRequest => codePosts.fetch(codeRequest) : undefined,
    getDecision: (path, method, probe) => {
      const capability = publicRecordFamily(path) ? env.NO_BUILD_RECORD_RENDERER_SHA : env.NO_BUILD_POST_RENDERER_SHA;
      if (capability && capability !== rendererSha) {
        throw new Error("Public renderer release is invalid");
      }
      return env.CMS_API.getNoBuildPost(path, rendererSha, method, probe);
    },
  });
  const response = await servePublicRequest(request, {
    fetchAsset,
    getPublishedPage: pageId => env.CMS_API.getPublishedPage(pageId),
    noBuildPosts, publicationOrigin: target.workerName,
    projectionCache: caches.default, waitUntil: task => ctx.waitUntil(task),
  });
  return pendingAuthorResponse(request, response, { rendererSha, fetchAsset,
    readStaff: path => env.CMS_API.getNoBuildPage(path, rendererSha, "HEAD") });
}
