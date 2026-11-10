// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readPublicContext: vi.fn(), close: vi.fn(), select: vi.fn(), write: vi.fn(),
}));
vi.mock("../../scripts/update-publish-status.cjs", () => ({ default: { initFirebase: () => ({}) } }));
vi.mock("../../functions/lib/pages-public-artifact.js", () => ({ default: { selectActivePublicBuildBatch: mocks.select } }));
vi.mock("../scripts/cms-preview-cloud-storage.ts", () => ({ createCmsPreviewCloudStorage: () => mocks }));
vi.mock("../src/lib/public-artifact-bundle.ts", () => ({ writePublicArtifactBundle: mocks.write }));
import { preparePagesPublicContext } from "../scripts/prepare-pages-public-context";

afterEach(() => { vi.resetAllMocks(); delete process.env.CMS_PREVIEW_R2_CREDENTIAL; });
const commitSha = "a".repeat(40);
const buildBatchId = "cms-11111111111111111111";

function fixture() {
  process.env.CMS_PREVIEW_R2_CREDENTIAL = JSON.stringify({ accessKeyId: "a".repeat(20), secretAccessKey: "b".repeat(40) });
  const publication = { buildBatchId, commitSha, generation: 1 };
  mocks.readPublicContext.mockResolvedValue({ publicContext: { frozen: true }, publication });
  mocks.select.mockResolvedValue(publication);
  return publication;
}

it("writes only the frozen content verified against the active publication and selected batch", async () => {
  fixture();
  await preparePagesPublicContext(commitSha, buildBatchId, "/tmp/pages-context.json");
  expect(mocks.write).toHaveBeenCalledWith("/tmp/pages-context.json", { frozen: true });
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(process.env.CMS_PREVIEW_R2_CREDENTIAL).toBeUndefined();
});

it.each(["buildBatchId", "commitSha", "generation"])("refuses publication %s drift", async field => {
  const publication = fixture();
  mocks.readPublicContext.mockResolvedValue({ publicContext: {}, publication: { ...publication, [field]: "other" } });
  await expect(preparePagesPublicContext(commitSha, buildBatchId, "/tmp/pages-context.json")).rejects.toThrow(/does not match/);
  expect(mocks.write).not.toHaveBeenCalled();
  expect(mocks.close).toHaveBeenCalledOnce();
});

it("refuses a selected batch that changed after the frozen context read", async () => {
  const publication = fixture();
  mocks.select.mockResolvedValue({ ...publication, buildBatchId: "cms-22222222222222222222" });
  await expect(preparePagesPublicContext(commitSha, buildBatchId, "/tmp/pages-context.json")).rejects.toThrow(/does not match/);
  expect(mocks.write).not.toHaveBeenCalled();
});

it("closes storage and writes nothing if retained content is unavailable", async () => {
  fixture();
  mocks.readPublicContext.mockRejectedValue(new Error("missing retained content"));
  await expect(preparePagesPublicContext(commitSha, buildBatchId, "/tmp/pages-context.json")).rejects.toThrow(/missing/);
  expect(mocks.write).not.toHaveBeenCalled();
  expect(mocks.close).toHaveBeenCalledOnce();
});
