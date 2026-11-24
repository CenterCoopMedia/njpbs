import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { devSettlementGithub, JSON_LIMIT } from "../../scripts/lib/dev-settlement-github.mjs";

beforeEach(() => {
  vi.stubEnv("CANONICAL_GITHUB_REPOSITORY", "CenterCoopMedia/njpbs");
  vi.stubEnv("CANONICAL_GITHUB_REPOSITORY_ID", "1");
});
afterEach(() => vi.unstubAllEnvs());

it("reads JSON from the fixed repository on api.github.com with the token and no redirect", async () => {
  const request = vi.fn().mockResolvedValue(new Response('{"id":1001}'));
  expect(await devSettlementGithub("synthetic-token", request)("actions/runs/1001")).toEqual({ id: 1001 });
  expect(request.mock.calls[0][0]).toBe("https://api.github.com/repos/CenterCoopMedia/njpbs/actions/runs/1001");
  expect(request.mock.calls[0][1]).toMatchObject({ redirect: "manual",
    headers: { Authorization: "Bearer synthetic-token", Accept: "application/vnd.github+json" } });
});
it.each([302, 404, 500])("refuses a %s response", async status => {
  const request = vi.fn().mockResolvedValue(new Response(null, { status, headers: { location: "https://example.test/" } }));
  await expect(devSettlementGithub("synthetic-token", request)("actions/runs/1001")).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});
it("keeps the API JSON cap at 256 KiB and names the size and the cap", async () => {
  const body = "x".repeat(JSON_LIMIT + 1), read = headers =>
    devSettlementGithub("synthetic-token", vi.fn().mockResolvedValue(new Response(body, { headers })))("actions/runs/1001").catch(e => e);
  expect(JSON_LIMIT).toBe(256 * 1024);
  const sized = await read({ "content-length": String(body.length) });
  expect(sized.refusalDetail).toEqual({ reason: "github_response_too_large", kind: "api", bytes: JSON_LIMIT + 1, capBytes: JSON_LIMIT });
  expect(sized.message).toBe(`GitHub api response is ${JSON_LIMIT + 1} bytes; cap is ${JSON_LIMIT}`);
  expect((await read()).refusalDetail.bytes).toBe(`>${JSON_LIMIT}`);
});
