// @vitest-environment node
import { expect, it, vi } from "vitest";
import { bindPreviewPairCodeTransport } from "../scripts/cms-preview-pair-code-transport";
it("keeps production unchanged and requires development's existing Access pair", () => {
  const createTransport = vi.fn();
  expect(bindPreviewPairCodeTransport({ createTransport, deploymentEnvironment: "production", publicationAccess: { clientId: "", clientSecret: "" } })).toBe(createTransport);
  expect(() => bindPreviewPairCodeTransport({ createTransport, deploymentEnvironment: "development", publicationAccess: { clientId: "", clientSecret: "" } })).toThrow("Access credentials");
});
it("adds Access only to the fixed private development source and preserves the edge secret", async () => {
  let transportRequest!: typeof fetch;
  const createTransport = vi.fn((options: any) => { transportRequest = options.request; return {} as any; });
  const request = vi.fn<typeof fetch>(async () => Response.json({}));
  const factory = bindPreviewPairCodeTransport({ createTransport, deploymentEnvironment: "development",
    publicationAccess: { clientId: "synthetic-id", clientSecret: "synthetic-secret" }, request });
  factory({} as any);
  await transportRequest("https://dev-api.example.org/_internal/record-code", { redirect: "error", headers: { "x-njpbs-cms-edge": "synthetic-edge" } });
  expect(Object.fromEntries(new Headers(request.mock.calls[0][1]?.headers))).toMatchObject({
    "cf-access-client-id": "synthetic-id", "cf-access-client-secret": "synthetic-secret", "x-njpbs-cms-edge": "synthetic-edge" });
  await expect(transportRequest("https://unrelated.example/_internal/record-code", { redirect: "error" })).rejects.toThrow("target differs");
  await expect(transportRequest("https://dev-api.example.org/_internal/record-code", { redirect: "follow" })).rejects.toThrow("target differs");
  expect(request).toHaveBeenCalledOnce();
});
