import { publicRecordFamily, readDurableRecordAuthority } from "./durable-record-withdrawals";
import { serveDataHubEmbed } from "../../packages/content-core/src/data-hub-embed";
import { createTransitionalPostReadWorker } from "./transitional-post-read-worker";
import { createNoBuildPageWorker, isPageScheduleExportPath } from "./no-build-page-worker";
import { pendingAuthorResponse } from "./public-author-pending";
import { publicationTarget } from "../../functions/lib/publication-target";
import * as compiled from "../../site/.public-post-renderer/server/entry.mjs";
import type { PublicContentEntrypoint } from "../../cms-api/src/index";
import { readDurablePostWithdrawal } from "./durable-post-withdrawals";
import { readDurablePageWithdrawal } from "./durable-page-withdrawals";
import { createNoBuildCodePostWorker } from "./no-build-code-post-worker";
import { rollbackCacheControl, rollbackProbe, rollbackRead, versionedProof } from "./rollback-proof";
import { serveSpotlightArchiveRedirect } from "./spotlight-archive-redirect";
import { SPOTLIGHT_ARCHIVE_REDIRECT_ASSETS } from "../../packages/content-core/src/spotlight-archive-paths";

const target = publicationTarget("development");
// Runtime Page capability binds the exact compiled graph; older candidates
// can still expose only their original rendering exports.
const graph: Partial<typeof compiled> = { ...compiled };
const { rendererSha, renderPublishedPost } = compiled;
type DevPublicEnv = Omit<DevPublicBindings, "CMS_API"> & {
  CMS_API: Service<typeof PublicContentEntrypoint>;
  NO_BUILD_PAGE_RENDERER_SHA?: string;
  NO_BUILD_CODE_POST_RENDERER_SHA?: string;
  NO_BUILD_RECORD_RENDERER_SHA?: string;
};

// The staff gateway owns access. The private reader owns Post admission and
// retained routes; unrelated paths keep the frozen dev Assets contract.
const devPublic = {
  async fetch(request: Request, env: DevPublicEnv, ctx: ExecutionContext, scheduleProof = false): Promise<Response> {
    if (new URL(request.url).origin !== target.origin) {
      return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
    }
    if (new URL(request.url).pathname.startsWith(SPOTLIGHT_ARCHIVE_REDIRECT_ASSETS)) {
      return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
    }
    const figure = serveDataHubEmbed(request, assetRequest => env.ASSETS.fetch(assetRequest));
    if (figure) return figure;
    if (env.NO_BUILD_PAGE_RENDERER_SHA || env.DURABLE_POST_WITHDRAWALS || isPageScheduleExportPath(new URL(request.url).pathname)) {
      const pages = createNoBuildPageWorker({ target, rendererSha, render: content => {
        if (!graph.renderPublishedPage) throw new Error("Page graph unavailable");
        return graph.renderPublishedPage(content);
      }, renderContext: content => {
        if (!graph.renderPublicPageContext) throw new Error("Page context graph unavailable");
        return graph.renderPublicPageContext(content);
      }, rendererReady: env.NO_BUILD_PAGE_RENDERER_SHA === rendererSha &&
        typeof graph.renderPublishedPage === "function" && typeof graph.renderPublicPageContext === "function",
        cache: (caches as CacheStorage & { default: Cache }).default,
        fetchAsset: assetRequest => env.ASSETS.fetch(assetRequest),
        readWithdrawal: path => readDurablePageWithdrawal(env.DURABLE_POST_WITHDRAWALS, target.workerName, path),
        withdrawalsOnly: !env.NO_BUILD_PAGE_RENDERER_SHA,
        scheduleProof,
        getDecision: (path, method, pageStatus) => env.CMS_API.getNoBuildPage(path, rendererSha, method, false, scheduleProof, pageStatus) });
      const pageResponse = await pages.fetch(request);
      if (pageResponse) return pageResponse;
    }
    const codePosts = createNoBuildCodePostWorker({ target, rendererSha, render: renderPublishedPost,
      rendererReady: env.NO_BUILD_POST_RENDERER_SHA === rendererSha,
      readWithdrawal: slug => readDurablePostWithdrawal(env.DURABLE_POST_WITHDRAWALS, target.workerName, slug),
      getDecision: (path, method) => env.CMS_API.getNoBuildCodePost(path, rendererSha, method) });
    const posts = createTransitionalPostReadWorker({
      target, rendererSha, render: renderPublishedPost, cache: (caches as CacheStorage & { default: Cache }).default,
      rendererReady: env.NO_BUILD_POST_RENDERER_SHA === rendererSha,
      recordRendererReady: env.NO_BUILD_RECORD_RENDERER_SHA === rendererSha,
      readRecordAuthority: path => readDurableRecordAuthority(env.DURABLE_POST_WITHDRAWALS, target.workerName, path),
      waitUntil: task => ctx.waitUntil(task),
      fetchAsset: assetRequest => env.ASSETS.fetch(assetRequest),
      readWithdrawal: slug => readDurablePostWithdrawal(env.DURABLE_POST_WITHDRAWALS, target.workerName, slug),
      readCodePost: env.NO_BUILD_CODE_POST_RENDERER_SHA === rendererSha ? codeRequest => codePosts.fetch(codeRequest) : undefined,
      getDecision: (path, method, probe) => {
        if ((publicRecordFamily(path) ? env.NO_BUILD_RECORD_RENDERER_SHA : env.NO_BUILD_POST_RENDERER_SHA) !== rendererSha) throw new Error("Dev renderer release is invalid");
        return env.CMS_API.getNoBuildPost(path, rendererSha, method, probe);
      },
    });
    const postResponse = await posts.fetch(request);
    if (postResponse) return pendingAuthorResponse(request, postResponse, { rendererSha,
      fetchAsset: assetRequest => env.ASSETS.fetch(assetRequest),
      readStaff: path => env.CMS_API.getNoBuildPage(path, rendererSha, "HEAD") });
    const asset = await serveSpotlightArchiveRedirect(request, await env.ASSETS.fetch(request),
      input => env.ASSETS.fetch(input),
      async canonical => await posts.fetch(canonical) ?? env.ASSETS.fetch(canonical));
    if (!["/_publication.json", "/_content-status.json"].includes(new URL(request.url).pathname)) {
      return pendingAuthorResponse(request, asset, { rendererSha,
        fetchAsset: assetRequest => env.ASSETS.fetch(assetRequest),
        readStaff: path => env.CMS_API.getNoBuildPage(path, rendererSha, "HEAD") });
    }
    const headers = new Headers(asset.headers);
    headers.set("x-njpbs-publication-origin", target.workerName);
    headers.set("cache-control", "no-store");
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  },
};

export default {
  async fetch(request: Request, env: DevPublicEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const read = url.origin === target.origin ? rollbackRead(url, request.method) : null;
    const probe = request.headers.get(rollbackProbe);
    if (!read || !probe || request.headers.get("cache-control") !== rollbackCacheControl) {
      return devPublic.fetch(request, env, ctx);
    }
    const version = env.CF_VERSION_METADATA?.id;
    if (!version || probe !== (read === "edge" ? "current" : version)) {
      return versionedProof(new Response(null, { status: 503 }), version);
    }
    try {
      return versionedProof(await devPublic.fetch(request, env, ctx, read === "schedule"), version);
    } catch {
      return versionedProof(new Response(null, { status: 503 }), version);
    }
  },
} satisfies ExportedHandler<DevPublicEnv>;
