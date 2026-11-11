// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { verifyLivePublisher } from "../../.github/scripts/cms-deploy-compatibility.mjs";

const scriptPath = ".github/scripts/cms-deploy-compatibility.mjs";
const modelPath = "packages/content-core/src/content-model.ts";
const routesPath = "packages/content-core/src/public-record-kinds.ts";
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const currentModel = read(modelPath);
const currentRoutes = read(routesPath);
const workflow = parse(read(".github/workflows/cms-staging-deploy.yml"));
const gate = workflow.jobs["admin-build"].steps.find(
  (step: { name?: string }) => step.name === "Require CMS deploy compatibility floor",
).run as string;

let root: string;
let runtime: string;
let server: Server;
let receipt: unknown;
let receiptStatus: number;
let rendererHeader: string | undefined;
let receiptUrl: string;
let withoutVideoSha: string;
let libraryEventSha: string;
let currentSha: string;
let sameCatalogSha: string;
let futureBlockSha: string;
let podcastSha: string;
let invalidCatalogSha: string;
let rendererAndCmsSha: string;
let mixedSha: string;
let activeGate: { child: ChildProcess; closed: Promise<void> } | undefined;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commitCatalog(model = currentModel, routes = currentRoutes): string {
  writeFileSync(join(root, modelPath), model);
  writeFileSync(join(root, routesPath), routes);
  git("add", modelPath, routesPath, ".github/cms-deploy-compatibility.json", "firestore.rules");
  git("-c", "user.name=Fixture Author", "-c", "user.email=fixture-author@example.org",
    "commit", "--quiet", "--allow-empty", "-m", "Catalog fixture");
  return git("rev-parse", "HEAD");
}

function commitOnto(parentSha: string, files: Record<string, string>): string {
  git("update-ref", "HEAD", parentSha);
  git("read-tree", parentSha);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git("add", "--", ...Object.keys(files));
  git("-c", "user.name=Fixture Author", "-c", "user.email=fixture-author@example.org",
    "commit", "--quiet", "-m", "Deploy fixture");
  return git("rev-parse", "HEAD");
}

async function deployGate(deploySha = currentSha): Promise<{ code: number; output: string }> {
  git("update-ref", "HEAD", deploySha);
  // Exercise real Git catalogs and HTTP receipts without starting Node for each case.
  // The workflow smoke cases below retain the shell, trusted script and exit-code contract.
  try {
    return { code: 0, output: await verifyLivePublisher(root, receiptUrl) };
  } catch (error) {
    return { code: 1, output: error instanceof Error ? error.message : String(error) };
  }
}

async function workflowGate(deploySha = currentSha): Promise<{ code: number; output: string }> {
  // Catalogs are read from Git, while the rules and manifest are identical in every fixture.
  // Select an immutable commit without checking out files or rebuilding a repository per case.
  git("update-ref", "HEAD", deploySha);
  // Run the actual trusted workflow step against a deploy checkout and a local public receipt.
  const command = gate.replace("https://njpbs.org/_publication.json", receiptUrl);
  const child = spawn("bash", ["-euc", command], {
    cwd: root,
    env: { ...process.env, GITHUB_WORKSPACE: root, RUNNER_TEMP: runtime },
    // Own the shell and its descendants so a timed-out test can drain them.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const running = { child, closed: new Promise<void>(resolve => child.once("close", () => resolve())) };
  activeGate = running;
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code: code ?? 1, output };
  } finally {
    await running.closed;
    activeGate = undefined;
  }
}

afterEach(async () => {
  const running = activeGate;
  if (!running) return;
  // The shell can exit before a descendant closes its inherited output pipes.
  if (running.child.pid) {
    try { process.kill(-running.child.pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  await running.closed;
});

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "njpbs-publisher-compatibility-"));
  mkdirSync(join(root, "packages/content-core/src"), { recursive: true });
  mkdirSync(join(root, ".github"));
  writeFileSync(join(root, ".github/cms-deploy-compatibility.json"), read(".github/cms-deploy-compatibility.json"));
  writeFileSync(join(root, "firestore.rules"), read("firestore.rules"));
  git("init", "--quiet");
  withoutVideoSha = commitCatalog(currentModel.replace('  "video",\n', ""));
  libraryEventSha = commitCatalog(currentModel, currentRoutes.replace('["post", "program", "event"]', '["post", "program"]'));
  currentSha = commitCatalog();
  // Same catalog, one chrome change ahead of the renderer.
  sameCatalogSha = commitOnto(currentSha, { "site/src/lib/public-chrome.ts": "export const chrome = 1;\n" });
  futureBlockSha = commitCatalog(currentModel.replace('  "video",', '  "future_block",\n  "video",'));
  podcastSha = commitCatalog(currentModel.replace('  "program",', '  "podcast",\n  "program",'));
  invalidCatalogSha = commitCatalog(currentModel.replace('  "video",', '  ...additionalBlocks,'));
  // A mixed CMS/renderer change still requires the paired public release.
  rendererAndCmsSha = commitOnto(currentSha, {
    ".github/scripts/cms-deploy-compatibility.mjs": "// guard\n",
    "functions/lib/no-build-post-publication.js": "// batched owner reads\n",
    "site/src/data/schedule.json": "{}\n",
    "site/tests/cms-publisher-compatibility.test.ts": "// guard test\n",
    "tests/functions/public-worker-candidate.test.js": "// owner test\n",
  });
  mixedSha = commitOnto(currentSha, {
    "functions/lib/no-build-post-publication.js": "// batched owner reads\n",
    "site/src/lib/public-chrome.ts": "export const chrome = 2;\n",
  });
  runtime = mkdtempSync(join(tmpdir(), "publisher-trusted-gate-"));
  // The gate comes from the trusted workflow checkout, never the selected deploy ref.
  mkdirSync(join(runtime, "admin-status-gate/.github/scripts"), { recursive: true });
  writeFileSync(join(runtime, "admin-status-gate", scriptPath), read(scriptPath));
  server = createServer((request, response) => {
    if (request.url !== "/_publication.json") {
      response.writeHead(404).end();
      return;
    }
    // Each receipt request owns its socket. Synchronous Git work can outlive
    // a pooled socket's idle timeout; a later case must not inherit that race.
    response.writeHead(receiptStatus, { "content-type": "application/json", connection: "close",
      ...(rendererHeader === undefined ? {} : { "x-njpbs-renderer-sha": rendererHeader }) });
    response.end(JSON.stringify(receipt));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  receiptUrl = `http://127.0.0.1:${address.port}/_publication.json`;
});

beforeEach(() => {
  receipt = { commitSha: currentSha };
  receiptStatus = 200;
  rendererHeader = currentSha;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(root, { recursive: true, force: true });
  rmSync(runtime, { recursive: true, force: true });
});

describe("CMS deploy versus the live publisher catalog", () => {
  it("runs the trusted workflow command against the live publisher receipt", async () => {
    const result = await workflowGate();
    expect(result.code).toBe(0);
    expect(result.output).toContain(`publisher ${currentSha} supports the deploy catalog`);
    expect(result.output).toContain("editor-lock contract v9 verified");
  });

  it("fails the trusted workflow command when the public receipt is unavailable", async () => {
    receiptStatus = 503;
    const result = await workflowGate();
    expect(result.code).toBe(1);
    expect(result.output).toContain("503");
  });

  it("refuses the video block that the receipt's old publisher cannot build", async () => {
    const publisherSha = withoutVideoSha;
    receipt = { commitSha: publisherSha };
    rendererHeader = publisherSha;

    const result = await deployGate();
    expect(result.code).toBe(1);
    expect(result.output).toContain(publisherSha);
    expect(result.output).toContain("Unsupported block types: video");
    expect(result.output).toContain("deployment configuration");
    expect(result.output).not.toContain("docs/cms/");
    expect(result.output).toContain("Promote the publisher first");
  });

  it("refuses a CMS ahead of the live renderer that changes chrome even with an identical catalog", async () => {
    const result = await deployGate(sameCatalogSha);
    expect(result.code).toBe(1);
    expect(result.output).toContain(`changes paths outside the CMS-only allow list for live public renderer ${currentSha}`);
  });

  it("passes a newer publisher with a superset of the deploy catalog", async () => {
    receipt = { commitSha: futureBlockSha };
    rendererHeader = futureBlockSha;
    expect((await deployGate()).code).toBe(0);
  });

  it("refuses a new editorial record kind", async () => {
    const result = await deployGate(podcastSha);
    expect(result.code).toBe(1);
    expect(result.output).toContain("Unsupported record kinds: podcast");
  });

  it("refuses enabling a public route for a record kind the publisher only knew as library content", async () => {
    receipt = { commitSha: libraryEventSha };
    rendererHeader = libraryEventSha;
    const result = await deployGate();
    expect(result.code).toBe(1);
    expect(result.output).toContain("Unsupported public record kinds: event");
  });

  it.each([{}, { commitSha: "main" }, { commitSha: "5e5ad5e7" }, { commitSha: null }])(
    "refuses an unverified publisher identity: %j", async (invalidReceipt) => {
      receipt = invalidReceipt;
      const result = await deployGate();
      expect(result.code).toBe(1);
      expect(result.output).toContain("commitSha");
    },
  );

  it("refuses a receipt commit absent from repository history", async () => {
    receipt = { commitSha: "f".repeat(40) };
    rendererHeader = "f".repeat(40);
    const result = await deployGate();
    expect(result.code).toBe(1);
    expect(result.output).toContain("f".repeat(40));
  });

  it("refuses an unavailable public receipt", async () => {
    receiptStatus = 503;
    const result = await deployGate();
    expect(result.code).toBe(1);
    expect(result.output).toContain("503");
  });

  it("refuses a catalog declaration that it cannot verify", async () => {
    const result = await deployGate(invalidCatalogSha);
    expect(result.code).toBe(1);
    expect(result.output).toContain("BLOCK_TYPES");
  });

  it.each(["main", "0263e509", "f".repeat(40)])("refuses a malformed or mismatched renderer header %s", async header => {
    rendererHeader = header;
    expect((await deployGate()).code).toBe(1);
  });

  it("refuses disagreement between the renderer header and publication body", async () => {
    receipt = { commitSha: futureBlockSha };
    const result = await deployGate(sameCatalogSha);
    expect(result.code).toBe(1);
    expect(result.output).toContain("renderer header must match");
  });

  it("accepts an Assets fallback receipt without a renderer header for recovery deploys", async () => {
    rendererHeader = undefined;
    const result = await workflowGate();
    expect(result.code).toBe(0);
    expect(result.output).toContain(`publisher ${currentSha} supports the deploy catalog`);
  });

  it("still refuses a CMS ahead of the no-header Assets receipt", async () => {
    rendererHeader = undefined;
    const result = await workflowGate(sameCatalogSha);
    expect(result.code).toBe(1);
    expect(result.output).toContain(`changes paths outside the CMS-only allow list for live public renderer ${currentSha}`);
  });

  it("refuses a diverged deploy commit with the same content catalog", async () => {
    git("update-ref", "HEAD", withoutVideoSha);
    const divergedSha = commitCatalog();
    expect((await deployGate(divergedSha)).code).toBe(1);
  });

  it("fails the actual trusted workflow command for a CMS ahead of the renderer", async () => {
    const result = await workflowGate(sameCatalogSha);
    expect(result.code).toBe(1);
    expect(result.output).toContain("changes paths outside the CMS-only allow list");
  });
});

describe("CMS deploy one commit past the live renderer", () => {
  // #4982 and the coordinator's default-refusal rule permit only explicitly
  // verified CMS-only paths. Expected outcomes do not come from the gate's output.
  it.each([
    "admin/src/routes/Usage.tsx",
    "functions/boardwalk-usage.js",
    "functions/lib/boardwalk-usage-config.json",
    "docs/cms/boardwalk-usage.md",
    "admin/src/components/Usage.tsx",
    "admin/src/styles/usage.css",
    "admin/src/data/whats-new.ts",
    "admin/src/data/whats-new/usage.json",
    "docs/cms/cloud-publisher.md",
    "docs/cms/staging-deploy-runbook.md",
    "tests/functions/boardwalk-usage.test.js",
    "tests/rules/boardwalk-usage.test.js",
  ])("allows a CMS-ahead change confined to %s", async path => {
    const cmsAheadSha = commitOnto(currentSha, { [path]: "// CMS-only change\n" });
    expect(await deployGate(cmsAheadSha)).toEqual({ code: 0, output: currentSha });
  });

  it("passes the trusted workflow for an Admin/usage-only descendant without a renderer header", async () => {
    const cmsAheadSha = commitOnto(currentSha, {
      "admin/src/routes/Usage.tsx": "// Admin\n",
      "functions/boardwalk-usage.js": "// usage analytics\n",
    });
    rendererHeader = undefined;
    const result = await workflowGate(cmsAheadSha);
    expect(result.code).toBe(0);
    expect(result.output).toContain(`publisher ${currentSha} supports the deploy catalog`);
  });

  it.each([
    "site/src/lib/public-site-chrome.ts",
    "publisher/Dockerfile",
    "publisher/worker.ts",
    "package-lock.json",
    "functions/package.json",
    "admin/package.json",
    "packages/content-core/src/cms-settings.ts",
    "packages/browser-search/contracts.ts",
    "functions/published-post-reader.js",
    "functions/lib/published-chrome-projection.js",
    "functions/lib/cms-settings-contract.js",
    "functions/lib/posts-browse-contract.js",
    "functions/lib/page-reader-compatibility.js",
    "functions/lib/page-reader-contract.js",
    "functions/lib/public-page-contract.js",
    "functions/lib/public-release-source-limits.js",
    "functions/lib/public-release-historical-state.js",
    "functions/lib/public-release-media-retention.js",
    "functions/lib/public-release-media-coverage.js",
    "functions/lib/public-release-content-activation.js",
    "cms-api/src/page-reader-contract.json",
    "no-build-page-worker.ts",
    "public-no-build-entry.ts",
    "transitional-post-read-worker.ts",
    "live-blog-feed.ts",
    "public-isolate-start.ts",
    "no-build-code-post-worker.ts",
    "public-content-baseline.ts",
    "public-author-pending.ts",
    "public-release-slot-worker.ts",
    "shadow-post-entry.ts",
    "staff-site-worker.ts",
    "dev-public-worker.ts",
    "wiki/web/public.md",
  ])("refuses a CMS-ahead change to protected input %s", async path => {
    const cmsAheadSha = commitOnto(currentSha, { [path]: "// renderer input change\n" });
    const result = await deployGate(cmsAheadSha);
    expect(result.code).toBe(1);
    expect(result.output).toContain("changes paths outside the CMS-only allow list");
    expect(result.output).toContain(path);
  });

  it.each([
    "functions/lib/new-public-reader.js",
    "admin/src/lib/new-shared-reader.ts",
    "docs/cms/new-build-input.json",
  ])("refuses an allowed-only change mixed with unknown input %s", async path => {
    const cmsAheadSha = commitOnto(currentSha, {
      "admin/src/routes/Usage.tsx": "// allowed CMS screen\n",
      [path]: "// unknown input\n",
    });
    const result = await deployGate(cmsAheadSha);
    expect(result.code).toBe(1);
    expect(result.output).toContain("outside the CMS-only allow list");
    expect(result.output).toContain(path);
  });

  it("refuses moving a protected file out of the renderer tree", async () => {
    const liveSha = commitOnto(currentSha, { "site/renderer.ts": "export const renderer = 1;\n" });
    receipt = { commitSha: liveSha };
    rendererHeader = liveSha;
    git("mv", "site/renderer.ts", "renderer.ts");
    git("-c", "user.name=Fixture Author", "-c", "user.email=fixture-author@example.org",
      "commit", "--quiet", "-m", "Move renderer fixture");
    const result = await deployGate(git("rev-parse", "HEAD"));
    expect(result.code).toBe(1);
    expect(result.output).toContain("site/renderer.ts");
  });

  it("keeps Cut A ancestry refusal when a local file claims singleton proof", async () => {
    const proof = join(root, "cms-public-contract-summary.json");
    writeFileSync(proof, JSON.stringify({ schemaVersion: 1, candidateSha: sameCatalogSha, result: "proved", proofDigest: "a".repeat(64) }));
    try {
      const result = await workflowGate(sameCatalogSha);
      expect(result.code).toBe(1);
      expect(result.output).toContain(`ancestor of live public renderer ${currentSha}`);
    } finally { rmSync(proof); }
  });
  it("passes a deploy at or behind the renderer", async () => {
    expect((await deployGate(currentSha)).code).toBe(0);
    receipt = { commitSha: futureBlockSha };
    rendererHeader = futureBlockSha;
    expect((await deployGate(currentSha)).code).toBe(0);
  });

  it("refuses a descendant with renderer and CMS changes", async () => {
    const result = await workflowGate(rendererAndCmsSha);
    expect(result.code).toBe(1);
    expect(result.output).toContain(`changes paths outside the CMS-only allow list for live public renderer ${currentSha}`);
  });

  it("refuses a descendant mixing a public chrome change with a Functions change", async () => {
    const result = await workflowGate(mixedSha);
    expect(result.code).toBe(1);
    expect(result.output).toContain(`changes paths outside the CMS-only allow list for live public renderer ${currentSha}`);
    expect((await deployGate(mixedSha)).code).toBe(1);
  });
});
