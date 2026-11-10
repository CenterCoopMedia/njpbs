import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { PUBLIC_PAGE_IDS } from "../../packages/content-core/src/public-pages";
import {
  createSavedPreviewOperation,
  PreviewOperationError,
  type PreviewJob,
  type PreviewTarget,
} from "../src/lib/saved-preview-operation";

const queueId = "abcdefghijklmnopqrst";
const target: PreviewTarget = { collection: "cmsPages", documentId: "contact", sourceVersion: 7 };
function job(receipt: PreviewTarget = target): PreviewJob {
  return { ...receipt, queueId, rendererSha: "a".repeat(40), status: "ready",
    pagePath: "/contact/", previewUrl: `https://preview.njpbs.org/p/${queueId}/` };
}
const protocol = (reason: unknown) => reason instanceof PreviewOperationError && reason.code === "protocol";

describe("saved preview receipt contract", () => {
  it("rejects a route substituted during addressed polling", async () => {
    const operation = createSavedPreviewOperation({
      ensureSaved: async () => target,
      request: async () => ({ ...job(), status: "pending" }),
      read: async () => ({ ...job(), pagePath: "/about/" }),
    });
    await assert.rejects(operation.run(), protocol);
  });

  for (const pagePath of ["", "contact/", undefined]) {
    it(`requires the initial pending receipt to carry its route: ${String(pagePath)}`, async () => {
      let reads = 0;
      const operation = createSavedPreviewOperation({
        ensureSaved: async () => target,
        request: async () => ({ ...job(), status: "pending", pagePath } as PreviewJob),
        read: async () => { reads++; return job(); },
      });
      await assert.rejects(operation.run(), protocol);
      assert.equal(reads, 0);
    });
  }

  for (const documentId of ["not-a-page", "programLanding", "genericPage", "page-abc", `page-${"A".repeat(32)}`]) {
    it(`rejects an unregistered Page identity before dispatch: ${documentId}`, async () => {
      let requests = 0;
      const operation = createSavedPreviewOperation({
        ensureSaved: async () => ({ ...target, documentId }),
        request: async receipt => { requests++; return job(receipt); },
        read: async () => job(),
      });
      await assert.rejects(operation.run(), protocol);
      assert.equal(requests, 0);
    });
  }

  for (const documentId of [...PUBLIC_PAGE_IDS, `page-${"a".repeat(32)}`]) {
    it(`accepts a registered or server-minted Page identity: ${documentId}`, async () => {
      const receipt: PreviewTarget = { ...target, documentId };
      const operation = createSavedPreviewOperation({
        ensureSaved: async () => receipt,
        request: async saved => job(saved),
        read: async () => job(receipt),
      });
      assert.equal((await operation.run()).status, "ready");
    });
  }

  it("retains the independent Post document-ID contract", async () => {
    const receipt: PreviewTarget = { collection: "cmsPosts", documentId: "not-a-page", sourceVersion: 7 };
    const operation = createSavedPreviewOperation({
      ensureSaved: async () => receipt,
      request: async saved => ({ ...job(saved), pagePath: "/posts/story/" }),
      read: async () => job(receipt),
    });
    assert.equal((await operation.run()).status, "ready");
  });
});
