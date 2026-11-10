// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CMS_DEPLOY_COMPATIBILITY_MANIFEST,
  validateCmsDeployCompatibility,
} from "../../.github/scripts/cms-deploy-compatibility.mjs";

const currentManifest = readFileSync(
  new URL("../../.github/cms-deploy-compatibility.json", import.meta.url),
  "utf8",
);
const currentRules = readFileSync(
  new URL("../../firestore.rules", import.meta.url),
  "utf8",
);
const tempRoots: string[] = [];

function fixtureTree({
  manifest = currentManifest,
  rules = currentRules,
}: {
  manifest?: string | null;
  rules?: string;
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), "njpbs-cms-compatibility-"));
  tempRoots.push(root);
  mkdirSync(join(root, ".github"));
  if (manifest !== null) {
    writeFileSync(join(root, CMS_DEPLOY_COMPATIBILITY_MANIFEST), manifest);
  }
  writeFileSync(join(root, "firestore.rules"), rules);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("CMS deploy compatibility floor", () => {
  it("accepts the current addressed lease and release contract", () => {
    expect(validateCmsDeployCompatibility(fixtureTree())).toMatchObject({
      manifestSchemaVersion: 1,
      editorLockContractVersion: 9,
    });
  });

  it("rejects a historical tree without the compatibility marker", () => {
    expect(() =>
      validateCmsDeployCompatibility(fixtureTree({ manifest: null })),
    ).toThrow(/is missing or invalid/);
  });

  it("rejects a marker below the editor-lock schema floor", () => {
    const manifest = JSON.parse(currentManifest) as {
      contracts: { cmsEditorLocks: { version: number } };
    };
    // Version 5 rules cannot grant/release leases after editorial grants become accessTier.
    manifest.contracts.cmsEditorLocks.version = 5;
    expect(() =>
      validateCmsDeployCompatibility(
        fixtureTree({ manifest: JSON.stringify(manifest) }),
      ),
    ).toThrow(/predates required floor 6/);
  });

  it("rejects a contract version unknown to the trusted workflow", () => {
    const manifest = JSON.parse(currentManifest) as {
      contracts: { cmsEditorLocks: { version: number } };
    };
    manifest.contracts.cmsEditorLocks.version = 10;
    expect(() =>
      validateCmsDeployCompatibility(
        fixtureTree({ manifest: JSON.stringify(manifest) }),
      ),
    ).toThrow(/not supported by this trusted workflow revision/);
  });

  it("rejects rules that drop addressed release compatibility", () => {
    const incompatibleRules = currentRules.replace(
      "validEditorLockReleaseData(lockId) &&",
      "false &&",
    );
    expect(incompatibleRules).not.toBe(currentRules);
    expect(() =>
      validateCmsDeployCompatibility(fixtureTree({ rules: incompatibleRules })),
    ).toThrow(/does not satisfy the declared cmsEditorLocks lease and release contract/);
  });

  it("rejects a change only to the session-age helper", () => {
    const incompatibleRules = currentRules.replace(
      "return 60 * 24 * 60 * 60;",
      "return 0;",
    );
    expect(incompatibleRules).not.toBe(currentRules);
    expect(() =>
      validateCmsDeployCompatibility(fixtureTree({ rules: incompatibleRules })),
    ).toThrow(/does not satisfy the declared cmsEditorLocks lease and release contract/);
  });

  it("accepts the historical v8 contract without a session-age helper", () => {
    // Reconstruct the pre-age-policy rules, retaining the published v8 digest.
    const rules = currentRules
      .replace(/    function maxSessionAgeSeconds\(\) \{[^}]+\}\n/, "")
      .replace(
        "request.auth.token.auth_time > profile.get('tokensValidAfter', 0) &&\n" +
          "        request.auth.token.auth_time * 1000 > request.time.toMillis() - maxSessionAgeSeconds() * 1000;",
        "request.auth.token.auth_time > profile.get('tokensValidAfter', 0);",
      );
    expect(rules).not.toContain("maxSessionAgeSeconds(");
    const manifest = JSON.parse(currentManifest);
    manifest.contracts.cmsEditorLocks = {
      version: 8,
      firestoreRulesSha256: "3f61d2c305a0ede8f9af79df3efe764484b9e5b7d073619c839de3116f8113ed",
    };
    expect(validateCmsDeployCompatibility(fixtureTree({
      rules, manifest: JSON.stringify(manifest),
    }))).toMatchObject({ editorLockContractVersion: 8 });
  });

  it("rejects rules that cannot answer a read of a lease that does not exist", () => {
    // The exact regression: an absent-lease read denied by resource.data made presence fail
    // open on every record and no lease was ever claimed (#1047).
    const regressedRules = currentRules.replace(
      "? canObserveAbsentEditorLock(lockId)",
      "? false",
    );
    expect(regressedRules).not.toBe(currentRules);
    expect(() =>
      validateCmsDeployCompatibility(fixtureTree({ rules: regressedRules })),
    ).toThrow(/does not satisfy the declared cmsEditorLocks lease and release contract/);
  });

  it("allows forward changes outside the editor-lock rules contract", () => {
    const forwardRules = `${currentRules}\n// Unrelated forward-revert receipt.\n`;
    expect(validateCmsDeployCompatibility(fixtureTree({ rules: forwardRules }))).toMatchObject(
      { editorLockContractVersion: 9 },
    );
  });
});
