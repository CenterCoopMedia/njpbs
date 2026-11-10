import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const account = (projectId = "njpbs-site", name = "publisher") => JSON.stringify({
  type: "service_account", project_id: projectId,
  client_email: `${name}@${projectId}.iam.gserviceaccount.com`,
  private_key: privateKey.export({ format: "pem", type: "pkcs8" }),
});
const credential = account();
const now = Date.parse("2026-10-17T00:00:00Z");
const json = (body: unknown) => Response.json(body);
const token = (expires_in: unknown = 3600) => json({ access_token: "synthetic-token", token_type: "Bearer", expires_in });

beforeEach(() => { vi.resetModules(); vi.spyOn(Date, "now").mockReturnValue(now); });
afterEach(() => vi.restoreAllMocks());

// These measure OAuth requests only. Every caller still makes its fresh
// Firestore authority reads; no public decision or private response is cached.
describe("Google datastore access token reuse", () => {
  it("reduces 60 same-credential token requests to one", async () => {
    const { accessToken } = await import("./pending-work");
    const request = vi.fn<typeof fetch>(async () => token());
    for (let i = 0; i < 60; i++) expect(await accessToken(credential, request)).toBe("synthetic-token");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("lets preview mint independently when another caller's token request is stuck", async () => {
    const { accessToken } = await import("./pending-work");
    const { hasPendingPreviewWork } = await import("../preview-renderer/pending-work");
    let finishFirst!: (response: Response) => void;
    const firstRequest = vi.fn<typeof fetch>(() => new Promise(resolve => { finishFirst = resolve; }));
    const first = accessToken(credential, firstRequest);
    await vi.waitFor(() => expect(firstRequest).toHaveBeenCalledTimes(1));
    const request = vi.fn<typeof fetch>(async url => String(url) === "https://oauth2.googleapis.com/token" ? token()
      : json({ fields: { schemaVersion: { integerValue: "1" }, phase: { stringValue: "starting" },
        rendererSha: { stringValue: "a".repeat(40) }, serializerId: { stringValue: "cloud-preview" } } }));
    try {
      expect(await hasPendingPreviewWork({ account: credential, rendererSha: "a".repeat(40), serializerId: "cloud-preview" }, request)).toBe(true);
      // Separate requests retain their own deadline and complete independently.
      expect(request).toHaveBeenCalledTimes(2);
    } finally { finishFirst(token()); await first; }
    const warmRequest = vi.fn<typeof fetch>();
    expect(await accessToken(credential, warmRequest)).toBe("synthetic-token");
    expect(warmRequest).not.toHaveBeenCalled();
  });

  it("keeps all 60 preview runtime reads fresh while saving 59 OAuth requests", async () => {
    const { hasPendingPreviewWork } = await import("../preview-renderer/pending-work");
    const request = vi.fn<typeof fetch>(async url => String(url) === "https://oauth2.googleapis.com/token" ? token()
      : json({ fields: { schemaVersion: { integerValue: "1" }, phase: { stringValue: "starting" },
        rendererSha: { stringValue: "a".repeat(40) }, serializerId: { stringValue: "cloud-preview" } } }));
    for (let i = 0; i < 60; i++) {
      expect(await hasPendingPreviewWork({ account: credential, rendererSha: "a".repeat(40), serializerId: "cloud-preview" },
        (url, init) => request(url, init))).toBe(true);
    }
    expect(request.mock.calls.filter(([url]) => String(url).includes("firestore.googleapis.com"))).toHaveLength(60);
    expect(request.mock.calls.filter(([url]) => String(url) === "https://oauth2.googleapis.com/token")).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(61);
  });

  it("refreshes at the 60-second safety margin and never serves stale after a failed refresh", async () => {
    const { accessToken } = await import("./pending-work");
    const request = vi.fn<typeof fetch>().mockImplementation(async () => token());
    await accessToken(credential, request);
    vi.mocked(Date.now).mockReturnValue(now + 3_539_000);
    await accessToken(credential, request);
    expect(request).toHaveBeenCalledTimes(1);
    vi.mocked(Date.now).mockReturnValue(now + 3_540_000);
    request.mockRejectedValueOnce(new Error("synthetic network failure"));
    await expect(accessToken(credential, request)).rejects.toThrow("synthetic network failure");
    await accessToken(credential, request);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, null, 0, -1, "3600", 1.5, 60])("does not retain a token without a usable lifetime (%s)", async lifetime => {
    const { accessToken } = await import("./pending-work");
    const request = vi.fn<typeof fetch>(async () => json({ access_token: "synthetic-token", token_type: "Bearer", expires_in: lifetime }));
    await accessToken(credential, request);
    await accessToken(credential, request);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("uses the server's shorter lifetime from the start of minting", async () => {
    const { accessToken } = await import("./pending-work");
    const request = vi.fn<typeof fetch>(async () => { vi.mocked(Date.now).mockReturnValue(now + 10_000); return token(120); });
    await accessToken(credential, request);
    vi.mocked(Date.now).mockReturnValue(now + 59_999);
    await accessToken(credential, request);
    expect(request).toHaveBeenCalledTimes(1);
    vi.mocked(Date.now).mockReturnValue(now + 60_000);
    await accessToken(credential, request);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("separates changed credentials and projects and bounds retained identities", async () => {
    const { accessToken } = await import("./pending-work");
    const request = vi.fn<typeof fetch>(async () => token());
    await accessToken(credential, request);
    await accessToken(account("njpbs-site-dev"), request, "njpbs-site-dev");
    for (let i = 0; i < 8; i++) await accessToken(account("njpbs-site", `rotated-${i}`), request);
    await accessToken(credential, request);
    expect(request).toHaveBeenCalledTimes(11);
    await expect(accessToken(credential, request, "njpbs-site-dev")).rejects.toThrow("credential is invalid");
    expect(request).toHaveBeenCalledTimes(11);
  });

  it("does not retain a failed or malformed token reply", async () => {
    const { accessToken } = await import("./pending-work");
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(json({ access_token: "", token_type: "Bearer", expires_in: 3600 }))
      .mockImplementation(async () => token());
    await expect(accessToken(credential, request)).rejects.toThrow();
    await expect(accessToken(credential, request)).rejects.toThrow();
    await accessToken(credential, request);
    await accessToken(credential, request);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("refreshes after a backward clock adjustment", async () => {
    const { accessToken } = await import("./pending-work");
    const request = vi.fn<typeof fetch>(async () => token());
    await accessToken(credential, request);
    vi.mocked(Date.now).mockReturnValue(now - 1);
    await accessToken(credential, request);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("preserves preview credential validation even when another caller warmed the cache", async () => {
    const { accessToken } = await import("./pending-work");
    const { hasPendingPreviewWork } = await import("../preview-renderer/pending-work");
    const malformed = JSON.stringify({ ...JSON.parse(account("njpbs-site-dev")), client_email: "synthetic@example.invalid" });
    const request = vi.fn<typeof fetch>(async () => token());
    await accessToken(malformed, request, "njpbs-site-dev");
    await expect(hasPendingPreviewWork({ account: malformed, rendererSha: "a".repeat(40), serializerId: "cloud-preview",
      projectId: "njpbs-site-dev", deploymentEnvironment: "development" }, request)).rejects.toThrow("credential is invalid");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
