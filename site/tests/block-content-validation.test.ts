import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { PageBlock } from "../../packages/content-core/src/content-model";
import { blockContentError } from "../../packages/content-core/src/block-content-validation";
const require = createRequire(import.meta.url);
const server = require("../../functions/lib/block-content-validation.js");

describe.each([blockContentError, server.blockContentError])("draft and publication block checks", check => {
  it("saves missing content but requires it for publication", () => {
    const blocks: PageBlock[] = [{ id: "a", type: "headline", order: 0, visible: true, data: { text: "" } }];
    expect(check(blocks, { complete: false })).toBeNull();
    expect(check(blocks)).toMatch(/required/);
    expect(check([{ ...blocks[0], visible: false }])).toBeNull();
  });
  it("keeps unsafe links out of drafts, including nested items", () => {
    const ctas = [{ label: "", href: "javascript:alert(1)" }];
    const blocks: PageBlock[] = [{ id: "a", type: "cta_row", order: 0, visible: true,
      data: { ctas } }];
    expect(check(blocks, { complete: false })).toMatch(/http/);
    ctas[0].href = "";
    expect(check(blocks, { complete: false })).toBeNull();
    expect(check(blocks)).toMatch(/required/);
  });
});
