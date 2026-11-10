import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const temporaryDirs = [];

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function resolveCostPulls(env) {
  const bin = mkdtempSync(join(tmpdir(), "cost-puller-gcloud-"));
  temporaryDirs.push(bin);
  mkdirSync(join(bin, "functions"));
  const gcloud = join(bin, "gcloud");
  const calls = join(bin, "calls");
  writeFileSync(gcloud, "#!/usr/bin/env bash\nprintf 'called\\n' >> \"$COST_PULL_STUB_MARKER\"\nprintf '%s\\n' \"${COST_PULL_STUB_SECRET_STATE:-DISABLED}\"\n");
  chmodSync(gcloud, 0o755);
  const result = spawnSync("bash", [join(ROOT, "scripts/resolve-cost-ledger-pulls.sh")], {
    cwd: bin,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      COST_PULL_STUB_MARKER: calls,
      COST_LEDGER_GCP_PULL: "false",
      COST_LEDGER_CLOUDFLARE_PULL: "false",
      COST_LEDGER_AWS_PULL: "false",
      COST_LEDGER_GITHUB_PULL: "false",
      COST_LEDGER_GCP_PROJECT: "",
      COST_LEDGER_GCP_BILLING_TABLE: "",
      COST_LEDGER_CLOUDFLARE_ACCOUNT_ID: "",
      COST_LEDGER_GITHUB_ACCOUNT: "",
      COST_LEDGER_GITHUB_ACCOUNT_TYPE: "",
      COST_PULL_STUB_SECRET_STATE: "DISABLED",
      ...env,
    },
  });
  return { ...result, flags: JSON.parse(readFileSync(join(bin, "functions/cost-ledger-pulls.generated.json"), "utf8")), calls: existsSync(calls) ? readFileSync(calls, "utf8") : "" };
}

describe("cost pull deployment configuration", () => {
  it("does not run a metadata command while every source is off", () => {
    const result = resolveCostPulls({});
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.calls).toBe("");
    expect(Object.values(result.flags)).toEqual([false, false, false, false]);
    expect(result.stdout).toContain("COST_LEDGER_GCP_PULL=false\n");
  });

  it("keeps a requested source off when its latest secret version is disabled", () => {
    const result = resolveCostPulls({
      COST_LEDGER_GCP_PULL: "true",
      COST_LEDGER_GCP_PROJECT: "njpbs-site",
      COST_LEDGER_GCP_BILLING_TABLE: "njpbs-site.billing.gcp_billing_export_v1",
      COST_PULL_STUB_SECRET_STATE: "DISABLED",
    });
    expect(result.status).toBe(0);
    expect(result.calls).toBe("called\n");
    expect(result.stdout).toContain("COST_LEDGER_GCP_PULL=false\n");
    expect(result.stderr).toContain("GCP cost pull remains disabled");
  });

  it.each([{}, { COST_LEDGER_GITHUB_ACCOUNT: "CenterCoopMedia" },
    { COST_LEDGER_GITHUB_ACCOUNT_TYPE: "org" }])(
    "keeps GitHub off without an explicit account and type: %j", (configuration) => {
      const result = resolveCostPulls({
        COST_LEDGER_GITHUB_PULL: "true", COST_PULL_STUB_SECRET_STATE: "ENABLED", ...configuration,
      });
      expect(result.status).toBe(0);
      expect(result.calls).toBe("");
      expect(result.flags.COST_LEDGER_GITHUB_PULL).toBe(false);
    },
  );

  it("enables the explicitly configured organization after checking secret metadata", () => {
    const result = resolveCostPulls({
      COST_LEDGER_GITHUB_PULL: "true", COST_LEDGER_GITHUB_ACCOUNT: "CenterCoopMedia",
      COST_LEDGER_GITHUB_ACCOUNT_TYPE: "org", COST_PULL_STUB_SECRET_STATE: "ENABLED",
    });
    expect(result.status).toBe(0);
    expect(result.calls).toBe("called\n");
    expect(result.flags.COST_LEDGER_GITHUB_PULL).toBe(true);
    expect(result.stdout).toContain("COST_LEDGER_GITHUB_ACCOUNT=CenterCoopMedia\n");
    expect(result.stdout).toContain("COST_LEDGER_GITHUB_ACCOUNT_TYPE=org\n");
  });

  it("writes only validated public configuration to dotenv output", () => {
    const result = resolveCostPulls({
      COST_LEDGER_GCP_PROJECT: "njpbs-site\nINJECTED_PULL=true",
      COST_LEDGER_GITHUB_ACCOUNT: "invalid/account",
      COST_LEDGER_GITHUB_ACCOUNT_TYPE: "other",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("COST_LEDGER_GCP_PROJECT=\n");
    expect(result.stdout).not.toContain("INJECTED_PULL=true");
    expect(result.stdout).toContain("COST_LEDGER_GITHUB_ACCOUNT=\n");
    expect(result.stdout).toContain("COST_LEDGER_GITHUB_ACCOUNT_TYPE=\n");
  });
});

// Execute the production module against a real temporary artifact, without
// loading credentials, initializing Firebase, or calling provider transports.
function discover(flagsFile, env) {
  const dir = mkdtempSync(join(tmpdir(), "cost-puller-discovery-"));
  temporaryDirs.push(dir);
  if (flagsFile !== undefined) writeFileSync(join(dir, "cost-ledger-pulls.generated.json"), flagsFile);
  const declared = [];
  const localRequire = createRequire(join(ROOT, "functions/cost-ledger-refresh.js"));
  const module = { exports: {} };
  runInNewContext(readFileSync(join(ROOT, "functions/cost-ledger-refresh.js"), "utf8"), {
    __dirname: dir,
    module,
    process: { env },
    require(name) {
      if (name === "firebase-functions/params") return {
        defineSecret(secret) { declared.push(secret); return { name: secret, value: () => "fixture" }; },
      };
      if (name === "firebase-functions/v2/scheduler") return { onSchedule: (options) => options };
      if (name === "./lib/firebase") return { db: {} };
      return localRequire(name);
    },
  });
  return { declared, ...module.exports };
}

const off = Object.fromEntries(["GCP", "CLOUDFLARE", "AWS", "GITHUB"].map((id) => [`COST_LEDGER_${id}_PULL`, false]));

describe("file-based discovery and runtime decision", () => {
  it("binds all requested secrets with no environment flags and keeps the same runtime decision", () => {
    const flags = Object.fromEntries(Object.keys(off).map((key) => [key, true]));
    const result = discover(JSON.stringify(flags), {});
    expect(result.declared).toEqual([
      "COST_LEDGER_GCP_BILLING_SA", "COST_LEDGER_CLOUDFLARE_API_TOKEN",
      "COST_LEDGER_AWS_ACCESS_KEY_ID", "COST_LEDGER_AWS_SECRET_ACCESS_KEY", "COST_LEDGER_GITHUB_TOKEN",
    ]);
    expect(result.onCostLedgerRefresh.secrets.map((secret) => secret.name)).toEqual(result.declared);
    expect(result.deploymentFlags()).toEqual(flags);
    expect(Object.isFrozen(result.deploymentFlags())).toBe(true);
  });

  it("enables only the file-selected source despite contradictory environment flags", () => {
    const flags = { ...off, COST_LEDGER_AWS_PULL: true };
    const result = discover(JSON.stringify(flags), { COST_LEDGER_AWS_PULL: "false", COST_LEDGER_GITHUB_PULL: "true" });
    expect(result.declared).toEqual(["COST_LEDGER_AWS_ACCESS_KEY_ID", "COST_LEDGER_AWS_SECRET_ACCESS_KEY"]);
    expect(result.onCostLedgerRefresh.secrets.map((secret) => secret.name)).toEqual(result.declared);
    expect(result.deploymentFlags()).toEqual(flags);
  });

  it.each([undefined, "{", "null", "[]", '{}', JSON.stringify({ ...off, COST_LEDGER_AWS_PULL: "true" }), JSON.stringify(off)])(
    "declares and binds no secrets for an absent, malformed, or all-off file (%s)", async (file) => {
      const result = discover(file, Object.fromEntries(Object.keys(off).map((key) => [key, "true"])));
      expect(result.declared).toEqual([]);
      expect(result.onCostLedgerRefresh.secrets).toEqual([]);
      expect(await result.refreshCostLedger()).toEqual({ outcome: "disabled", results: [] });
    },
  );
});
