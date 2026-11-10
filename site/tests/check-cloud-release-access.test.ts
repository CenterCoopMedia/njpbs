// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkCloudReleaseAccess, main } from "../scripts/check-cloud-release-access";

const TOKEN = "fake-release-access-token-3440";
afterEach(() => vi.unstubAllEnvs());
const PREFIX = "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef";
// Independently enumerated from the activation contract (#3440).
const ENDPOINTS = [
  "/workers/scripts",
  "/builds/workers/dddddddddddddddddddddddddddddddd/triggers",
  "/workers/scripts/njpbs-production/subdomain",
  "/workers/scripts/njpbs-production/deployments",
];

function boundary(statuses = [200, 200, 200, 200]) {
  const responses = statuses.map(status => new Response(`PRIVATE ${TOKEN}`, { status }));
  const jsonReaders = responses.map(response => vi.spyOn(response, "json"));
  const textReaders = responses.map(response => vi.spyOn(response, "text"));
  const cancellations = responses.map(response => vi.spyOn(response.body!, "cancel"));
  const fetchImpl = vi.fn<typeof fetch>();
  responses.forEach(response => fetchImpl.mockResolvedValueOnce(response));
  const write = vi.fn();
  return { responses, jsonReaders, textReaders, cancellations, fetchImpl, write };
}

describe("cloud release access precheck", () => {
  it.each(["", "REPLACE_ME", "d".repeat(31), `${"d".repeat(32)}\n`])("refuses an unconfigured worker pin before provider access (%#)", async tag => {
    vi.stubEnv("CLOUDFLARE_PUBLIC_WORKER_TAG", tag);
    const fixture = boundary();
    expect(await checkCloudReleaseAccess({ cloudflareApiToken: TOKEN, ...fixture })).toBe(1);
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
    expect(fixture.write).toHaveBeenCalledWith(expect.stringContaining("CLOUDFLARE_PUBLIC_WORKER_TAG must be configured"));
    expect(fixture.write.mock.calls.flat().join("")).not.toContain(TOKEN);
  });
  it("makes exactly the four authenticated GETs, cancels bodies and prints only endpoint/status", async () => {
    const fixture = boundary();
    expect(await checkCloudReleaseAccess({ cloudflareApiToken: TOKEN, ...fixture })).toBe(0);
    expect(fixture.fetchImpl.mock.calls.map(([url]) => url)).toEqual(ENDPOINTS.map(endpoint => PREFIX + endpoint));
    for (const [, init] of fixture.fetchImpl.mock.calls) {
      expect(init).toEqual({ method: "GET", headers: { Accept: "application/json", Authorization: `Bearer ${TOKEN}` },
        redirect: "error", signal: expect.any(AbortSignal) });
    }
    expect(fixture.write.mock.calls).toEqual(ENDPOINTS.map(endpoint => [`${endpoint} HTTP 200\n`]));
    for (const reader of [...fixture.jsonReaders, ...fixture.textReaders]) expect(reader).not.toHaveBeenCalled();
    for (const cancel of fixture.cancellations) expect(cancel).toHaveBeenCalledOnce();
    expect(fixture.write.mock.calls.flat().join("")).not.toMatch(/PRIVATE|fake-release-access-token|Bearer/);
  });

  it.each([0, 1, 2, 3])("fails on a 403 at endpoint %s, including the triggers read, and still checks the rest", async index => {
    const statuses = [200, 200, 200, 200]; statuses[index] = 403;
    const fixture = boundary(statuses);
    expect(await checkCloudReleaseAccess({ cloudflareApiToken: TOKEN, ...fixture })).toBe(1);
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(4);
    expect(fixture.write.mock.calls).toEqual(ENDPOINTS.map((endpoint, i) => [`${endpoint} HTTP ${statuses[i]}\n`]));
    expect(fixture.write.mock.calls.flat().join("")).not.toContain(TOKEN);
  });

  it("suppresses credential-bearing network errors and continues with the remaining endpoints", async () => {
    const fixture = boundary();
    fixture.fetchImpl.mockReset().mockRejectedValueOnce(new Error(`Bearer ${TOKEN} PRIVATE`));
    fixture.responses.slice(1).forEach(response => fixture.fetchImpl.mockResolvedValueOnce(response));
    expect(await checkCloudReleaseAccess({ cloudflareApiToken: TOKEN, ...fixture })).toBe(1);
    expect(fixture.write.mock.calls).toEqual(ENDPOINTS.map((endpoint, i) => [`${endpoint} HTTP ${i === 0 ? 0 : 200}\n`]));
  });

  it("reads and removes the environment token before fetching; missing or malformed tokens make no requests", async () => {
    const environment = { CLOUDFLARE_API_TOKEN: TOKEN };
    const fixture = boundary();
    expect(await main(environment, fixture.fetchImpl, fixture.write)).toBe(0);
    expect(environment).toEqual({});
    for (const value of [undefined, "", "bad\ncredential"]) {
      const fetchImpl = vi.fn<typeof fetch>(); const write = vi.fn();
      expect(await main({ CLOUDFLARE_API_TOKEN: value }, fetchImpl, write)).toBe(1);
      expect(fetchImpl).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    }
  });
});
