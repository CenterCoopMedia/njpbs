import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import releaseWait from "../../functions/lib/release-wait.js";
import { ABSENT_EXIT, httpFault, main, permanentFailure, providerCall, providerCallSync, providerGcloud, providerJson } from "../../scripts/lib/provider-call.mjs";

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
