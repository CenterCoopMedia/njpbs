import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import inventoryModule from "../../functions/lib/pbs/secret-inventory.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FUNCTIONS_SOURCE = join(ROOT, "functions");
const SITE_SOURCE = join(ROOT, "site/src");
const { PBS_SECRET_INVENTORY } = inventoryModule;

function sourceFilesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(path);
    return /\.(?:astro|js|mjs|ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function trackedEnvironmentFiles() {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--", ":(glob)**/.env", ":(glob)**/.env.*"],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  )
    .split("\0")
    .filter(Boolean);
}

function configuredNames(path) {
  return readFileSync(join(ROOT, path), "utf8")
    .split("\n")
    .map((line) => line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/)?.[1])
    .filter(Boolean);
}

function discoveredPbsRuntimeHandles() {
  return [
    ...new Set(
      sourceFilesUnder(FUNCTIONS_SOURCE).flatMap((path) => {
        const source = readFileSync(path, "utf8");
        return [...source.matchAll(/\bdefineSecret\(\s*["'](PBS_[A-Z0-9_]+)["']\s*\)/g)]
          .map((match) => match[1]);
      }),
    ),
  ].sort();
}

describe("PBS secret boundary inventory", () => {


  it("keeps runtime handles in Functions and out of public site source", () => {
    const runtimeHandles = PBS_SECRET_INVENTORY.flatMap(
      ({ runtimeHandles }) => runtimeHandles,
    ).sort();
    expect(runtimeHandles).toEqual(["PBS_TVSS_AUTH"]);
    expect(discoveredPbsRuntimeHandles()).toEqual(runtimeHandles);

    const scheduleSource = readFileSync(join(ROOT, "functions/schedule.js"), "utf8");
    const proxySource = readFileSync(
      join(ROOT, "functions/lib/pbs/schedule-proxy.js"),
      "utf8",
    );
    const functionsIndex = readFileSync(
      join(ROOT, "functions/index.js"),
      "utf8",
    );
    for (const handle of runtimeHandles) {
      expect(scheduleSource).toContain(`defineSecret("${handle}")`);
    }
    expect(scheduleSource).toContain("secrets: [PBS_TVSS_AUTH]");
    expect(proxySource).toContain('"X-PBSAUTH"');
    expect(proxySource).toContain("https://tvss.services.pbs.org/tvss/");
    expect(functionsIndex).not.toMatch(
      /^(?!\s*\/\/)\s*exports\.scheduleProxy\s*=/m,
    );

    const publicMatches = sourceFilesUnder(SITE_SOURCE)
      .filter((path) =>
        runtimeHandles.some((handle) => readFileSync(path, "utf8").includes(handle)),
      )
      .map((path) => relative(ROOT, path));
    expect(publicMatches).toEqual([]);
  });



  it("does not assign inventoried secret names in tracked environment files", () => {
    const secretNames = PBS_SECRET_INVENTORY.flatMap(
      ({ runtimeHandles, buildEnvironmentNames }) => [
        ...runtimeHandles,
        ...buildEnvironmentNames,
      ],
    );
    const assignments = trackedEnvironmentFiles().flatMap((path) =>
      configuredNames(path).map((name) => ({ name, path })),
    );

    expect(
      assignments.filter(({ name }) => secretNames.includes(name)),
    ).toEqual([]);
  });
});
