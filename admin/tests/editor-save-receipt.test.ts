import { describe, expect, it } from "vitest";
import { editorSaveReceipt } from "../src/lib/editor-save-receipt";

describe("acknowledged editor receipt", () => {
  it("copies only the known identity and freezes the receipt", () => {
    const receipt = editorSaveReceipt("cmsPages", "home", 8);
    expect(receipt).toEqual({ collection: "cmsPages", documentId: "home", sourceVersion: 8 });
    expect(Object.isFrozen(receipt)).toBe(true);
  });
  it("accepts server-minted Pages through the shared registry", () => {
    expect(editorSaveReceipt("cmsPages", `page-${"a".repeat(32)}`, 8)?.sourceVersion).toBe(8);
  });
  it("keeps the independent Post identity contract", () => {
    expect(editorSaveReceipt("cmsPosts", "post-1", 8)?.documentId).toBe("post-1");
    expect(editorSaveReceipt("cmsPages", "post-1", 8)).toBeUndefined();
  });
  it.each([undefined, null, 0, -1, 1.5, "8", NaN, Number.MAX_SAFE_INTEGER + 1])("does not manufacture a valid receipt from version %s", version => {
    expect(editorSaveReceipt("cmsPages", "home", version)).toBeUndefined();
  });
  it.each([undefined, "", "_post", "a/b", "a".repeat(129)])("does not manufacture a valid Post identity from %s", id => {
    expect(editorSaveReceipt("cmsPosts", id, 8)).toBeUndefined();
  });
});
