// Pins the CommonJS mirror in functions/lib/rbac.js to the canonical capability
// core. The functions bundle cannot import the TypeScript module, so the write
// path runs a hand-written copy; without this test the two could fork silently
// and the deployed authorization would stop matching the model the rest of the
// app reasons about.
//
// The decision cases are generated rather than listed, so a capability added to
// ALL_CAPABILITIES is exercised against every role, scope, and resource shape
// without anyone remembering to extend a table.

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  ALL_CAPABILITIES,
  ROLE_CAPABILITIES,
  can as canTs,
  canEditContent as canEditContentTs,
  capabilitiesForRole as capabilitiesForRoleTs,
  hasCapability as hasCapabilityTs,
  withRegisteredMediaSections as restrictTs,
  type Capability,
  type Principal,
  type Resource,
  type Role,
} from "../../packages/content-core/src/rbac";

const require = createRequire(import.meta.url);
const {
  ALL_CAPABILITIES: cjsAllCapabilities,
  ROLE_CAPABILITIES: cjsRoleCapabilities,
  can: canCjs,
  canEditContent: canEditContentCjs,
  capabilitiesForRole: capabilitiesForRoleCjs,
  hasCapability: hasCapabilityCjs,
  withRegisteredMediaSections: restrictCjs,
} = require("../../functions/lib/rbac.js");

const ROLES: Role[] = ["super_admin", "admin", "editor", "contributor", "staff"];

// Grant shapes worth deciding against: the intentional site-wide grant (sections
// omitted), a real scoped grant, and the malformed values a migrated user
// document can carry. The malformed ones matter most -- they are where a mirror
// is most likely to fork, because each one has to deny rather than widen.
const GRANT_SHAPES: Array<{ name: string; sections?: unknown }> = [
  { name: "unscoped" },
  { name: "scoped to news", sections: ["news"] },
  { name: "scoped to another desk", sections: ["arts"] },
  { name: "scoped to no desks", sections: [] },
  { name: "sections null", sections: null },
  { name: "sections not an array", sections: "news" },
];

const RESOURCES: Array<{ name: string; resource?: Resource }> = [
  { name: "no resource" },
  { name: "owned, in scope", resource: { ownerId: "user-1", section: "news" } },
  { name: "owned, out of scope", resource: { ownerId: "user-1", section: "arts" } },
  { name: "owned, no section", resource: { ownerId: "user-1" } },
  { name: "someone else's", resource: { ownerId: "user-2", section: "news" } },
  { name: "unowned, in scope", resource: { section: "news" } },
  { name: "empty resource", resource: {} },
  { name: "own unassigned draft", resource: { ownerId: "user-1", unassignedDraft: true } },
  { name: "another owner's unassigned draft", resource: { ownerId: "user-2", unassignedDraft: true } },
  { name: "assigned record with draft marker", resource: { ownerId: "user-1", section: "arts", unassignedDraft: true } },
];

const PRINCIPAL_IDS: Array<string | undefined> = ["user-1", undefined];

function principal(role: Role, sections: unknown, id: string | undefined): Principal {
  const grant = sections === undefined ? { role } : { role, sections };
  // The malformed shapes are deliberately off-type: a stored user document is not
  // type-checked, and denying them is the behavior under test.
  return { id, grants: [grant as Principal["grants"][number]] };
}

describe("capability tables", () => {
  it("mirrors ALL_CAPABILITIES in the same order", () => {
    expect(cjsAllCapabilities).toEqual([...ALL_CAPABILITIES]);
  });

  it("mirrors every role's capability set", () => {
    expect(Object.keys(cjsRoleCapabilities).sort()).toEqual(
      Object.keys(ROLE_CAPABILITIES).sort(),
    );
    for (const role of ROLES) {
      expect(cjsRoleCapabilities[role]).toEqual([...ROLE_CAPABILITIES[role]]);
      expect(capabilitiesForRoleCjs(role)).toEqual([
        ...capabilitiesForRoleTs(role),
      ]);
    }
  });

  it("denies an unknown or prototype-shadowing role in both", () => {
    for (const role of ["", "editor ", "constructor", "toString", "__proto__"]) {
      expect(capabilitiesForRoleCjs(role)).toEqual([
        ...capabilitiesForRoleTs(role as Role),
      ]);
      expect(capabilitiesForRoleCjs(role)).toEqual([]);
    }
  });
});

describe("decision parity", () => {
  it("requires registry resolution for scoped media in both copies", () => {
    const stored = principal("editor", ["news"], "user-1");
    for (const [allows, holds, resolve] of [
      [canTs, hasCapabilityTs, restrictTs],
      [canCjs, hasCapabilityCjs, restrictCjs],
    ] as const) {
      expect(allows(stored, "media.upload")).toBe(false);
      expect(holds(stored, "media.upload")).toBe(false);
      const resolved = resolve(stored, new Set(["news"]));
      expect(allows(resolved, "media.upload", { section: "general" })).toBe(true);
      expect(holds(resolved, "media.upload")).toBe(true);
    }
  });

  it("agrees after resolving registered, retired, mixed and malformed scopes", () => {
    for (const role of ROLES) {
      for (const sections of [["current-area"], ["retired-area"], ["retired-area", "current-area"], [], null, "current-area"]) {
        const stored = principal(role, sections, "user-1");
        for (const registered of [new Set<string>(), new Set(["current-area"])]) {
          const server = restrictCjs(stored, registered);
          const client = restrictTs(stored, registered);
          expect(server).toEqual(client);
          for (const capability of ALL_CAPABILITIES) {
            expect(hasCapabilityCjs(server, capability)).toBe(hasCapabilityTs(client, capability));
            for (const target of RESOURCES) {
              expect(canCjs(server, capability, target.resource)).toBe(canTs(client, capability, target.resource));
            }
          }
        }
      }
    }
  });

  it("agrees on every role, grant shape, capability, and resource", () => {
    let cases = 0;
    for (const role of ROLES) {
      for (const shape of GRANT_SHAPES) {
        for (const id of PRINCIPAL_IDS) {
          const actor = principal(role, shape.sections, id);
          for (const capability of ALL_CAPABILITIES as readonly Capability[]) {
            expect(
              hasCapabilityCjs(actor, capability),
              `hasCapability ${role} ${shape.name} ${capability}`,
            ).toBe(hasCapabilityTs(actor, capability));

            for (const target of RESOURCES) {
              const label = `${role} / ${shape.name} / id=${id ?? "none"} / ${capability} / ${target.name}`;
              expect(canCjs(actor, capability, target.resource), label).toBe(
                canTs(actor, capability, target.resource),
              );
              cases += 1;
            }
          }
        }
      }
    }
    // Guards the loop itself: a bad generator that produced no cases would
    // otherwise report a passing parity test.
    expect(cases).toBe(
      ROLES.length *
        GRANT_SHAPES.length *
        PRINCIPAL_IDS.length *
        ALL_CAPABILITIES.length *
        RESOURCES.length,
    );
  });

  it("agrees on canEditContent for every role, grant shape, and resource", () => {
    for (const role of ROLES) {
      for (const shape of GRANT_SHAPES) {
        for (const id of PRINCIPAL_IDS) {
          const actor = principal(role, shape.sections, id);
          for (const target of RESOURCES) {
            const resource = target.resource ?? {};
            expect(
              canEditContentCjs(actor, resource),
              `canEditContent ${role} / ${shape.name} / id=${id ?? "none"} / ${target.name}`,
            ).toBe(canEditContentTs(actor, resource));
          }
        }
      }
    }
  });

  it("agrees on multi-grant principals, where one grant can authorize alone", () => {
    const multi: Principal = {
      id: "user-1",
      grants: [
        { role: "contributor", sections: ["arts"] },
        { role: "editor", sections: ["news"] },
      ],
    };
    for (const capability of ALL_CAPABILITIES as readonly Capability[]) {
      for (const target of RESOURCES) {
        expect(
          canCjs(multi, capability, target.resource),
          `${capability} / ${target.name}`,
        ).toBe(canTs(multi, capability, target.resource));
      }
    }
  });

  it("agrees on a principal with no grants at all", () => {
    for (const actor of [{ grants: [] }, {} as Principal]) {
      for (const capability of ALL_CAPABILITIES as readonly Capability[]) {
        expect(canCjs(actor, capability, { section: "news" })).toBe(
          canTs(actor as Principal, capability, { section: "news" }),
        );
        expect(canCjs(actor, capability, { section: "news" })).toBe(false);
      }
    }
  });
});
