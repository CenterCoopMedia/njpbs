// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

const workflow = read("../../.github/workflows/cms-publish.yml");

function job(name: string): string {
  const start = workflow.indexOf(`  ${name}:\n`);
  expect(start, `${name} job missing`).toBeGreaterThanOrEqual(0);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/^  [a-zA-Z0-9_-]+:\n/m);
  return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

describe("CMS publish dispatch and source boundary", () => {
  it("authorizes configured actors before checking out only the trusted admission helper", () => {
    const authorize = job("authorize");
    const build = job("build");

    expect(authorize).toContain("contents: read");
    expect(authorize).not.toMatch(/(?:contents|pages|id-token): write/);
    expect(authorize).toContain("contains(fromJSON(vars.CMS_PUBLISH_GITHUB_TRUSTED_ACTORS || '[]'), github.triggering_actor)");
    expect(authorize).toContain("github.ref == 'refs/heads/main'");
    expect(authorize).toContain('EVENT_NAME: ${{ github.event_name }}');
    expect(authorize).toContain('ref: ${{ github.sha }}');
    expect(authorize).toContain('persist-credentials: false');
    expect(authorize).toContain('sparse-checkout: functions/lib/cms-publish-dispatch.js');
    expect(authorize).toContain("assertPublishDispatch({");
    expect(authorize).toContain("trustedPublishActors().includes(process.env.TRIGGERING_ACTOR)");
    expect(authorize).not.toContain("secrets.");

    expect(build).toContain("needs: authorize");
    expect(build).toContain("contains(fromJSON(vars.CMS_PUBLISH_GITHUB_TRUSTED_ACTORS || '[]'), github.triggering_actor)");
    expect(build).toContain("github.ref == 'refs/heads/main'");
    expect(build).toContain("needs.authorize.result == 'success'");
  });

  it("builds the protected production source and receipts that exact commit", () => {
    const build = job("build");

    expect(build).toContain("ref: ${{ needs.authorize.outputs.deploy_ref }}");
    expect(build).toContain("fetch-depth: 0");
    expect(build).toContain("persist-credentials: false");
    expect(build).toContain("name: Require reviewed production source");
    expect(build).toContain("git merge-base --is-ancestor HEAD origin/main");
    expect(build).toContain("git diff --quiet \"$reviewed_main_sha\" HEAD");
    expect(build).toContain("name: Capture built source commit");
    expect(build).toContain("SOURCE_SHA: ${{ steps.source.outputs.sha }}");
    expect(build).toContain(
      'node scripts/update-publish-status.cjs "$QUEUE_ID" success "$SOURCE_SHA"',
    );
    expect(build).not.toContain('success "$GITHUB_SHA"');
  });

  it("keeps Pages write authority out of the reviewed-source build job", () => {
    const build = job("build");
    const deploy = job("deploy");

    expect(build).toContain("pages: read");
    expect(build).not.toContain("pages: write");
    expect(build).not.toContain("id-token: write");
    expect(deploy).toContain("pages: write");
    expect(deploy).toContain("id-token: write");
    expect(deploy).toContain("actions/deploy-pages@v5");
  });

  it("records public visibility only after the exact apex receipt", () => {
    const build = job("build");
    const deploy = job("deploy");
    const deployment = deploy.indexOf("actions/deploy-pages@v5");
    const publicReceipt = deploy.indexOf(
      "name: Verify exact CMS artifact at the public apex",
    );

    expect(build).toContain("scripts/cms-publish-public-receipt-v1.txt");
    expect(build).toContain("site/scripts/probe-public-pages-receipt.ts");
    expect(build).toContain(
      'checksum_files+=(probe-public-pages-receipt.mjs)',
    );
    expect(deployment).toBeGreaterThanOrEqual(0);
    expect(publicReceipt).toBeGreaterThan(deployment);
    expect(deploy).toContain(
      '"$RUNNER_TEMP/cms-writeback/cms-public-worker-artifact.json"',
    );
    expect(deploy).toContain(
      "PUBLIC_RECEIPT_OUTCOME: ${{ steps.public_receipt.outcome }}",
    );
    expect(deploy).toContain(
      '[ "$PUBLIC_RECEIPT_OUTCOME" = "success" ]',
    );
  });
});
