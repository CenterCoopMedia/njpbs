// Pins the editorial status vocabulary used by functions/save.js to the canonical
// list in the content core. The functions bundle is uploaded as its own CommonJS
// source and cannot import the TypeScript module, so its dependency-free status
// module carries a hand-written copy, exactly like the block model and the
// capability core. Those two already have parity tests; this one was the gap
// (#538). The same five
// statuses are mirrored a third time in functions/lib/content-library.js, which
// cmsAssignContent and the library filters read; that copy is pinned separately
// in tests/preflight/content-library-contract.test.js. A new status has to land
// in both mirrors.
//
// What forking would cost: the set is the save boundary's status allowlist, so a
// status added to the core and not here is refused at the endpoint with "Unknown
// status", and one removed from the core but left here stays writable after the
// rest of the app has stopped modelling it. Nothing else catches the added-status
// direction at all. Existing save tests send draft, scheduled, and published and
// expect 200, so dropping one of those three also fails there; in_review and
// archived have only this pin.

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { CONTENT_STATUSES } from "../../packages/content-core/src/content-model";

const require = createRequire(import.meta.url);
const { CONTENT_STATUSES: cjsContentStatuses } = require(
  "../../functions/lib/content-statuses.js",
);

describe("content status parity", () => {
  it("carries exactly the canonical statuses, no more and no fewer", () => {
    expect([...cjsContentStatuses].sort()).toEqual([...CONTENT_STATUSES].sort());
    for (const status of CONTENT_STATUSES) {
      expect(cjsContentStatuses.has(status), status).toBe(true);
    }
  });

  it("rejects a status the core does not name", () => {
    for (const status of [
      "publish",
      "Published",
      "unpublished",
      "review",
      "",
      "constructor",
      "__proto__",
      "toString",
    ]) {
      expect(cjsContentStatuses.has(status), status).toBe(false);
    }
  });
});
