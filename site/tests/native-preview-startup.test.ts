// @vitest-environment node
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("loads the cloud preview entry with native Node and no runtime credentials", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--experimental-strip-types", "--input-type=module", "--eval",
    'const entry = await import("./site/scripts/run-cms-preview-cloud.ts"); console.log(typeof entry.runCmsPreviewCloud);',
  ], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production",
      // Site CI installs only Site dependencies; CommonJS Functions imports
      // use the same dependency search path as the existing Site test harness.
      NODE_PATH: fileURLToPath(new URL("../node_modules", import.meta.url)),
    },
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  expect(stdout.trim()).toBe("function");
});

it("loads the native render entry and requires frozen input before rendering", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--experimental-strip-types", "--input-type=module", "--eval",
    `await import("./site/scripts/render-compiled-preview.ts").catch(error => {
      if (error.message !== "Compiled preview requires frozen input") throw error;
      console.log("input-required");
    });`,
  ], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production" },
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  expect(stdout.trim()).toBe("input-required");
});
