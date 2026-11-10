import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { retainDevPreviewBootstrapReceipt } from "./bootstrap-dev.mjs";

it.each([
  { status: "committed-paused", failure: false, complete: true },
  { status: "restored-paused", failure: false, complete: true },
  { status: "restored-paused", failure: true, complete: true },
  { status: "failed", failure: true, complete: false },
  { status: undefined, failure: true, complete: false },
])("writes only safe artifact fields ($status, failure=$failure)", async ({ status, failure, complete }) => {
  const directory = await mkdtemp(path.join(tmpdir(), "dev-bootstrap-receipt-"));
  const receiptFile = path.join(directory, "dev-preview-renderer-receipt.json");
  const account = "0123456789abcdef0123456789abcdef";
  const image = `registry.cloudflare.com/${account}/synthetic-renderer@sha256:${"d".repeat(64)}`;
  const sourceSha = "a".repeat(40), priorSha = "b".repeat(40);
  const startedAt = "2026-11-02T08:00:00.000Z", releaseStartedAt = "2026-11-01T08:00:00.000Z";
  const operationId = "dev-renderer-7", verificationMode = "provider-and-paused-control";
  const result = { status, attempt: { rendererSha: sourceSha, operationId, startedAt,
    prior: { image, provider: { image }, component: { provider: { image } } } },
    recoveryProvider: { image }, unexpectedFutureField: image,
    ...(complete ? { receipt: { state: "bootstrap-paused", sourceSha: status === "restored-paused" ? priorSha : sourceSha,
      verificationMode, operationId, releaseStartedAt, provider: { image }, unexpectedFutureField: image } } : {}) };
  const error = Object.assign(new Error(image), status ? { bootstrapReceipt: result } : {});
  try {
    const write = retainDevPreviewBootstrapReceipt(receiptFile, async () => {
      if (failure) throw error;
      return result;
    });
    if (failure) await expect(write).rejects.toBe(error);
    else await write;
    const text = await readFile(receiptFile, "utf8");
    const projected = { status, sourceSha: complete && status === "restored-paused" ? priorSha : sourceSha, operationId, startedAt,
      ...(complete ? { state: "bootstrap-paused", verificationMode, imageDigest: `sha256:${"d".repeat(64)}`, releaseStartedAt } : {}) };
    expect(JSON.parse(text)).toEqual(failure ? { status: "refused", ...(status ? { bootstrap: projected } : {}) } : projected);
    for (const excluded of [account, "registry.cloudflare.com", image, '"provider"', '"prior"', "recoveryProvider", "unexpectedFutureField"]) {
      expect(text).not.toContain(excluded);
    }
    expect((await stat(receiptFile)).mode & 0o777).toBe(0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
