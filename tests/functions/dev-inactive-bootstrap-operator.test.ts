import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync, closeSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { repositoryFixture } from "../helpers/repository-identity.mjs";

const mocks = vi.hoisted(() => ({
  args: vi.fn(), packet: vi.fn(), source: vi.fn(), environment: vi.fn(), credential: vi.fn(),
  read: vi.fn(), credentialClose: vi.fn(), open: vi.fn(), databaseClose: vi.fn(),
  inspect: vi.fn(), retire: vi.fn(), readback: vi.fn(),
}));
vi.mock("../../scripts/lib/public-release-operator-io.mjs", () => ({
  operatorRefused: () => { throw new Error(); }, parseOperatorArgs: mocks.args,
  readOperatorPacket: mocks.packet, assertOperatorSource: mocks.source,
  operatorCredentialStream: () => () => { throw new Error("Unexpected fixture credential"); },
  parseOperatorCredentialIdentity: () => {}, operatorAccount: () => {}, openOperatorDatabase: mocks.open,
}));
vi.mock("../../scripts/lib/development-rehearsal-credentials.mjs", () => ({ assertDevelopmentRehearsalEnvironment: mocks.environment }));
vi.mock("../../scripts/lib/development-install-credentials.mjs", () => ({ developmentInstallCredential: mocks.credential }));
vi.mock("../../scripts/lib/dev-inactive-bootstrap.cjs", () => ({ default: {
  SLOTS: [], parseRequest: () => {}, inspectDevInactiveBootstrap: mocks.inspect,
  retireDevInactiveBootstrap: mocks.retire, readDevInactiveBootstrap: mocks.readback,
} }));
import { runDevInactiveBootstrapOperator } from "../../scripts/lib/dev-inactive-bootstrap-operator.mjs";

const packet = { schemaVersion: 1, kind: "dev-inactive-bootstrap-operator", environment: "development",
  projectId: "njpbs-site-dev", operationId: "diagnostic-test", operatorCommitSha: "a".repeat(40),
  credentialIdentity: { projectId: "njpbs-site-dev", clientEmail: "fixture-sdk-client@njpbs-site-dev.iam.gserviceaccount.com",
    privateKeyId: "c".repeat(40), secretRef: "pass://claude/fixture" }, request: null };
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CMS_DEV_SDK_CLIENT_EMAIL", packet.credentialIdentity.clientEmail);
  mocks.args.mockReturnValue({ mode: "inspect", packetDigest: "b".repeat(64) });
  mocks.packet.mockResolvedValue(structuredClone(packet));
  mocks.credential.mockReturnValue({ read: mocks.read, close: mocks.credentialClose });
  mocks.read.mockResolvedValue({});
  mocks.open.mockResolvedValue({ firestore: {}, close: mocks.databaseClose });
  mocks.inspect.mockResolvedValue({ schemaVersion: 1 });
});
afterEach(() => vi.unstubAllEnvs());

it.each([
  ["packet-parse", "packet"], ["source-check", "source"], ["environment-check", "environment"],
  ["credential-open", "credential"], ["credential-read", "read"], ["database-open", "open"], ["inspect", "inspect"],
] as const)("retains the original error at %s, including when cleanup fails", async (expected, method) => {
  const error = new TypeError("PRIVATE SDK payload"), stage = vi.fn();
  mocks[method].mockImplementation(() => { throw error; });
  mocks.credentialClose.mockImplementation(() => { throw new Error("PRIVATE credential cleanup"); });
  mocks.databaseClose.mockRejectedValue(new Error("PRIVATE database cleanup"));
  await expect(runDevInactiveBootstrapOperator([], stage)).rejects.toBe(error);
  expect(stage).toHaveBeenLastCalledWith(expected);
  expect(mocks.retire).not.toHaveBeenCalled();
  expect(mocks.readback).not.toHaveBeenCalled();
  if (expected === "inspect") expect(mocks.databaseClose).toHaveBeenCalledOnce();
});

it.each(["credential-close", "database-close"])("reports a first cleanup failure at %s and closes both", async expected => {
  const error = new RangeError("PRIVATE cleanup payload"), stage = vi.fn();
  (expected === "credential-close" ? mocks.credentialClose : mocks.databaseClose)
    .mockImplementation(() => { throw error; });
  await expect(runDevInactiveBootstrapOperator([], stage)).rejects.toBe(error);
  expect(stage).toHaveBeenLastCalledWith(expected);
  expect(mocks.credentialClose).toHaveBeenCalledOnce();
  expect(mocks.databaseClose).toHaveBeenCalledOnce();
});
it("does not mask a non-Error cleanup rejection", async () => {
  mocks.credentialClose.mockImplementation(() => { throw undefined; });
  await expect(runDevInactiveBootstrapOperator([])).rejects.toBeUndefined();
  expect(mocks.databaseClose).toHaveBeenCalledOnce();
});
it("keeps inspect read-only and closes both resources on success", async () => {
  expect(await runDevInactiveBootstrapOperator([])).toMatchObject({ mode: "inspect", authorityWrites: 0, providerWrites: 0 });
  expect(mocks.retire).not.toHaveBeenCalled();
  expect(mocks.readback).not.toHaveBeenCalled();
  expect(mocks.credentialClose).toHaveBeenCalledOnce();
  expect(mocks.databaseClose).toHaveBeenCalledOnce();
});
it("preserves an owner inspect substage and original error through both cleanup failures", async () => {
  const error = new Error("PRIVATE native payload"), stage = vi.fn();
  mocks.inspect.mockImplementation(({ stage }) => { stage("inspect-preview-journal-guard"); throw error; });
  mocks.credentialClose.mockImplementation(() => { throw new Error("PRIVATE credential cleanup"); });
  mocks.databaseClose.mockRejectedValue(new Error("PRIVATE database cleanup"));
  await expect(runDevInactiveBootstrapOperator([], stage)).rejects.toBe(error);
  expect(stage).toHaveBeenLastCalledWith("inspect-preview-journal-guard");
  expect(mocks.credentialClose).toHaveBeenCalledOnce();
  expect(mocks.databaseClose).toHaveBeenCalledOnce();
});

let fixture: string, sha: string;
beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), "retire-stage-cli-"));
  mkdirSync(join(fixture, "scripts"));
  mkdirSync(join(fixture, "config"));
  for (const name of ["scripts/retire-dev-inactive-bootstrap.mjs", "scripts/render-development-config.mjs",
    "config/development-inputs.json"]) {
    writeFileSync(join(fixture, name), readFileSync(resolve(name)));
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--quiet"); git("add", "scripts", "config");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", "commit", "--quiet", "-m", "CLI fixture");
  sha = git("rev-parse", "HEAD").trim();
});
afterAll(() => { rmSync(fixture, { recursive: true, force: true }); });

function cli(options: { mode?: string; value?: unknown; mock?: string; stdout?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "retire-stage-packet-")), file = join(dir, "packet.json");
  const bytes = JSON.stringify(options.value ?? { ...packet, operatorCommitSha: sha });
  writeFileSync(file, bytes);
  const loader = join(dir, "loader.mjs");
  const cleanupFile = join(dir, "cleanup-completed");
  writeFileSync(loader, `import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === './lib/dev-inactive-bootstrap-operator.mjs') return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify((options.mock ?? "").replaceAll("__CLEANUP_FILE__", JSON.stringify(cleanupFile)))}), shortCircuit: true };
      return next(specifier, context);
    }});`);
  try {
    const result = spawnSync(process.execPath, [...(options.mock ? ["--import", loader] : []),
      "scripts/retire-dev-inactive-bootstrap.mjs", "--packet", file, "--packet-digest",
      createHash("sha256").update(bytes).digest("hex"), options.mode ?? "--inspect"],
    { cwd: fixture, env: { PATH: process.env.PATH, ...repositoryFixture,
      CMS_DEV_SDK_CLIENT_EMAIL: packet.credentialIdentity.clientEmail }, encoding: "utf8", timeout: 5000,
      stdio: ["ignore", options.stdout ?? "pipe", "pipe"] });
    return { ...result, cleanupCompleted: existsSync(cleanupFile) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
it.each([
  ["packet-guard", "Error", { ...packet, projectId: "njpbs-site" }],
  ["source-guard", "Error", { ...packet, operatorCommitSha: "0".repeat(40) }],
  ["module-import", "Error", undefined],
])("bounds actual CLI %s failures before credentials", (stage, errorClass, value) => {
  const result = cli({ value });
  expect(result.status, result.stderr).toBe(1); expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`code=DEV_RETIRE_REFUSED stage=${stage} errorClass=${errorClass};`);
  expect(result.stderr).toContain("no request confirmed");
  expect(result.stderr).not.toContain("--readback");
});
it.each(["TypeError", "SyntaxError", "RangeError", "Error", "Unknown"])("bounds %s details at the CLI catch", type => {
  const thrown = type === "Unknown" ? `{ name: 'PRIVATE name', message: 'PRIVATE payload', stack: 'PRIVATE stack' }`
    : `Object.assign(new ${type}('PRIVATE payload'), { name: 'PRIVATE name', code: 'PRIVATE code' })`;
  const result = cli({ mock: `export async function runDevInactiveBootstrapOperator(args, stage) { stage('credential-read'); throw ${thrown}; }` });
  expect(result.status).toBe(1); expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`stage=credential-read errorClass=${type};`);
  expect(result.stderr).not.toContain("PRIVATE");
  expect(result.stderr).not.toContain("at ");
});
it("directs a later uncertain apply to the original request's authorized readback", () => {
  const result = cli({ mode: "--apply", mock: `export async function runDevInactiveBootstrapOperator(args, stage) { stage('apply'); throw new Error('PRIVATE'); }` });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("stage=apply errorClass=Error");
  expect(result.stderr).toContain("coordinator GO for the original packet's --readback");
  expect(result.stderr).not.toContain("PRIVATE");
});
it("prints only the fixed inspect substage and built-in class for a native refusal", () => {
  const result = cli({ mock: `export async function runDevInactiveBootstrapOperator(args, stage) {
    stage('inspect-preview-journal-guard'); throw Object.assign(new Error('PRIVATE payload'), { code: 'PRIVATE code' }); }` });
  expect(result.status).toBe(1); expect(result.stdout).toBe("");
  expect(result.stderr).toBe("Development inactive bootstrap retirement was not confirmed; code=DEV_RETIRE_REFUSED stage=inspect-preview-journal-guard errorClass=Error; preserve the packet; no request confirmed; obtain coordinator diagnosis GO before another inspect\n");
});

it.each(["--inspect", "--apply"])("bounds a real failed receipt write for %s", mode => {
  const fd = openSync("/dev/full", "w");
  try {
    const result = cli({ mode, stdout: fd, mock: "export async function runDevInactiveBootstrapOperator() { return {}; }" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("code=DEV_RETIRE_REFUSED stage=result-write errorClass=Error;");
    expect(result.stderr).not.toContain("ENOSPC");
    expect(result.stderr).not.toContain("node:events");
    expect(result.stderr).toContain(mode === "--inspect" ? "no request confirmed" : "original packet's --readback");
  } finally { closeSync(fd); }
});

it("contains the installed SDK's unhandled first-read rejection and finishes cleanup", () => {
  const sdk = resolve("node_modules/@google-cloud/firestore/build/src/transaction.js");
  const result = cli({ mock: `import { createRequire } from 'node:module';
    import { writeFileSync } from 'node:fs';
    const require = createRequire(${JSON.stringify(resolve("package.json"))});
    const { Transaction } = require(${JSON.stringify(sdk)});
    export async function runDevInactiveBootstrapOperator(args, stage) {
      stage('inspect-archive-read');
      const tx = Object.create(Transaction.prototype);
      tx._firestore = { _traceUtil: { startActiveSpan: (name, action) => action() } };
      try { await tx.withLazyStartedTransaction(null, () => Promise.reject(new TypeError('PRIVATE SDK payload'))); }
      finally { await tx.rollback(); await new Promise(resolve => setImmediate(resolve)); writeFileSync(__CLEANUP_FILE__, 'complete'); }
    }` });
  expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.cleanupCompleted).toBe(true);
  expect(result.stderr).toBe("Development inactive bootstrap retirement was not confirmed; code=DEV_RETIRE_REFUSED stage=inspect-archive-read errorClass=TypeError; preserve the packet; no request confirmed; obtain coordinator diagnosis GO before another inspect\n");
});
it("refuses malformed retained Access proof before opening a credential", async () => {
  mocks.packet.mockResolvedValue({ ...packet, retainedAccess: { schemaVersion: 1 } });
  const stage = vi.fn();
  await expect(runDevInactiveBootstrapOperator([], stage)).rejects.toThrow();
  expect(stage).toHaveBeenLastCalledWith("retained-access-parse");
  expect(mocks.credential).not.toHaveBeenCalled(); expect(mocks.inspect).not.toHaveBeenCalled();
});
