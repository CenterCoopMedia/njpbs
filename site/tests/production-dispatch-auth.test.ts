// @vitest-environment node
import { createHmac } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  fileURLToPath(new URL("../../.github/workflows/pages.yml", import.meta.url)),
  "utf8",
);

function verifierSource(): string {
  const match = workflow.match(
    /# BEGIN PRODUCTION_DEPLOY_AUTH\n\s+node <<'NODE'\n([\s\S]*?)\n\s+NODE\n\s+# END PRODUCTION_DEPLOY_AUTH/,
  );
  expect(match, "production dispatch verifier missing").not.toBeNull();
  const lines = match![1].split("\n");
  const indentation = Math.min(
    ...lines.filter((line) => line.trim()).map((line) => line.match(/^ */)![0].length),
  );
  return lines.map((line) => line.slice(indentation)).join("\n");
}

function signature(secret: string, timestamp: string, refreshId: string, deployRef: string) {
  return createHmac("sha256", secret)
    .update(`${timestamp}\n${refreshId}\n${deployRef}`)
    .digest("hex");
}

function runVerifier(overrides: NodeJS.ProcessEnv) {
  const directory = mkdtempSync(path.join(tmpdir(), "njpbs-production-auth-"));
  const output = path.join(directory, "github-output");
  const result = spawnSync(process.execPath, ["-e", verifierSource()], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GITHUB_OUTPUT: output,
      EVENT_NAME: "repository_dispatch",
      EVENT_REF: "refs/heads/main",
      TRIGGERING_ACTOR: "fixture-owner",
      CMS_DEPLOY_OWNER: "fixture-owner",
      INPUT_DEPLOY_REF: "",
      PAYLOAD_DEPLOY_REF: "production",
      PAYLOAD_REFRESH_ID: "refresh-123",
      PAYLOAD_TIMESTAMP: "",
      PAYLOAD_SIGNATURE: "",
      DISPATCH_SECRET: "0123456789abcdef0123456789abcdef",
      ...overrides,
    },
  });
  const outputs = existsSync(output) ? readFileSync(output, "utf8") : "";
  rmSync(directory, { recursive: true, force: true });
  return { ...result, outputs };
}

describe("production dispatch authentication", () => {
  it("accepts one fresh signed scheduler request", () => {
    const secret = "0123456789abcdef0123456789abcdef";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const result = runVerifier({
      DISPATCH_SECRET: secret,
      PAYLOAD_TIMESTAMP: timestamp,
      PAYLOAD_SIGNATURE: signature(secret, timestamp, "refresh-123", "production"),
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.outputs).toContain("deploy_ref=production\n");
    expect(result.outputs).toContain("require_fresh=1\n");
  });

  it("rejects tampering, stale requests, and unusable secrets", () => {
    const secret = "0123456789abcdef0123456789abcdef";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signed = signature(secret, timestamp, "refresh-123", "production");
    for (const overrides of [
      { PAYLOAD_DEPLOY_REF: "main", PAYLOAD_TIMESTAMP: timestamp, PAYLOAD_SIGNATURE: signed },
      { PAYLOAD_REFRESH_ID: "other", PAYLOAD_TIMESTAMP: timestamp, PAYLOAD_SIGNATURE: signed },
      { PAYLOAD_TIMESTAMP: String(Number(timestamp) - 601), PAYLOAD_SIGNATURE: signed },
      { PAYLOAD_TIMESTAMP: timestamp, PAYLOAD_SIGNATURE: "0".repeat(64) },
      { PAYLOAD_TIMESTAMP: timestamp, PAYLOAD_SIGNATURE: signed, DISPATCH_SECRET: "short" },
      { PAYLOAD_TIMESTAMP: timestamp, PAYLOAD_SIGNATURE: signed, CMS_DEPLOY_OWNER: "" },
      { PAYLOAD_TIMESTAMP: timestamp, PAYLOAD_SIGNATURE: signed, CMS_DEPLOY_OWNER: "another-owner" },
    ]) {
      expect(runVerifier(overrides).status).not.toBe(0);
    }
  });

  it("accepts owner runs only from the correct workflow ref", () => {
    const manual = runVerifier({
      EVENT_NAME: "workflow_dispatch",
      EVENT_REF: "refs/heads/main",
      INPUT_DEPLOY_REF: "production",
    });
    expect(manual.status).toBe(0);
    expect(manual.outputs).toContain("deploy_ref=production\n");
    expect(manual.outputs).toContain("require_fresh=0\n");

    const push = runVerifier({
      EVENT_NAME: "push",
      EVENT_REF: "refs/heads/production",
    });
    expect(push.status).toBe(0);
    expect(push.outputs).toContain("deploy_ref=refs/heads/production\n");

    expect(runVerifier({ EVENT_NAME: "workflow_dispatch", EVENT_REF: "refs/heads/topic" }).status).not.toBe(0);
    expect(runVerifier({ EVENT_NAME: "push", EVENT_REF: "refs/heads/main" }).status).not.toBe(0);
    expect(runVerifier({ EVENT_NAME: "workflow_dispatch", TRIGGERING_ACTOR: "other" }).status).not.toBe(0);
  });
});
