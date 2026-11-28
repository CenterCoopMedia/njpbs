// Pins the CommonJS principal resolver in functions/lib/principal.js to this
// browser copy. Both turn a stored user document into the principal an access
// check runs against, and the functions bundle cannot import TypeScript, so the
// rule exists twice. Without this test the server could start reading a user
// document differently from the app that shows the controls.

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { principalFromUserDoc, type CmsUserDoc } from "../src/lib/principal";

const require = createRequire(import.meta.url);
const { principalFromUserDoc: serverPrincipalFromUserDoc } = require(
  "../../functions/lib/principal.js",
);

const DOCUMENTS: Array<{ name: string; doc: unknown }> = [
  { name: "no document", doc: null },
  { name: "empty document", doc: {} },
  ...["viewer", "contributor", "editor", "publisher", "admin", "owner"].map((accessTier) => ({
    name: `${accessTier} tier`, doc: { accessTier },
  })),
  { name: "active owner", doc: { active: true, accessTier: "owner" } },
  { name: "inactive owner", doc: { active: false, accessTier: "owner" } },
  { name: "malformed active", doc: { active: "yes", accessTier: "owner" } },
  { name: "unknown tier", doc: { accessTier: "super_admin" } },
  { name: "non-string tier", doc: { accessTier: 7 } },
  { name: "stored role only", doc: { role: "super_admin" } },
  { name: "stored grants only", doc: { grants: [{ role: "editor" }] } },
  { name: "tier beside stored role", doc: { accessTier: "viewer", role: "super_admin" } },
];

describe("principal resolution parity", () => {
  it("agrees on every document shape, with and without the activation receipt", () => {
    for (const tiersActive of [true, false]) {
      for (const { name, doc } of DOCUMENTS) {
        expect(
          serverPrincipalFromUserDoc("u1", doc, tiersActive),
          `${name} (receipt ${tiersActive})`,
        ).toEqual(principalFromUserDoc("u1", doc as CmsUserDoc, tiersActive));
      }
    }
  });
});
