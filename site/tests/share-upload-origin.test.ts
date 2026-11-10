// @vitest-environment node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveShareUploadOrigin } from "../../packages/content-core/src/share-upload-origin";

const origin = "https://uploads.example.test";
describe("share upload origin configuration", () => {
  it("accepts an explicitly configured exact HTTPS origin", () => {
    expect(resolveShareUploadOrigin(origin, true)).toBe(origin);
  });
  it.each([undefined, "", "https://uploads.example.org"])("rejects missing/template configuration for an enabled form (%s)", value => {
    expect(() => resolveShareUploadOrigin(value, true)).toThrow("PUBLIC_SHARE_UPLOAD_ORIGIN");
  });
  it.each(["http://uploads.example.test", "https://uploads.example.test/", "https://uploads.example.test/path",
    "https://uploads.example.test?query=1", "https://uploads.example.test#fragment",
    "https://fixture-user:fixture-password@uploads.example.test", "not a URL"])("rejects a non-origin setting (%s)", value => {
    expect(() => resolveShareUploadOrigin(value, true)).toThrow("PUBLIC_SHARE_UPLOAD_ORIGIN");
  });
  it("allows an unconfigured disabled feature", () => {
    expect(resolveShareUploadOrigin(undefined, false)).toBe("https://uploads.example.org");
  });
  it("reads the configured origin in a real Node consumer without Vite env", () => {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)), "--eval",
      'import { SHARE_UPLOAD_ORIGIN } from "../packages/content-core/src/share-upload-origin.ts"; if (SHARE_UPLOAD_ORIGIN !== process.env.PUBLIC_SHARE_UPLOAD_ORIGIN) process.exit(1);',
    ], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 5_000,
      env: { PATH: process.env.PATH, PUBLIC_SHARE_UPLOAD_ORIGIN: origin } });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
});
