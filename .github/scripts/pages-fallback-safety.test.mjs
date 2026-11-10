import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertPagesFallbackSafety } from "./pages-fallback-safety.mjs";

const paths = [
  ".github/workflows/pages.yml",
  ".github/workflows/pages-fallback-safety.yml",
  "scripts/pages-public-artifact-runtime-v3.txt",
  "site/src/lib/cms-loader.ts",
  "site/src/lib/public-artifact-inventory.ts",
];
const source = new Map(
  paths.map((path) => [path, readFileSync(path, "utf8")]),
);

function reader(overrides = new Map()) {
  return (path) => overrides.get(path) ?? source.get(path);
}

test("accepts the current non-reserving Pages runtime", () => {
  assert.doesNotThrow(() => assertPagesFallbackSafety(reader()));
});

test("rejects a workflow that reserves a Pages generation", () => {
  const path = ".github/workflows/pages.yml";
  const changed = `${source.get(path)}\n# name: Reserve exact public artifact cutoff\n`;
  assert.throws(
    () => assertPagesFallbackSafety(reader(new Map([[path, changed]]))),
    /still contains/i,
  );
});

test("rejects a deployed-batch path without terminal-receipt validation", () => {
  const path = "site/src/lib/public-artifact-inventory.ts";
  const changed = source.get(path).replaceAll(
    "assertPublicDeploymentTerminalBatchStructure",
    "missingTerminalValidator",
  );
  assert.throws(
    () => assertPagesFallbackSafety(reader(new Map([[path, changed]]))),
    /missing assertPublicDeploymentTerminalBatchStructure/i,
  );
});

test("rejects removal of deployed-batch loader routing", () => {
  const path = "site/src/lib/cms-loader.ts";
  const changed = source.get(path).replace(
    'request.batchMode === "deployed"',
    "false",
  );
  assert.throws(
    () => assertPagesFallbackSafety(reader(new Map([[path, changed]]))),
    /CMS artifact loader.*request\.batchMode/i,
  );
});

test("rejects removal of the production-candidate check route", () => {
  const path = ".github/workflows/pages-fallback-safety.yml";
  const changed = source.get(path).replace('      - "production-candidate/**"\n', "");
  assert.throws(
    () => assertPagesFallbackSafety(reader(new Map([[path, changed]]))),
    /missing.*production-candidate/i,
  );
});

test("rejects removal of the pre-deployment active-batch revalidation", () => {
  const path = ".github/workflows/pages.yml";
  const changed = source.get(path).replace(
    "name: Revalidate active public artifact",
    "name: Skip active public artifact revalidation",
  );
  assert.throws(
    () => assertPagesFallbackSafety(reader(new Map([[path, changed]]))),
    /missing.*Revalidate active public artifact/i,
  );
});

test("rejects a revalidation moved before the build", () => {
  const path = ".github/workflows/pages.yml";
  const workflow = source.get(path);
  const step = "      - name: Revalidate active public artifact\n";
  const changed = workflow.replace(step, "").replace(
    "      - name: Build\n",
    `${step}      - name: Build\n`,
  );
  assert.throws(
    () => assertPagesFallbackSafety(reader(new Map([[path, changed]]))),
    /out of order/i,
  );
});

test("rejects a deploy job without its own active-batch check", () => {
  const path = ".github/workflows/pages.yml";
  const changed = source.get(path).replace(
    "name: Revalidate active public artifact at deployment",
    "name: Skip active public artifact check at deployment",
  );
  assert.throws(
    () => assertPagesFallbackSafety(reader(new Map([[path, changed]]))),
    /deploy check must immediately precede deployment/i,
  );
});

test("rejects a deploy check after the Pages action", () => {
  const path = ".github/workflows/pages.yml";
  const workflow = source.get(path);
  const step = "      - id: deployment\n        uses: actions/deploy-pages@v5\n";
  const changed = workflow.replace(step, "").replace(
    "      - name: Revalidate active public artifact at deployment\n",
    `${step}      - name: Revalidate active public artifact at deployment\n`,
  );
  assert.throws(
    () => assertPagesFallbackSafety(reader(new Map([[path, changed]]))),
    /deploy check must immediately precede deployment/i,
  );
});

test("rejects another step inserted between the deploy check and Pages action", () => {
  const path = ".github/workflows/pages.yml";
  const action = "      - id: deployment\n        uses: actions/deploy-pages@v5\n";
  const changed = source.get(path).replace(
    action,
    `      - name: Delay deployment\n        run: echo delayed\n${action}`,
  );
  assert.throws(
    () => assertPagesFallbackSafety(reader(new Map([[path, changed]]))),
    /deploy check must immediately precede deployment/i,
  );
});

test("rejects a missing active-artifact build output", () => {
  const path = ".github/workflows/pages.yml";
  const changed = source.get(path).replace(
    "artifact_ready: ${{ steps.artifact_runtime.outputs.ready }}",
    "artifact_status: ${{ steps.artifact_runtime.outputs.ready }}",
  );
  assert.throws(
    () => assertPagesFallbackSafety(reader(new Map([[path, changed]]))),
    /build outputs.*artifact_ready/i,
  );
});

test("rejects a deploy check that does not use the active-artifact condition", () => {
  const path = ".github/workflows/pages.yml";
  const marker = "      - name: Revalidate active public artifact at deployment\n";
  const changed = source.get(path).replace(
    `${marker}        if: needs.build.outputs.artifact_ready == 'true'\n`,
    `${marker}        if: always()\n`,
  );
  assert.throws(
    () => assertPagesFallbackSafety(reader(new Map([[path, changed]]))),
    /deploy check.*artifact_ready/i,
  );
});

test("rejects a deploy check allowed to continue on error", () => {
  const path = ".github/workflows/pages.yml";
  const marker = "      - name: Revalidate active public artifact at deployment\n";
  const changed = source.get(path).replace(
    marker,
    `${marker}        continue-on-error: true\n`,
  );
  assert.throws(
    () => assertPagesFallbackSafety(reader(new Map([[path, changed]]))),
    /deploy check must fail closed/i,
  );
});
