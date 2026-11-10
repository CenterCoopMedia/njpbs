import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createSavedPreviewOperation, PreviewOperationError } from "../src/lib/saved-preview-operation";

describe("acknowledged preview target identity", () => {
  for (const documentId of ["_invalid", "-invalid", "with/slash", "with.dot", "", "a".repeat(129)]) {
    it(`refuses an invalid document ID before dispatch: ${JSON.stringify(documentId)}`, async () => {
      let requests = 0;
      const operation = createSavedPreviewOperation({
        ensureSaved: async () => ({ collection: "cmsPosts", documentId, sourceVersion: 1 }),
        request: async () => { requests++; throw new Error("Must not dispatch an invalid identity"); },
        read: async () => { throw new Error("Must not read an invalid identity"); },
      });
      await assert.rejects(operation.run(), error =>
        error instanceof PreviewOperationError && error.code === "protocol");
      assert.equal(requests, 0);
    });
  }
});
