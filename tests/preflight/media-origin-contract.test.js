import { DEV_TARGETS } from "../../scripts/assert-dev-cms-targets.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const deploy = parse(readFileSync(".github/workflows/cms-dev-deploy.yml", "utf8"));
const publication = parse(readFileSync(".github/workflows/cms-dev-publish.yml", "utf8"));
const devOrigin = DEV_TARGETS.CMS_MEDIA_ORIGIN;
const production = "https://media.njpbs.org";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe.each([undefined, "production", "development", "preview"])("video media boundary in %s", environment => {
  it("agrees across TypeScript and the generated CommonJS reader", async () => {
    vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", environment);
    // An origin override must never widen production or dev admission.
    vi.stubEnv("CMS_MEDIA_ORIGIN", "https://example.com");
    vi.resetModules();
    const ts = await import("../../packages/content-core/src/video-block.ts");
    const origins = [production, devOrigin, "https://example.com", `${devOrigin}.example.com`];
    const cases = origins.flatMap(origin => {
      const url = `${origin}/cms-media/video/fixture/${"a".repeat(64)}.mp4`;
      return [url, `${url}?download=1`, `${url}#fragment`, url.replace("https:", "http:"),
        url.replace("https://", "https://user:pass@"), url.replace("/cms-media/", ":444/cms-media/"),
        url.replace("/cms-media/video/", "/cms-media/other/"), url.replace(".mp4", ".jpg")];
    });
    const expected = origins.flatMap(origin => [origin === production || environment === "development" && origin === devOrigin,
      false, false, false, false, false, false, false]);
    expect(cases.map(url => ts.isPublicVideoUrl(url, "mp4"))).toEqual(expected);
    const cjs = spawnSync(process.execPath, ["-e", `
      const { isPublicVideoUrl } = require('./functions/lib/video-block.js');
      const cases = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
      process.stdout.write(JSON.stringify(cases.map(url => isPublicVideoUrl(url, 'mp4'))));
    `], { encoding: "utf8", input: JSON.stringify(cases), env: {
      ...(environment ? { CMS_DEPLOYMENT_ENVIRONMENT: environment } : {}),
      CMS_MEDIA_ORIGIN: devOrigin,
    } });
    expect(cjs.status, cjs.stderr).toBe(0);
    expect(JSON.parse(cjs.stdout)).toEqual(expected);
  });
});

it("selects the repository's dev media origin in the frozen publisher build", async () => {
  expect(Object.values(deploy.jobs).find(job => job.env?.CMS_MEDIA_ORIGIN).env.CMS_MEDIA_ORIGIN)
    .toBe("${{ vars.CMS_DEV_MEDIA_ORIGIN }}");
  expect(publication.env.CMS_DEPLOYMENT_ENVIRONMENT).toBe("development");
  const runner = readFileSync("site/scripts/cms-dev-publication.mjs", "utf8");
  expect(runner).toContain('CMS_DEPLOYMENT_ENVIRONMENT: "development", CMS_DEV_FROZEN_BUILD: "1"');
  vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", publication.env.CMS_DEPLOYMENT_ENVIRONMENT);
  vi.resetModules();
  const { CMS_MEDIA_ORIGIN } = await import("../../packages/content-core/src/media-origin.ts");
  expect(CMS_MEDIA_ORIGIN).toBe(devOrigin);
  const hosts = JSON.parse(readFileSync("functions/lib/public-asset-hosts.json", "utf8"));
  expect(hosts.development.media).toContain(new URL(devOrigin).hostname);
  expect(hosts.production.media).not.toContain(new URL(devOrigin).hostname);
});
