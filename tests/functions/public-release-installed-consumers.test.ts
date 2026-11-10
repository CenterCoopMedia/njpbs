import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { build } from "esbuild";
import consumers from "../../functions/lib/public-release-installed-consumers.js";
import protocol from "../../functions/lib/public-release-pair.js";
const nonce = "a".repeat(64);
const environment = { K_REVISION: "cmsgetpublicpage-00012-abc",
  PUBLIC_RELEASE_READERS_ENABLED: "true", PUBLIC_RELEASE_COMPOSED_READERS_ENABLED: "true" };
const encode = (value: string) => new TextEncoder().encode(value);
it("returns only static source hashes, explicit flag states and the public revision with a fresh nonce", () => {
  const readPaths: string[] = [], readEnvironment: string[] = [];
  const observed = consumers.installedPublicReleaseConsumers({ nonce,
    environment: new Proxy(environment, { get(target, key) {
      readEnvironment.push(String(key));
      if (!(key in target)) throw new Error("Unexpected environment access");
      return target[key as keyof typeof target];
    } }), read: (path: string) => { readPaths.push(path); return encode(`committed source ${path}`); } });
  const expected = consumers.INSTALLED_CONSUMER_FILES.map((path: string) => ({ path,
    sha256: createHash("sha256").update(encode(`committed source ${path}`)).digest("hex") }));
  expect(observed).toEqual({ schemaVersion: 2, kind: "public-release-installed-consumers", nonce,
    revision: environment.K_REVISION, files: expected, sourceDigest: protocol.publicReleaseDigest(expected),
    flags: { PUBLIC_RELEASE_READERS_ENABLED: true, PUBLIC_RELEASE_COMPOSED_READERS_ENABLED: true } });
  expect(readPaths).toEqual(consumers.INSTALLED_CONSUMER_FILES);
  expect(new Set(readEnvironment)).toEqual(new Set(Object.keys(environment)));
});
it("fingerprints the actual fixed repository source roster", () => {
  const files = consumers.installedConsumerSourceFiles();
  expect(files.map((file: any) => file.path)).toEqual(consumers.INSTALLED_CONSUMER_FILES);
  expect(files.every((file: any) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
});
it.each([undefined, "false", "TRUE"])("is disabled before reading any source when the sealed switch is %s", enabled => {
  expect(() => consumers.installedPublicReleaseConsumers({ nonce,
    environment: { ...environment, PUBLIC_RELEASE_READERS_ENABLED: enabled },
    read: () => { throw new Error("Disabled probe read source"); } })).toThrow("The public release protocol record is invalid");
});
it.each(["", "../revision", "A".repeat(64)])("refuses an absent or malformed public revision %s", revision => {
  expect(() => consumers.installedPublicReleaseConsumers({ nonce, environment: { ...environment, K_REVISION: revision } })).toThrow();
});
it("refuses malformed nonces and source byte overflow", () => {
  expect(() => consumers.installedPublicReleaseConsumers({ nonce: "caller", environment })).toThrow();
  expect(() => consumers.installedConsumerSourceFiles(() => new Uint8Array())).toThrow();
  expect(() => consumers.installedConsumerSourceFiles(() => new Uint8Array(2 * 1024 * 1024 + 1))).toThrow();
  expect(() => consumers.installedConsumerSourceFiles(() => new Uint8Array(2 * 1024 * 1024))).toThrow();
});

it("declares every fingerprinted file to the real static deployment graph without executing its handlers", async () => {
  const result = await build({ entryPoints: ["functions/lib/public-release-installed-consumers.js"], bundle: true,
    write: false, metafile: true, platform: "node", packages: "external", treeShaking: false, logLevel: "silent" });
  const paths = new Set(Object.keys(result.metafile!.inputs));
  for (const path of consumers.INSTALLED_CONSUMER_FILES) expect(paths.has(`functions/${path}`), path).toBe(true);
});
