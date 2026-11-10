import { describe, expect, it, vi } from "vitest";
import { deployBatch, requestDeploymentInventory } from "../../scripts/deploy-cms-function-batches.mjs";
import { readFunctionsDeployInventory } from "../../scripts/lib/functions-deploy-inventory.mjs";

const functionsUrl = "https://cloudfunctions.googleapis.com/v2/projects/njpbs-site/locations/-/functions";
const providerError = status => Object.assign(new Error("private provider diagnostic"), {
  ...(status === undefined ? { code: "ECONNRESET" } : { response: { status, data: { private: "provider body" } } }),
  config: { headers: { authorization: "synthetic credential" } },
});

describe("CMS function inventory request retries", () => {
  it.each([429, 500, 503, 599, undefined])("recovers a transient HTTP %s or network failure", async status => {
    const client = { request: vi.fn().mockRejectedValueOnce(providerError(status)).mockResolvedValueOnce({ data: { functions: [] } }) };
    const wait = vi.fn().mockResolvedValue();
    await expect(requestDeploymentInventory(client, functionsUrl, "next", wait)).resolves.toEqual({ functions: [] });
    expect(client.request.mock.calls).toEqual(Array.from({ length: 2 }, () => [{
      url: functionsUrl, method: "GET", params: { pageSize: 100, pageToken: "next" }, retry: false,
    }]));
    expect(wait.mock.calls).toEqual([[1000]]);
  });

  it.each([429, 503, undefined])("fails closed after three attempts without exposing HTTP %s error contents", async status => {
    const client = { request: vi.fn().mockRejectedValue(providerError(status)) };
    const wait = vi.fn().mockResolvedValue();
    const error = await requestDeploymentInventory(client, functionsUrl, undefined, wait).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(`Could not verify deployed function inventory (${status === undefined ? "code ECONNRESET" : `HTTP ${status}`}, attempt 3 of 3)`);
    expect(error.cause).toBeUndefined();
    expect(client.request).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[1000], [2000]]);
  });

  it.each([400, 401, 403, 404, 409])("refuses HTTP %s immediately", async status => {
    const client = { request: vi.fn().mockRejectedValue(providerError(status)) };
    const wait = vi.fn().mockResolvedValue();
    await expect(requestDeploymentInventory(client, functionsUrl, undefined, wait)).rejects.toThrow(
      `Could not verify deployed function inventory (HTTP ${status}, attempt 1 of 3)`);
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("retries the failed page without losing earlier inventory or its page token", async () => {
    const name = "projects/njpbs-site/locations/us-central1/functions/health";
    const client = { request: vi.fn()
      .mockResolvedValueOnce({ data: { functions: [{ name }], nextPageToken: "next" } })
      .mockRejectedValueOnce(providerError(429))
      .mockRejectedValueOnce(providerError(503))
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: {} }) };
    const wait = vi.fn().mockResolvedValue();
    const functions = await readFunctionsDeployInventory("njpbs-site", (url, token) => requestDeploymentInventory(client, url, token, wait));
    expect(functions).toMatchObject([{ name, platform: "gcfv1" }]);
    expect(client.request.mock.calls.map(([options]) => [new URL(options.url).pathname.split("/")[1], options.params.pageToken]))
      .toEqual([["v1", undefined], ["v1", "next"], ["v1", "next"], ["v1", "next"], ["v2", undefined]]);
    expect(wait.mock.calls).toEqual([[1000], [2000]]);
  });

  it("never launches a forced deployment after inventory retries fail", async () => {
    const client = { request: vi.fn().mockRejectedValue(providerError(503)) };
    const launch = vi.fn();
    await expect(deployBatch(["health"], launch, "njpbs-site", {
      manifest: [{ name: "health", region: "us-central1", platform: "gcfv2" }],
      request: (url, token) => requestDeploymentInventory(client, url, token, async () => {}),
    })).rejects.toThrow("HTTP 503, attempt 3 of 3");
    expect(launch).not.toHaveBeenCalled();
    expect(client.request).toHaveBeenCalledTimes(3);
  });

  it("bounds read-only Scheduler retries with the same policy", async () => {
    const client = { request: vi.fn().mockRejectedValue(providerError(503)) };
    const wait = vi.fn().mockResolvedValue();
    await expect(requestDeploymentInventory(client, "https://cloudscheduler.googleapis.com/v1/projects/njpbs-site/locations/us-central1/jobs", undefined, wait))
      .rejects.toThrow("HTTP 503, attempt 3 of 3");
    expect(client.request).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[1000], [2000]]);
  });

  it.each(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNABORTED", 0, 999])(
    "retains only the allowlisted error code %s", async code => {
      const client = { request: vi.fn().mockRejectedValue(Object.assign(providerError(), { code })) };
      const error = await requestDeploymentInventory(client, functionsUrl, undefined, async () => {}).catch(error => error);
      expect(error.message).toBe(`Could not verify deployed function inventory (code ${code}, attempt 3 of 3)`);
      expect(error.cause).toBeUndefined();
    });

  it.each(["private provider diagnostic", "https://private.invalid/credential", -1, 1000, 1.5, {}])(
    "discards unknown or malformed provider codes (%j)", async code => {
      const client = { request: vi.fn().mockRejectedValue(Object.assign(providerError(), { code })) };
      const error = await requestDeploymentInventory(client, functionsUrl, undefined, async () => {}).catch(error => error);
      expect(error.message).toBe("Could not verify deployed function inventory (HTTP unavailable, attempt 3 of 3)");
      expect(error.cause).toBeUndefined();
    });

  it("prefers a validated HTTP status to an allowlisted code", async () => {
    const client = { request: vi.fn().mockRejectedValue(Object.assign(providerError(403), { code: "ECONNRESET" })) };
    await expect(requestDeploymentInventory(client, functionsUrl, undefined, async () => {}))
      .rejects.toThrow("HTTP 403, attempt 1 of 3");
  });
});
