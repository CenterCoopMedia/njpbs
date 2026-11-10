import { repositoryFixture } from "../helpers/repository-identity.mjs";
Object.assign(process.env, repositoryFixture);
process.env.CMS_PUBLISH_GITHUB_REPOSITORY ??= repositoryFixture.CANONICAL_GITHUB_REPOSITORY;
process.env.CLOUDFLARE_PUBLIC_WORKER_TAG ??= "d".repeat(32);
process.env.CLOUDFLARE_PUBLIC_ZONE_ID ??= "b".repeat(32);
const nativeFetch = globalThis.fetch;
// Keep source-storage fixtures independent of deployment account identifiers.
process.env.CMS_MEDIA_ORIGINAL_BUCKETS ??= [
  "njpbs-video-originals-123456789012-us-east-2",
  "njpbs-archive-originals-123456789012-us-east-2",
].join(",");
process.env.CMS_BUG_REPORT_GITHUB_REPOSITORY ??= "example-owner/private-reports";
process.env.CLOUDFLARE_ACCOUNT_ID ??= "a".repeat(32);
process.env.CMS_PUBLISH_GITHUB_TRUSTED_ACTORS ??= JSON.stringify(["fixture-user"]);
process.env.CMS_DEV_ACCESS_ORIGIN ??= "https://fixture.cloudflareaccess.com";
process.env.CMS_DEV_EDITOR_EMAIL ??= "editor-4@example.org";
process.env.CMS_DEV_SDK_CLIENT_EMAIL ??= "dev-seed-writer@njpbs-site-dev.iam.gserviceaccount.com";
process.env.CMS_DEV_CLOUDFLARE_ACCOUNT_ID ??= "a".repeat(32);
process.env.CMS_DEV_FIREBASE_WEB_APP_ID ??= `1:123456789013:web:${"a".repeat(32)}`;
process.env.FIREBASE_WEB_APP_ID ??= `1:123456789013:web:${"a".repeat(32)}`;
const functionsHost =
  process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";

export function cmsEdgeFetch(fetchFn, host) {
  return (input, init = {}) => {
    const inputRequest = input instanceof Request ? input : null;
    let url;
    try {
      url = new URL(inputRequest?.url ?? String(input));
    } catch {
      return fetchFn(input, init);
    }

    if (
      url.protocol === "http:" &&
      url.host === host &&
      url.pathname.includes("/us-central1/")
    ) {
      const headers = new Headers(inputRequest?.headers);
      new Headers(init.headers).forEach((value, name) =>
        headers.set(name, value),
      );
      if ((init.method ?? inputRequest?.method)?.toUpperCase() !== "OPTIONS") {
        headers.set("x-njpbs-cms-edge", "local-cms-edge-only");
      }
      return fetchFn(inputRequest ?? input, { ...init, headers });
    }

    return fetchFn(input, init);
  };
}

globalThis.fetch = cmsEdgeFetch(nativeFetch, functionsHost);

process.env.CMS_DEPLOY_OWNER ??= "fixture-user";
