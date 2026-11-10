// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import config from "../astro.config.mjs";

const directories: string[] = [];
const productionHeaders = await readFile(new URL("../public/_headers", import.meta.url), "utf8");
const paths = ["/_home-sources.json", "/_publication.json"];
type BuildIntegration = {
  name: string;
  hooks: { "astro:build:done"?: (options: { dir: URL }) => Promise<void> };
};

async function emittedHeaders(environment: string | undefined) {
  vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", environment);
  const directory = await mkdtemp(join(tmpdir(), "njpbs-home-cors-"));
  directories.push(directory);
  const headersPath = join(directory, "_headers");
  await writeFile(headersPath, productionHeaders);
  const integration = (config.integrations as BuildIntegration[]).find((item) => item.name === "njpbs-public-auxiliary-routes");
  expect(integration).toBeDefined();
  await integration?.hooks["astro:build:done"]?.({ dir: pathToFileURL(`${directory}/`) });
  return readFile(headersPath, "utf8");
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Home source receipt CORS", () => {
  it("allows only dev Admin on the two dev receipt paths", async () => {
    const emitted = await emittedHeaders("development");
    let expected = productionHeaders;
    for (const path of paths) {
      expected = expected.replace(
        `${path}\n  Access-Control-Allow-Origin: https://admin.njpbs.org`,
        `${path}\n  Access-Control-Allow-Origin: https://dev-admin.example.org\n  Access-Control-Allow-Credentials: true`,
      );
      expect(emitted).toContain(`${path}\n  Access-Control-Allow-Origin: https://dev-admin.example.org\n  Access-Control-Allow-Credentials: true\n`);
    }
    expect(emitted).toBe(expected);
    expect(await readFile(new URL("../public/_headers", import.meta.url), "utf8")).toBe(productionHeaders);
  });

  it.each([undefined, "production"])("preserves production headers for environment %s", async (environment) => {
    const emitted = await emittedHeaders(environment);
    expect(emitted).toBe(productionHeaders);
    for (const path of paths) {
      expect(emitted).toContain(`${path}\n  Access-Control-Allow-Origin: https://admin.njpbs.org\n`);
    }
    expect(emitted).not.toContain("https://dev-admin.example.org");
    expect(emitted).not.toContain("Access-Control-Allow-Credentials");
  });
});
