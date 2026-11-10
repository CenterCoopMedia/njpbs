// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { privatePreviewSandbox } from "../scripts/process-cms-preview";
const site = process.cwd();
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(file) : /\.(?:ts|mjs|sh|astro)$/.test(file) && !file.includes(".test.") ? [file] : [];
  });
}

it("requires the shared offline signal on every sandbox builder entry point", () => {
  const builders = [...sources(path.join(site, "scripts")), ...sources(path.join(site, "../scripts"))]
    .filter(file => /bwrap|--unshare-(?:all|net)|privatePreviewSandbox\(/.test(readFileSync(file, "utf8")));
  expect(builders.length).toBeGreaterThanOrEqual(4);
  for (const file of builders) {
    const source = readFileSync(file, "utf8");
    if (file.endsWith("cms-preview-operator-checks.ts")) {
      expect(source).toContain('"/usr/bin/true"');
      expect(source).not.toMatch(/build-with-production-sync|astro build/);
      continue;
    }
    expect(source, path.relative(site, file)).toMatch(/CMS_OFFLINE_BUILD\s*:\s*"1"|CMS_OFFLINE_BUILD\s*=\s*"1"/);
  }
  const background = readFileSync(path.join(site, "scripts/frozen-publication.ts"), "utf8");
  expect(background).toContain('environment.CMS_OFFLINE_BUILD = "1"');
  expect(background).toContain('environment.PUBLIC_ARTIFACT_RETAINED_IMAGES_PATH =');
  const parity = readFileSync(path.join(site, "scripts/check-public-page-renderer.ts"), "utf8");
  const parityBuilds = parity.split("execFileSync(").slice(1)
    .filter(invocation => invocation.includes('"astro.public-page-fixtures.config.mjs"'));
  expect(parityBuilds).toHaveLength(2);
  for (const invocation of parityBuilds) expect(invocation).toContain('CMS_OFFLINE_BUILD: "1"');
  const config = readFileSync(path.join(site, "astro.config.mjs"), "utf8");
  expect(config).toContain('process.env.CMS_OFFLINE_BUILD === "1"');
  expect(config).toContain('offlineBuild && !retainedImagesReady ? []');
  const build = readFileSync(path.join(site, "scripts/build-with-production-sync.mjs"), "utf8");
  const install = build.indexOf('await installRetainedPublicImages(');
  const ready = build.indexOf('environment.set("CMS_RETAINED_IMAGES_READY", "1")');
  const astro = build.indexOf('await build(');
  expect(install).toBeGreaterThanOrEqual(0);
  expect(ready).toBeGreaterThan(install);
  expect(astro).toBeGreaterThan(ready);
});

it("refuses a new sandbox caller that omits the shared offline signal before reading or writing files", async () => {
  await expect(privatePreviewSandbox({}, "/unused/dist")).rejects.toThrow("Offline build signal is missing");
});

it("routes every public Astro image optimizer through the same adapters observed by the input freeze", () => {
  const images = sources(path.join(site, "src")).filter(file => /from ["']astro:assets["']/.test(readFileSync(file, "utf8")));
  expect(images.length).toBeGreaterThan(0);
  for (const file of images) {
    const source = readFileSync(file, "utf8");
    expect(source, path.relative(site, file)).not.toMatch(/\bgetImage\s*\(/);
    expect(source, path.relative(site, file)).toMatch(/resolveCmsResponsiveAssets|resolveCmsResponsiveImage|newsletterSignupResolution/);
  }
  const freeze = readFileSync(path.join(site, "scripts/retained-public-images.ts"), "utf8");
  for (const adapter of ["resolveCmsResponsiveAssets", "resolveCmsResponsiveImage", "newsletterSignupResolution"]) {
    expect(freeze).toContain(`await ${adapter}(`);
  }
});
