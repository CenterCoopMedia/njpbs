import { devFunctionsEnvironment } from "../../tests/helpers/dev-deployment-config.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const source = async (name: string) => readFile(path.resolve(process.cwd(), "..", name), "utf8");
const config = async (name: string) => JSON.parse((await source(name)).replace(/^\s*\/\/.*$/gm, ""));

it("keeps distinct production and dev renderer and gateway targets", async () => {
  const [productionRenderer, devRenderer, productionGateway, devGateway] = await Promise.all([
    config("preview-renderer/wrangler.jsonc"), config("preview-renderer/wrangler.dev.jsonc"),
    config("workers/wrangler.preview.jsonc"), config("workers/wrangler.preview.dev.jsonc"),
  ]);
  expect(productionRenderer.name).toBe("njpbs-cms-preview-renderer");
  expect(productionRenderer.containers[0].name).toBe("njpbs-cms-preview-renderer");
  expect(devRenderer.name).toBe("template-dev-cms-preview-renderer");
  expect(devRenderer.containers[0].name).toBe("template-dev-cms-preview-renderer");
  expect(devRenderer.vars).toMatchObject({ PREVIEW_RENDERER_ENABLED: "false",
    CMS_DEPLOYMENT_ENVIRONMENT: "development", FIREBASE_PROJECT_ID: "njpbs-site-dev" });
  expect(devRenderer.secrets.required).toEqual(expect.arrayContaining([
    "CMS_DEV_ACCESS_CLIENT_ID", "CMS_DEV_ACCESS_CLIENT_SECRET",
  ]));
  expect(productionGateway.r2_buckets[0].bucket_name).toBe("njpbs-cms-previews");
  expect(devGateway).toMatchObject({ name: "template-dev-cms-preview", workers_dev: false, preview_urls: false,
    r2_buckets: [{ binding: "PREVIEWS", bucket_name: "template-dev-cms-previews" }] });
  expect(devGateway.routes).toBeUndefined();
});

it("sends the renderer's publication receipt read through the public Worker, not the zone origin", async () => {
  // Without this flag a fetch to the zone's own URL skips the Worker that serves
  // _publication.json, and every current-code read refused in production (#3444).
  for (const name of ["preview-renderer/wrangler.jsonc", "preview-renderer/wrangler.dev.jsonc"]) {
    expect((await config(name)).compatibility_flags).toContain("global_fetch_strictly_public");
  }
});

it("keeps checked-in dev admission paused and enables deployed preview only after the renderer job", async () => {
  // #2957 replaces the original disabled-only requirement with a matched,
  // runtime-verified dev release. Static Functions inputs still fail closed.
  expect(devFunctionsEnvironment({ CMS_MEDIA_BUCKET: "fixture-dev-media", CMS_MEDIA_ORIGIN: "https://media.fixture.test" }, pathToFileURL(path.resolve(process.cwd(), "..") + path.sep))).toMatch(/^CMS_PREVIEW_SERIALIZER_READY=false$/m);
  const workflow = await source(".github/workflows/cms-dev-deploy.yml");
  expect(workflow).toMatch(/needs: preview-renderer/);
  expect(workflow).toMatch(/CMS_DEV_RENDERER_SOURCE_SHA: \$\{\{ inputs\.release_preview_renderer && needs\.preview-renderer\.outputs\.renderer_sha \|\| vars\.CMS_DEV_RENDERER_SOURCE_SHA \}\}/);
  // An explicit release matches the selected application pin after main advances.
  expect(workflow).toMatch(/if \[ "\$CMS_DEV_RELEASE_PREVIEW_RENDERER" = true \]; then\s+test "\$CMS_DEV_RENDERER_SOURCE_SHA" = "\$DEPLOY_SHA"/);
  expect(workflow).toMatch(/test "\$\(git rev-parse HEAD\)" = "\$DEPLOY_SHA"/);
  expect(workflow).toMatch(/VITE_CMS_PREVIEW_ENABLED: 'true'/);
});
