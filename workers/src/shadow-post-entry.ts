/// <reference path="./shadow-post-worker-configuration.d.ts" />
/// <reference types="@cloudflare/workers-types" />
import { serveShadowStaffPost } from "./shadow-staff-gateway";
import { createShadowPostWorker, servicePublishedPostReader } from "./shadow-post-worker";
// Generated once per reviewed source release by build:shadow.
import { rendererSha, renderPublishedPost } from "../../site/.shadow-renderer/server/entry.mjs";

export default {
  fetch(request: Request, env: ShadowPostEnv & { PUBLISHED_POST_READER_HMAC_KEY: string }): Promise<Response> {
    return serveShadowStaffPost(request, env, {
      validateAccess: token => env.STAFF_ACCESS.validateAccess(token,
        request.headers.get("cf-connecting-ip")?.trim() || "missing"),
      serveAsset: clean => env.SHADOW_ASSETS.fetch(clean),
      serveOrigin: clean => fetch(clean),
      shadow: createShadowPostWorker({
        reader: servicePublishedPostReader(env.PUBLISHED_POSTS, { secret: env.PUBLISHED_POST_READER_HMAC_KEY }), render: renderPublishedPost,
        revisions: env.SHADOW_POST_REVISIONS_ENABLED === "true" && "SHADOW_POST_REVISIONS" in env ? env.SHADOW_POST_REVISIONS : undefined,
        rendererSha, cache: (caches as CacheStorage & { readonly default: Cache }).default,
      }),
    });
  },
} satisfies ExportedHandler<ShadowPostEnv & { PUBLISHED_POST_READER_HMAC_KEY: string }>;
