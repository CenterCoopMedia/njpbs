import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import releaseWait from "../../functions/lib/release-wait.js";
import { ABSENT_EXIT, CALLER_REFUSED, failureText, faultCause, faultLine, httpFault, main, permanentFailure, providerCall, providerCallSync, providerGcloud, providerJson } from "../../scripts/lib/provider-call.mjs";

const options = () => ({ log: vi.fn() });
const http = (status, headers = {}) => httpFault(new Response(null, { status, headers }));
const command = stderr => Object.assign(new Error("Command failed"), { status: 1, stderr });
// Recorded from dev run 45429859229 (Nov. 24, 2026).
const secretManager503 = "Error: Request to https://secretmanager.googleapis.com/v1/projects/example-project/secrets/EXAMPLE_SECRET had HTTP Error: 503, Authentication backend unavailable.";

describe("provider call rule", () => {
  it.each(["ENOENT", "EACCES", "ENOEXEC", "E2BIG"])("ends on a program that cannot start (%s)", async code => {
    const launch = vi.fn(async () => ({ status: null, error: Object.assign(new Error("spawn"), { code, syscall: "spawn gcloud" }), stdout: "", stderr: "" }));
    await expect(main(["label", "--", "gcloud"], launch, options())).rejects.toMatchObject({ code });
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it.each([["seconds", () => "90"], ["an HTTP date", () => new Date(Date.now() + 90_000).toUTCString()]])(
    "waits at least the provider's Retry-After given as %s", async (_label, value) => {
      vi.useFakeTimers({ now: 1_800_000_000_000 });
      try {
        const call = vi.fn().mockRejectedValueOnce(http(403, { "retry-after": value() })).mockResolvedValue("answer");
        const result = providerCall("paced", call, options());
        await vi.advanceTimersByTimeAsync(88_000);
        expect(call).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(call).toHaveBeenCalledTimes(2);
        await expect(result).resolves.toBe("answer");
      } finally { vi.useRealTimers(); }
    });
  it("names the check, the provider's last line and the wanted answer while it waits", async () => {
    const { setJournal } = releaseWait, lines = [];
    setJournal(line => lines.push(line));
    try {
      const call = vi.fn().mockRejectedValueOnce(command("Error: HTTP Error: 503, Service Unavailable")).mockResolvedValue("answer");
      await expect(providerCall("Firebase rules and indexes", call, options())).resolves.toBe("answer");
    } finally { setJournal(line => console.error(JSON.stringify({ severity: "INFO", ...line }))); }
    expect(lines.find(line => line.event === "retry").problem)
      .toBe("check=Firebase rules and indexes got=Error: HTTP Error: 503, Service Unavailable want=success");
  });
  it.each([
    ["HTTP 500", http(500)], ["HTTP 503", http(503)], ["HTTP 530", http(530)], ["HTTP 408", http(408)],
    // One live smoke request of an earlier release answered 429.
    ["the smoke 429", http(429)],
    ["a rate limit sent as 403", http(403, { "retry-after": "1" })],
    ["a reset", Object.assign(new Error("reset"), { code: "ECONNRESET" })],
    ["a fetch failure", new TypeError("fetch failed", { cause: Object.assign(new Error(), { code: "ENOTFOUND" }) })],
    ["an abort", new DOMException("timed out", "TimeoutError")],
    ["an unreadable body", new SyntaxError("Unexpected end of JSON input")],
    ["the recorded Secret Manager 503", command(secretManager503)],
    ["a rate quota", command("Error: Quota exceeded for quota metric 'Requests' and limit 'Requests per minute'")],
    ["the Cloud Run regional CPU allocation", command("Quota exceeded for total allowable CPU per project per region.")],
    ["an unknown quota", command("Error: Quota exceeded for a quota this test has never seen.")],
    ["an unknown command failure", command("something new")],
  ])("repeats %s and answers the next success", async (_name, fault) => {
    const call = vi.fn().mockRejectedValueOnce(fault).mockResolvedValue("answer");
    const o = options();
    expect(await providerCall("label", call, o)).toBe("answer");
    expect(call).toHaveBeenCalledTimes(2);
    expect(o.log).not.toHaveBeenCalled();
  });

  it.each([
    ["request", http(400)], ["request", http(401)], ["request", http(403)], ["request", http(404)], ["request", http(200)], ["request", http(302)],
    ["request", Object.assign(new Error(), { $metadata: { httpStatusCode: 403 } })],
    ["permission", command("Error: Request had HTTP Error: 403, Permission 'secretmanager.secrets.get' denied on resource")],
    ["build", command("Build failed with status: FAILURE")],
    ["quota", command("Quota exceeded: daily limit")],
    ["quota", command("Error: HTTP Error: 429, Quota exceeded for quota metric 'Functions' and limit 'Functions per project'")],
    ["request", command("gh: Not Found (HTTP 404)")],
  ])("ends at once on a permanent %s fault and names it", async (kind, fault) => {
    const call = vi.fn().mockRejectedValue(fault);
    const o = options();
    await expect(providerCall("label", call, o)).rejects.toBe(fault);
    expect(call).toHaveBeenCalledTimes(1);
    expect(o.log.mock.calls[0][0]).toContain(`Provider call failed: label, class ${kind}, attempt 1, last provider line: `);
  });

  it("reads a write back before each repeat", async () => {
    const landedSecond = { ...options(), readBack: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce("landed") };
    const write = vi.fn().mockRejectedValue(http(502));
    expect(await providerCall("write", write, landedSecond)).toBe("landed");
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("reads a write back after a permanent fault", async () => {
    const last = { ...options(), readBack: vi.fn().mockResolvedValueOnce("landed") };
    expect(await providerCall("write", vi.fn().mockRejectedValue(http(400)), last)).toBe("landed");
  });

  it("keeps response bodies, headers and command output out of the final line", async () => {
    const o = options();
    const fault = Object.assign(new Error("private message"), { response: { status: 400, data: "private body", headers: { authorization: "private" } } });
    await expect(providerCall("label", () => { throw fault; }, o)).rejects.toBe(fault);
    const child = Object.assign(new Error("private arguments"), { status: 1, stdout: "private secret value", stderr: "PERMISSION_DENIED" });
    await expect(providerCall("label", () => { throw child; }, o)).rejects.toBe(child);
    expect(o.log.mock.calls.flat().join("\n")).not.toContain("private");
  });

  it("ends at once on a caller's own refusal and prints its message", async () => {
    const fault = Object.assign(new Error("method HEAD not allowed by the caller's request callback"), { code: CALLER_REFUSED });
    const o = options(), call = vi.fn().mockRejectedValue(fault);
    await expect(providerCall("label", call, o)).rejects.toBe(fault);
    expect(call).toHaveBeenCalledTimes(1);
    expect(o.log.mock.calls).toEqual([[`Provider call failed: label, class caller, attempt 1, last provider line: CALLER_REFUSED: ${fault.message}`]]);
    const sync = { ...options(), wait: vi.fn() }, syncCall = vi.fn(() => { throw fault; });
    expect(() => providerCallSync("label", syncCall, sync)).toThrow(fault);
    expect(syncCall).toHaveBeenCalledTimes(1);
    expect(sync.wait).not.toHaveBeenCalled();
    expect(sync.log.mock.calls).toEqual([[`Provider call failed: label, class caller, 1 of 5 attempts, last provider line: CALLER_REFUSED: ${fault.message}`]]);
  });

  // The last three are thrown by google-auth-library 9.15.1 and gcp-metadata 6.1.1 after a provider answered.
  it.each([
    ["an unmarked error", new Error("something new")],
    ["a TypeError", new TypeError("Cannot read properties of null (reading 'expires_in')")],
    ["a refused token refresh", new Error("Could not refresh access token.")],
    ["an unreadable subject token", new Error("Unable to parse the subject_token from the credential_source URL")],
    ["a metadata answer without its header", new Error("Invalid response from metadata service: incorrect Metadata-Flavor header.")],
  ])("repeats %s until the provider answers and keeps its message in each retry line", async (_name, fault) => {
    vi.useFakeTimers();
    const lines = [];
    releaseWait.setJournal(line => lines.push(line));
    try {
      const o = options(), call = vi.fn();
      for (let failed = 0; failed < 6; failed++) call.mockRejectedValueOnce(fault);
      call.mockResolvedValue("answer");
      const answer = providerCall("label", call, o);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await expect(answer).resolves.toBe("answer");
      expect(call).toHaveBeenCalledTimes(7);
      expect(o.log).not.toHaveBeenCalled();
      const retries = lines.filter(line => line.event === "retry");
      expect(retries).toHaveLength(6);
      for (const line of retries) expect(line.problem).toContain(fault.message);
    } finally {
      vi.useRealTimers();
      releaseWait.setJournal(line => console.error(JSON.stringify({ severity: "INFO", ...line })));
    }
  });
  it("keeps an unmarked error's message in the final line of the synchronous form", () => {
    const fault = new Error("something new"), o = { ...options(), wait: vi.fn() }, call = vi.fn(() => { throw fault; });
    expect(() => providerCallSync("label", call, o)).toThrow(fault);
    expect(call).toHaveBeenCalledTimes(5);
    expect(o.log.mock.calls[0][0]).toContain("class transient, 5 of 5 attempts");
    expect(o.log.mock.calls[0][0]).toContain(fault.message);
  });

  // The log is public, so this is the boundary: none of these may reach a line.
  const opaque = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUo";
  const hex = "0123456789abcdef0123456789abcdef";
  const account = { type: "service_account", project_id: "example-project", private_key_id: hex,
    private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n", client_email: "deploy@example-project.iam.gserviceaccount.com" };
  it.each([
    ["a bearer token", `refused authorization: Bearer ${opaque}`, [opaque]],
    ["a short bearer token", "refused Bearer abc.def", ["abc.def"]],
    ["a JWT", "token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIzNDU2Nzg5", ["eyJ", "c2lnbmF0"]],
    ["a GitHub token", "refused ghp_abcdefghijklmnopqrst0123456789", ["ghp_"]],
    ["a signed URL", `GET https://bucket.example.org/object?X-Amz-Credential=AKIAEXAMPLE&X-Amz-Signature=${hex} refused`, ["AKIA", hex, "X-Amz"]],
    ["URL credentials", "GET https://user:pass@example.org/path refused", ["user:pass"]],
    ["a service account", `bad credential ${JSON.stringify(account)}`, [hex, "BEGIN PRIVATE", "MIIE", "deploy@"]],
    ["a service account fragment", JSON.stringify(account).slice(20, 250).replaceAll("{", ""), [hex, "BEGIN PRIVATE", "MIIE"]],
    ["base64 with slashes", "bad MIIEvQIBADAN/BgkqhkiG9w0/BAQEFAASC", ["MIIE", "BAQE"]],
    ["a later line", `first\n${opaque}`, [opaque]],
    ["secret assignments", "api_key=hunter2&password: two words", ["hunter2", "two", "words"]],
    ["a cookie", "refused Cookie: a=first; b=second", ["first;", "second"]],
    ["another authorization scheme", "refused Authorization: Custom abc def", ["abc", "def"]],
  ])("keeps %s out of every line about a fault", (_name, message, secrets) => {
    const wrapped = new Error("What failed", faultCause(new Error("outer", { cause: new Error(message) })));
    for (const text of [faultLine(new Error(message)), faultLine(Object.assign(new Error(message), { code: "ENOENT" })), failureText(wrapped), inspect(wrapped, { depth: 9 }),
      faultLine({ stderr: `error ${message}`, status: 1 })]) {
      for (const secret of secrets) expect(text).not.toContain(secret);
    }
  });

  it("reports the kind, not the text, of an error that can quote private input", () => {
    const parse = () => { try { JSON.parse("private"); } catch (error) { return error; } };
    const sdk = Object.assign(new Error("private"), { code: "ECONNRESET", config: { headers: { authorization: "private" } } });
    const child = Object.assign(new Error("Command failed: tool private"), { status: 2, stdout: "private", stderr: "" });
    expect([parse(), sdk, child, http(503)].map(faultLine)).toEqual(["SyntaxError", "ECONNRESET", "exit 2", "HTTP 503"]);
  });

  it("carries a caught error's message, code and cause into the replacing error", () => {
    const missing = Object.assign(new Error("ENOENT: no such file, open 'config/example.json'"), { code: "ENOENT" });
    const replaced = new Error("Could not read it", faultCause(new Error("step two", { cause: missing })));
    expect(failureText(replaced)).toBe("Could not read it; cause: step two; cause: ENOENT: no such file, open 'config/example.json'");
    expect(failureText(new Error("Plain", { cause: new Error("not from faultCause") }))).toBe("Plain");
  });

  it("repeats a JSON read on an unaccepted status and on an unreadable body", async () => {
    const send = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(new Response("{"))
      .mockResolvedValue(Response.json({ ok: 1 }));
    expect(await providerJson("read", send, options())).toEqual({ ok: 1 });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("applies the same rule without promises, and an absent gcloud resource is final", () => {
    const wait = vi.fn();
    expect(providerCallSync("label", vi.fn().mockImplementationOnce(() => { throw http(503); }).mockReturnValue("ok"), { wait })).toBe("ok");
    expect(wait.mock.calls).toEqual([[2000]]);
    const execute = vi.fn(() => { throw command("ERROR: (gcloud.secrets) NOT_FOUND: Secret version not found"); });
    const log = vi.fn();
    expect(() => providerGcloud(["secrets", "versions", "describe"], {}, execute, { wait, log })).toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("gcloud secrets versions describe, class absent");
  });

  it("writes one answer to stdout from a workflow step", async () => {
    const launch = vi.fn().mockReturnValueOnce({ status: 1, stdout: "partial", stderr: secretManager503 }).mockReturnValue({ status: 0, stdout: "answer\n", stderr: "" });
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await main(["label", "--", "gh", "api", "path"], launch)).toBe("answer\n");
    expect(launch.mock.calls[1].slice(0, 2)).toEqual(["gh", ["api", "path"]]);
    vi.restoreAllMocks();
    const script = fileURLToPath(new URL("../../scripts/lib/provider-call.mjs", import.meta.url));
    const run = text => spawnSync(process.execPath, [script, "label", "--", "bash", "-c", text], { encoding: "utf8" });
    expect(run("printf answer")).toMatchObject({ status: 0, stdout: "answer" });
    expect(run("echo 'NOT_FOUND: absent' >&2; exit 1")).toMatchObject({ status: ABSENT_EXIT, stdout: "" });
    expect(run("echo 'PERMISSION_DENIED' >&2; echo partial; exit 1")).toMatchObject({ status: 1, stdout: "" });
  });

  it("names the call each minute while its command is silent", async () => {
    vi.useFakeTimers();
    const lines = [];
    releaseWait.setJournal(line => lines.push(line));
    try {
      let answer;
      const call = main(["silent read", "--", "gh"], () => new Promise(resolve => { answer = resolve; }));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(lines).toEqual([expect.objectContaining({ event: "waiting", what: "silent read" })]);
      answer({ status: 0, stdout: "answer", stderr: "" });
      expect(await call).toBe("answer");
    } finally {
      vi.useRealTimers();
      releaseWait.setJournal(line => console.error(JSON.stringify({ severity: "INFO", ...line })));
    }
  });

  it("does not read a rate limit as a permanent request fault", () => {
    expect(permanentFailure("gh: API rate limit exceeded (HTTP 403)")).toBeNull();
    expect(permanentFailure("gh: Resource not accessible by integration (HTTP 403)")).toBe("request");
  });
});
