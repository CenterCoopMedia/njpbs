import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { currentCodeFixture } from "../preview-renderer/current-code-fixture";
import { checkDevCurrentCode } from "../scripts/check-dev-current-code.mjs";

it("proves both native CODE methods against the same retained publication and actual bytes", async () => {
  const fixture = await currentCodeFixture(); const modes: string[] = [];
  const request = async (input: string, options: RequestInit) => {
    expect(input).toBe("https://dev-api.example.org/_internal/record-code");
    const body = JSON.parse(String(options.body)); modes.push(body.mode);
    expect(options.method).toBe("POST"); expect(options.redirect).toBe("manual");
    expect(body.rendererSha).toBe(fixture.rendererSha);
    return Response.json({ schemaVersion: 1, kind: body.mode, reference: fixture.code.reference,
      ...(body.mode === "current-code" ? { bytes: Buffer.from(JSON.stringify(fixture.code.input)).toString("base64") } : {}) });
  };
  const result = await checkDevCurrentCode({ rendererSha: fixture.rendererSha, readSecret: () => "synthetic-edge-credential", request });
  expect(modes).toEqual(["current-code-reference", "current-code"]);
  expect(result).toMatchObject({ projectId: "njpbs-site-dev", rendererSha: fixture.rendererSha, referenceRead: true, codeRead: true,
    publication: fixture.code.reference.publication, codeDigest: fixture.code.reference.manifest.sha256 });
  expect(JSON.stringify(result)).not.toContain("synthetic-edge-credential");
  expect(Object.hasOwn(result, "bytes")).toBe(false);
});

it.each(["rpc-503", "reference-race", "corrupt-body"])("refuses %s instead of admitting enrollment", async kind => {
  const fixture = await currentCodeFixture();
  const request = async (_input: string, options: RequestInit) => {
    const mode = JSON.parse(String(options.body)).mode;
    if (kind === "rpc-503") return Response.json({ error: "Current CODE source is unavailable" }, { status: 503 });
    const reference = structuredClone(fixture.code.reference);
    if (kind === "reference-race" && mode === "current-code") reference.publication.artifactDigest = "e".repeat(64);
    const bytes = Buffer.from(JSON.stringify(fixture.code.input));
    if (kind === "corrupt-body") bytes[0] ^= 1;
    return Response.json({ schemaVersion: 1, kind: mode, reference,
      ...(mode === "current-code" ? { bytes: bytes.toString("base64") } : {}) });
  };
  await expect(checkDevCurrentCode({ rendererSha: fixture.rendererSha, readSecret: () => "synthetic-edge-credential", request })).rejects.toThrow();
});

it("refuses malformed CLI input before opening a missing credential pipe and withholds input details", () => {
  let stderr = "";
  try { execFileSync(process.execPath, ["scripts/check-dev-current-code.mjs", "--renderer-sha", "private-untrusted-input"], { stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error: any) { stderr = error.stderr.toString(); }
  expect(JSON.parse(stderr)).toEqual({ status: "refused", code: "development-code-preflight-failed" });
});
