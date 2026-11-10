import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { privatePairPublisherScenario } from "../tests/helpers/private-pair-publisher-install.mjs";
import { preparePrivatePairPublisherInstall } from "../scripts/lib/private-pair-publisher-prepare.mjs";

// The 15 s budget covers offline preparation and both actual CLI runs.
it("prepares and rechecks the full sealed continuation in the real default-off operator", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url)), directory = mkdtempSync(join(tmpdir(), "pair-continuation-"));
  try {
    const current = await privatePairPublisherScenario(undefined, { accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    const pairTemplate = structuredClone(current.input.plan.pairTemplate);
    pairTemplate.commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const intent = { pairTemplate, retainedPairs: [], imageReference: current.input.plan.imageReference, executorReady: true,
      continuationEnabled: true, ingressProofService: "njpbs-private-ingress-development",
      legacyConfig: { name: "njpbs-dev-cms-publisher", account_id: current.input.plan.accountId, compatibility_date: "2026-10-28",
        vars: { CMS_DEPLOYMENT_ENVIRONMENT: "development" }, r2_buckets: [{ bucket_name: "njpbs-dev-cms-publication" }] } };
    const { plan, prepared } = await preparePrivatePairPublisherInstall(intent);
    expect(prepared.continuationEnabled).toBe(true);
    const packet = { schemaVersion: 1, kind: "private-pair-publisher-operator", intent,
      preparation: { schemaVersion: 2, kind: "private-pair-publisher-preparation", plan, executorReady: prepared.executorReady,
        moduleManifest: prepared.moduleManifest, providerWrites: 0, runtimePreflight: "not-run" },
      preflightOperationId: "publisher-continuation-proof", credentialIdentity: { projectId: "njpbs-site-dev",
        clientEmail: "pair-test@njpbs-site-dev.iam.gserviceaccount.com", privateKeyId: "a".repeat(40) } };
    const filename = join(directory, "packet.json");
    const run = () => {
      const bytes = JSON.stringify(packet); writeFileSync(filename, bytes);
      return execFileSync(process.execPath, ["scripts/install-private-pair-publisher.mjs", "--packet", filename,
        "--packet-digest", createHash("sha256").update(bytes).digest("hex")], { cwd: root, encoding: "utf8",
        env: { PATH: process.env.PATH, CLOUDFLARE_ACCOUNT_ID: current.input.plan.accountId }, stdio: ["ignore", "pipe", "pipe"] });
    };
    expect(JSON.parse(run())).toMatchObject({ executorReady: true, providerWrites: 0, runtimePreflight: "not-run",
      publicSelectionChanged: false, publicationSuccess: false });
    packet.intent.ingressProofService = "njpbs-private-ingress-changed";
    let refusal: { stderr?: Buffer } | undefined;
    try { run(); } catch (error) { refusal = error as { stderr?: Buffer }; }
    expect(refusal).toBeDefined();
    // A rehashed packet must fail at its seal, rather than an unrelated boundary.
    expect(String(refusal?.stderr)).toContain("operator-packet-refused; uncertain=false");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 15_000);
