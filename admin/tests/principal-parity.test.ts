// Pins the CommonJS principal resolver in functions/lib/principal.js to this
// browser copy. Both turn a stored user document into the principal an access
// check runs against, and the functions bundle cannot import TypeScript, so the
// rule exists twice. Without this test the server could start reading a user
// document differently from the app that shows the controls, which is how an
// editor ends up looking at a save button that returns 403.
//
// One divergence is deliberate and asserted below: the server copy drops every
// grant from a deactivated account.

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { principalFromUserDoc, type CmsUserDoc } from "../src/lib/principal";

const require = createRequire(import.meta.url);
const { principalFromUserDoc: serverPrincipalFromUserDoc } = require(
  "../../functions/lib/principal.js",
);

// The document shapes worth agreeing on: the tiers, both scope intents, and the
// malformed values a migrated document can carry, where a disagreement would
// widen authority rather than narrow it.
const DOCUMENTS: Array<{ name: string; doc: unknown }> = [
  { name: "no document", doc: null },
  { name: "empty document", doc: {} },
  { name: "super admin", doc: { role: "super_admin" } },
  { name: "admin", doc: { role: "admin" } },
  { name: "role field holding a grant role", doc: { role: "editor" } },
  { name: "site-wide editor", doc: { grants: [{ role: "editor" }] } },
  { name: "desk editor", doc: { grants: [{ role: "editor", sections: ["news"] }] } },
  {
    name: "admin who is also a desk editor",
    doc: { role: "admin", grants: [{ role: "editor", sections: ["news"] }] },
  },
  { name: "scoped to no desks", doc: { grants: [{ role: "editor", sections: [] }] } },
  { name: "sections null", doc: { grants: [{ role: "editor", sections: null }] } },
  { name: "sections a string", doc: { grants: [{ role: "editor", sections: "news" }] } },
  {
    name: "sections holding non-strings",
    doc: { grants: [{ role: "editor", sections: ["news", 7, null] }] },
  },
  { name: "grants not an array", doc: { grants: "editor" } },
  { name: "malformed grant entries", doc: { grants: [null, "editor", [], { role: 7 }] } },
  { name: "unknown grant role", doc: { grants: [{ role: "publisher" }] } },
  { name: "admin misplaced in grants", doc: { grants: [{ role: "admin" }] } },
  {
    name: "super admin misplaced in grants",
    doc: { grants: [{ role: "super_admin" }] },
  },
  { name: "active account", doc: { active: true, role: "admin" } },
];

describe("principal resolution parity", () => {
  it("agrees on every document shape an active account can have", () => {
    for (const { name, doc } of DOCUMENTS) {
      expect(
        serverPrincipalFromUserDoc("u1", doc),
        name,
      ).toEqual(principalFromUserDoc("u1", doc as CmsUserDoc));
    }
  });

  it("diverges only on a deactivated account, which the server refuses", () => {
    const deactivated = {
      active: false,
      role: "super_admin",
      grants: [{ role: "editor" }],
    };
    expect(serverPrincipalFromUserDoc("u1", deactivated)).toEqual({
      id: "u1",
      grants: [],
    });
    // The browser copy gates UI for the signed-in user and does not read
    // `active`, so it still reports the grants. The server is what decides.
    expect(
      principalFromUserDoc("u1", deactivated as CmsUserDoc).grants.length,
    ).toBeGreaterThan(0);
  });
});
