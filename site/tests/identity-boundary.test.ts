// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  EXECUTABLE_SOURCE_EXTENSION,
  MEMBER_GATE,
  STAFF_IDENTITY,
  identityBoundaryViolations,
  localImportTargets,
  stripComments,
  withoutExecutableExtension,
} from "../../.github/scripts/identity-boundary-guard.mjs";

const temporaryRoots: string[] = [];

function writeFixtureFile(root: string, relativePath: string, source: string): void {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, source, "utf8");
}

function fixtureRepository(
  overrides: Readonly<Record<string, string>> = {},
  extras: Readonly<Record<string, string>> = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "njpbs-identity-boundary-"));
  temporaryRoots.push(root);

  for (const owner of [...MEMBER_GATE, ...STAFF_IDENTITY]) {
    writeFixtureFile(root, owner, overrides[owner] ?? "export {};\n");
  }
  for (const [relativePath, source] of Object.entries(extras)) {
    writeFixtureFile(root, relativePath, source);
  }
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("two-identity-system boundary (ADR 0015, #210)", () => {
  it("keeps the current repository clean through the canonical guard", () => {
    expect(identityBoundaryViolations()).toEqual([]);
  });

  it("turns isolated Admin, Functions, CMS API, and member cross-imports red", () => {
    const fixtures = [
      {
        owner: "admin/src/lib/access.ts",
        source: 'import "../../../site/src/lib/pmsso-login.ts";\n',
        rule: "staff-imports-member-gate",
        target: "site/src/lib/pmsso-login",
      },
      {
        owner: "functions/lib/auth.js",
        source:
          'const entitlement = require("../../site/src/lib/mvault-entitlement.ts");\n',
        rule: "staff-imports-member-gate",
        target: "site/src/lib/mvault-entitlement",
      },
      {
        owner: "cms-api/src/firebase-auth.ts",
        source:
          'void import(`../../site/src/lib/member-gated-playback.ts`);\n',
        rule: "staff-imports-member-gate",
        target: "site/src/lib/member-gated-playback",
      },
      {
        owner: "site/src/lib/pmsso-login.ts",
        source:
          'export { requireAdmin } from "../../../functions/lib/auth.js";\n',
        rule: "member-imports-staff-identity",
        target: "functions/lib/auth",
      },
    ] as const;

    for (const fixture of fixtures) {
      const root = fixtureRepository({ [fixture.owner]: fixture.source });
      expect(identityBoundaryViolations(root)).toEqual([
        expect.objectContaining({
          rule: fixture.rule,
          owner: fixture.owner,
          target: fixture.target,
        }),
      ]);
    }
  });

  it("fails completeness when a new identity-named owner is unclassified", () => {
    const relativePath = "admin/src/principal/new-session.ts";
    const root = fixtureRepository({}, { [relativePath]: "export {};\n" });

    expect(identityBoundaryViolations(root)).toEqual([
      expect.objectContaining({
        rule: "identity-owner-unclassified",
        owner: relativePath,
      }),
    ]);
  });

  it("covers every supported import form and executable source extension", () => {
    const owner = "site/src/lib/pmsso-login.ts";
    const forms = [
      'import { requireAdmin } from "../../../functions/lib/auth.js";',
      'export { requireAdmin } from "../../../functions/lib/auth.js";',
      'import "../../../functions/lib/auth.js";',
      'void import("../../../functions/lib/auth.js");',
      'require("../../../functions/lib/auth.js");',
      "void import(`../../../functions/lib/auth.js`);",
      "require(`../../../functions/lib/auth.js`);",
      "void import(`../../../functions/lib/auth.js`, {});",
      "require(`../../../functions/lib/auth.js`, {});",
    ];
    for (const source of forms) {
      expect(localImportTargets(owner, source)).toContain("functions/lib/auth");
    }

    expect(
      localImportTargets(
        owner,
        "void import(`../../../functions/lib/${moduleName}.js`);",
      ),
    ).toEqual([]);
    expect(
      localImportTargets(
        owner,
        "require(`../../../functions/lib/${moduleName}.js`);",
      ),
    ).toEqual([]);

    const extensions = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"];
    for (const extension of extensions) {
      expect(
        localImportTargets(
          owner,
          `import "../../../functions/lib/rbac.${extension}";`,
        ),
      ).toEqual(["functions/lib/rbac"]);
    }

    expect(EXECUTABLE_SOURCE_EXTENSION.test("owner.cts")).toBe(true);
    expect(withoutExecutableExtension("functions/lib/rbac.mjs")).toBe(
      "functions/lib/rbac",
    );
  });

  it("ignores comments and unrelated bare packages", () => {
    const owner = "admin/src/lib/access.ts";
    const source = `
// import "../../../site/src/lib/pmsso-login.ts";
/* require("../../site/src/lib/mvault-entitlement.ts"); */
import "firebase/auth";
const url = "https://example.com/member-gated";
`;
    expect(localImportTargets(owner, source)).toEqual([]);
  });

  it("classifies the Functions staff role-provisioning owners", () => {
    for (const owner of [
      "functions/staff-access.js",
      "functions/deactivate-staff.js",
    ]) {
      expect(STAFF_IDENTITY).toContain(owner);
    }

    const root = fixtureRepository({
      "functions/staff-access.js":
        'const gate = require("../site/src/lib/mvault-entitlement.ts");\n',
    });
    expect(identityBoundaryViolations(root)).toEqual([
      expect.objectContaining({
        rule: "staff-imports-member-gate",
        owner: "functions/staff-access.js",
        target: "site/src/lib/mvault-entitlement",
      }),
    ]);
  });

  it("resolves escaped module specifiers by their cooked value", () => {
    const owner = "site/src/lib/pmsso-login.ts";
    const escapes = [
      'import "..\\u002f..\\u002f..\\u002ffunctions\\u002flib\\u002fauth.js";',
      'import "..\\/..\\/..\\/functions\\/lib\\/auth.js";',
      'import "..\\x2f..\\x2f..\\x2ffunctions\\x2flib\\x2fauth.js";',
      'import "..\\u{2f}..\\u{2f}..\\u{2f}functions\\u{2f}lib\\u{2f}auth.js";',
      'require("../../../functions/lib/\\u0061uth.js");',
      "void import(`../../../functions/lib/\\u0061uth.js`);",
    ];
    for (const source of escapes) {
      expect(localImportTargets(owner, source), source).toContain(
        "functions/lib/auth",
      );
    }

    const root = fixtureRepository({
      "site/src/lib/pmsso-login.ts":
        'import "..\\u002f..\\u002f..\\u002ffunctions\\u002flib\\u002fauth.js";\n',
    });
    expect(identityBoundaryViolations(root)).toEqual([
      expect.objectContaining({
        rule: "member-imports-staff-identity",
        owner: "site/src/lib/pmsso-login.ts",
        target: "functions/lib/auth",
      }),
    ]);
  });

  it("keeps comment stripping out of string and template literals", () => {
    const owner = "site/src/lib/pmsso-login.ts";

    const globString = [
      'const media = "image/*";',
      'import "../../../functions/lib/auth.js";',
      'const closer = "*/";',
    ].join("\n");
    expect(localImportTargets(owner, globString)).toEqual([
      "functions/lib/auth",
    ]);

    const templateGlob = [
      "const media = `image/*`;",
      'import "../../../functions/lib/rbac.js";',
      "const closer = `*/`;",
    ].join("\n");
    expect(localImportTargets(owner, templateGlob)).toEqual([
      "functions/lib/rbac",
    ]);

    const doubleSlash = [
      'const separator = "a//b";',
      'import "../../../functions/roles.js";',
    ].join("\n");
    expect(localImportTargets(owner, doubleSlash)).toEqual(["functions/roles"]);

    // An apostrophe inside a comment must not open a string state that hides the
    // next real import.
    const apostrophe = [
      '// don\'t require("../../../functions/lib/principal.js") here',
      'import "../../../functions/lib/principal.js";',
    ].join("\n");
    expect(localImportTargets(owner, apostrophe)).toEqual([
      "functions/lib/principal",
    ]);

    // A quote inside a regular expression literal must not desynchronize the
    // scanner either.
    const regexLiteral = [
      'const quoted = /["\']/g;',
      'import "../../../functions/lib/auth.js";',
    ].join("\n");
    expect(localImportTargets(owner, regexLiteral)).toEqual([
      "functions/lib/auth",
    ]);

    expect(stripComments('const media = "image/*"; /* gone */')).toContain(
      '"image/*"',
    );
    expect(stripComments("/* gone */ const kept = 1;")).not.toContain("gone");
  });
});
