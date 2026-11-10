import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relativePath) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

describe("repository Node runtime contract", () => {
  it("keeps the standalone Functions lock in step with its manifest", () => {
    // Cloud Build installs from functions/ instead of the repository workspace.
    // A root lock update cannot satisfy that clean install.
    const functionsPackageJson = JSON.parse(
      read("../../functions/package.json"),
    );
    const functionsPackageLock = JSON.parse(
      read("../../functions/package-lock.json"),
    );
    const lockedRoot = functionsPackageLock.packages?.[""];

    expect(lockedRoot?.dependencies).toEqual(
      functionsPackageJson.dependencies,
    );
    expect(lockedRoot?.devDependencies).toEqual(
      functionsPackageJson.devDependencies,
    );
    expect(lockedRoot?.engines).toEqual(functionsPackageJson.engines);
  });
});
