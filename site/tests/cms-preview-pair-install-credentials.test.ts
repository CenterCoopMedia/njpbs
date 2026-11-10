import { expect, it } from "vitest";
import { parsePreviewPairInstallAccount, assertPreviewPairUploadSecrets } from "../scripts/cms-preview-pair-install-credentials";
const raw = (project: string, email: string) => JSON.stringify({ type: "service_account", project_id: project, client_email: email, private_key: "x".repeat(64) });
const storage = JSON.stringify({ accessKeyId: "a".repeat(32), secretAccessKey: "b".repeat(64) });
it.each(["njpbs-site", "njpbs-site-dev"] as const)("pins the exact approved %s preview identity", project => {
  const name = project === "njpbs-site" ? "cms-preview-renderer" : "cms-dev-preview-renderer", email = `${name}@${project}.iam.gserviceaccount.com`;
  expect(parsePreviewPairInstallAccount(raw(project, email), project).clientEmail).toBe(email);
  expect(() => parsePreviewPairInstallAccount(raw(project, `broad-deployer@${project}.iam.gserviceaccount.com`), project)).toThrow("service identity refused");
});
it.each(["storage", "edge", "access"])("rejects malformed %s before an upload grant can be requested", field => {
  expect(() => assertPreviewPairUploadSecrets({ rawStorage: field === "storage" ? "malformed" : storage,
    edgeSecret: field === "edge" ? "short" : "e".repeat(32),
    developmentAccess: { clientId: field === "access" ? "bad\nheader" : "synthetic-id", clientSecret: "synthetic-secret" } })).toThrow();
});
it("accepts valid production streams without development descriptors", () => {
  expect(() => assertPreviewPairUploadSecrets({ rawStorage: storage, edgeSecret: "e".repeat(32) })).not.toThrow();
});
