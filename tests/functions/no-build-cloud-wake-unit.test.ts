import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { publicationTarget } from "../../functions/lib/publication-target.js";
const { wakeNoBuildCloud: deliverWake } = createRequire(import.meta.url)("../../functions/no-build-cloud-wake.js");
const wakeNoBuildCloud = (options: any) => deliverWake({ getDeployment: () => ({ enabled: true, environment: "production" }), ...options });
const release = "a".repeat(40);
const token = "x".repeat(32);
afterEach(() => vi.restoreAllMocks());
const database = (projectId: string, control = { schemaVersion: 1, phase: "ready", commitSha: release, serializerId: "cloudflare-publisher" }) => ({
  projectId, doc: vi.fn(() => ({ get: vi.fn(async () => ({ data: () => control })) })),
});
it("does not read control, fetch credentials or send a wake when the packaged decision is inactive", async () => {
  const firestore = database("njpbs-site");
  const getToken = vi.fn();
  const fetchImpl = vi.fn();
  await deliverWake({ firestore, getToken, fetchImpl,
    getDeployment: () => ({ enabled: false, environment: "production" }) });
  expect(firestore.doc).not.toHaveBeenCalled();
  expect(getToken).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
});
it.each(["production", "development"])("delivers only the authenticated current %s target hint", async environment => {
  const target = publicationTarget(environment);
  const firestore = database(target.projectId, { schemaVersion: 1, phase: "ready", commitSha: release, serializerId: target.serializerId });
  const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
  await wakeNoBuildCloud({ firestore, environment, fetchImpl, getToken: () => token });
  expect(fetchImpl).toHaveBeenCalledOnce();
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(`${target.publisherOrigin}/wake`);
  expect(init).toMatchObject({ method: "POST", redirect: "error" });
  const headers = new Headers(init.headers);
  expect(headers.get("authorization")).toBe(`Bearer ${token}`);
  expect(headers.get("x-publication-release")).toBe(release);
  expect(headers.get("x-publication-target")).toBe(environment);
});
it("rejects a mixed database before reading a control or fetching credentials", async () => {
  const firestore = database("njpbs-site");
  const getToken = vi.fn();
  const fetchImpl = vi.fn();
  await expect(wakeNoBuildCloud({ firestore, environment: "development", getToken, fetchImpl })).rejects.toThrow();
  expect(firestore.doc).not.toHaveBeenCalled();
  expect(getToken).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
});
it.each(["noBuildPosts", "noBuildPostOwners", "contexts"])("delivers the current release after a %s write", async stateCollection => {
  const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
  await wakeNoBuildCloud({ firestore: database("njpbs-site"), environment: "production", stateCollection,
    fetchImpl, getToken: () => token });
  expect(fetchImpl).toHaveBeenCalledOnce();
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://publisher-health.njpbs.org/wake");
  expect(new Headers(init.headers).get("x-publication-release")).toBe(release);
});
it("does not read authority or send a wake for an unrelated deployment write", async () => {
  const firestore = database("njpbs-site");
  const fetchImpl = vi.fn();
  const getToken = vi.fn();
  await wakeNoBuildCloud({ firestore, environment: "production", stateCollection: "buildBatches", fetchImpl, getToken });
  expect(firestore.doc).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(getToken).not.toHaveBeenCalled();
});
it("keeps accepted work intact and logs only a fixed message after failed delivery", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const firestore = database("njpbs-site");
  await wakeNoBuildCloud({ firestore, environment: "production", getToken: () => token,
    fetchImpl: async () => { throw new Error(`private provider failure ${token}`); } });
  expect(warning).toHaveBeenCalledExactlyOnceWith("Cloud publication wake failed; minute recovery remains due");
});

it("reports a control read failure without logging provider output or fetching a credential", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const firestore = { projectId: "njpbs-site", doc: () => ({ get: async () => { throw new Error(`provider detail ${token}`); } }) };
  const getToken = vi.fn();
  const fetchImpl = vi.fn();
  await wakeNoBuildCloud({ firestore, environment: "production", getToken, fetchImpl });
  expect(warning).toHaveBeenCalledExactlyOnceWith("Cloud publication control read failed; minute recovery remains due");
  expect(getToken).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
});
