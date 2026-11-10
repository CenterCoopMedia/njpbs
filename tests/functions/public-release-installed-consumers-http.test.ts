import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { createCmsGetPublicPageHandler } = require("../../functions/public-content.js");
const { withCmsEdge } = require("../../functions/lib/cms-edge.js");
afterEach(() => vi.unstubAllEnvs());
function response() {
  return { statusCode: 0, body: null as any, headers: {} as Record<string, string>, headersSent: false,
    set(name: string, value: string) { this.headers[name.toLowerCase()] = value; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.body = value; this.headersSent = true; return this; },
    send(value: string) { this.body = JSON.parse(value); this.headersSent = true; return this; } };
}
function handler() {
  const projection = vi.fn(() => { throw new Error("Probe must not read content"); });
  const firestore = new Proxy({}, { get() { throw new Error("Probe must not access Firestore"); } });
  const log = { error: vi.fn(), warn: vi.fn() };
  return { projection, run: withCmsEdge(createCmsGetPublicPageHandler({ firestore, readProjectionFn: projection, log }),
    { readSecret: () => "fixture-edge-only", logger: log }) };
}
it("keeps deployment source evidence behind the existing edge authentication", async () => {
  const { projection, run } = handler(), res = response();
  await run({ method: "POST", headers: {}, body: { mode: "release-installed-consumers-v2", nonce: "a".repeat(64) } }, res);
  expect(res.statusCode).toBe(403); expect(projection).not.toHaveBeenCalled();
  expect(res.headers["cache-control"]).toBe("private, no-store");
  expect(res.body).toEqual({ error: "CMS API edge is required" });
});
it("answers the exact private probe without touching content, SDK state or caller-supplied paths", async () => {
  vi.stubEnv("PUBLIC_RELEASE_READERS_ENABLED", "true");
  vi.stubEnv("PUBLIC_RELEASE_COMPOSED_READERS_ENABLED", "true");
  vi.stubEnv("K_REVISION", "cmsgetpublicpage-00042-abc");
  const { projection, run } = handler(), res = response(), nonce = "b".repeat(64);
  const request = { method: "POST", headers: { "x-njpbs-cms-edge": "fixture-edge-only" },
    body: { mode: "release-installed-consumers-v2", nonce } };
  await run(request, res);
  expect(res.statusCode).toBe(200); expect(projection).not.toHaveBeenCalled();
  expect(res.body).toMatchObject({ schemaVersion: 2, kind: "public-release-installed-consumers", nonce,
    revision: "cmsgetpublicpage-00042-abc" });
  expect(res.headers["cache-control"]).toBe("private, no-store");
  const refused = response();
  await run({ ...request, body: { ...request.body, paths: ["../.env"] } }, refused);
  expect(refused.statusCode).toBe(503);
  expect(refused.body).toEqual({ error: "Public content is unavailable" });
  expect(projection).not.toHaveBeenCalled();
});
it("preserves the default-disabled reader gate for the private probe", async () => {
  vi.stubEnv("PUBLIC_RELEASE_READERS_ENABLED", "false");
  const { projection, run } = handler(), res = response();
  await run({ method: "POST", headers: { "x-njpbs-cms-edge": "fixture-edge-only" },
    body: { mode: "release-installed-consumers-v2", nonce: "c".repeat(64) } }, res);
  expect(res.statusCode).toBe(503); expect(projection).not.toHaveBeenCalled();
  expect(res.body).toEqual({ error: "Public content is unavailable" });
});
