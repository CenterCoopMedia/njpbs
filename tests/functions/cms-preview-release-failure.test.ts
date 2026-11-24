import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CloudPreviewProviderReadError, describeCloudPreviewReleaseFailure, releaseCredentials, readCloudPreviewRollouts, releaseSecretsFor, retryCloudPreviewRead, retryWrangler, waitForCloudPreviewStartup, wrangler } from "../../site/scripts/deploy-cms-preview-cloud";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const prepared = { wrangler: "/fixture/wrangler.mjs", configPath: "/fixture/wrangler.json", source: "/fixture" };

function childProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

describe("Wrangler failure summaries", () => {
  it.each([
    ["ERROR: failed to solve: Dockerfile build failed", "image_build"],
    ["ERROR: failed to push image to registry", "registry_push"],
    ["ERROR: rollout failed", "rollout"],
    ["Authentication error: invalid API token", "authentication"],
    ["Unrecognized provider failure", "unknown"],
  ])("classifies %s without exposing provider output", async (output, failureClass) => {
    vi.useFakeTimers();
    const child = childProcess();
    const result = wrangler(prepared, ["deploy"], "synthetic-token").catch(error => error);
    child.stdout.write("Request details: synthetic-token https://private.example.test\n");
    child.stderr.write(output.slice(0, 8));
    child.stderr.write(`${output.slice(8)}\nprivate provider request`);
    await vi.advanceTimersByTimeAsync(2_500);
    child.emit("close", 1, null);
    expect(describeCloudPreviewReleaseFailure(await result)).toBe(
      `Error: Cloud preview Wrangler image deploy failed (exit=1, signal=none, elapsed=2.5s, class=${failureClass})`,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [["secret", "bulk"], "secret bulk"],
    [["deploy", "--containers-rollout=none"], "worker-only deploy"],
  ])("names the %s operation and termination signal", async (args, operation) => {
    vi.useFakeTimers();
    const child = childProcess();
    const result = wrangler(prepared, args, "synthetic-token", "synthetic-secret").catch(error => error);
    child.emit("close", null, "SIGTERM");
    expect(describeCloudPreviewReleaseFailure(await result)).toBe(
      `Error: Cloud preview Wrangler ${operation} failed (exit=none, signal=SIGTERM, elapsed=0.0s, class=unknown)`,
    );
  });

  it("does not expose a child process start error", async () => {
    vi.useFakeTimers();
    const child = childProcess();
    const result = wrangler(prepared, ["deploy"], "synthetic-token").catch(error => error);
    child.emit("error", new Error("synthetic-token private arguments"));
    expect(describeCloudPreviewReleaseFailure(await result)).toBe(
      "Error: Cloud preview Wrangler image deploy failed (exit=none, signal=none, elapsed=0.0s, class=unknown)",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("kills a hung image deploy at 15 minutes and ignores a later close", async () => {
    vi.useFakeTimers();
    const child = childProcess();
    const result = wrangler(prepared, ["deploy"], "synthetic-token").catch(error => error);
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", 0, null);
    expect(describeCloudPreviewReleaseFailure(await result)).toBe(
      "Error: Cloud preview Wrangler image deploy failed (exit=none, signal=SIGKILL, elapsed=900.0s, class=timeout)",
    );
  });

  it("clears the image deadline on success", async () => {
    vi.useFakeTimers();
    const child = childProcess();
    const result = wrangler(prepared, ["deploy"], "synthetic-token");
    child.emit("close", 0, null);
    await expect(result).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(["There is no container instance that can be provided to this Durable Object", "Placement failed: no capacity"])(
    "stops immediately on %s across chunks and keeps provider output private", async output => {
      vi.useFakeTimers();
      const child = childProcess();
      const result = wrangler(prepared, ["deploy"], "synthetic-token").catch(error => error);
      child.stderr.write("private request synthetic-token\n" + output.slice(0, 9));
      expect(child.kill).not.toHaveBeenCalled();
      child.stderr.write(output.slice(9));
      const failure = await result;
      expect(failure.name).toBe("CloudPreviewPlacementError");
      expect(failure.message).toContain("Keep previews paused");
      expect(failure.message).toContain("new full CMS staging deploy");
      expect(failure.message).not.toContain("synthetic-token");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      child.emit("close", 0, null);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("kills Wrangler and its Docker process group on Linux", async () => {
    vi.useFakeTimers();
    const child = Object.assign(childProcess(), { pid: 123456 });
    const killGroup = vi.spyOn(process, "kill").mockReturnValue(true);
    const result = wrangler(prepared, ["deploy"], "synthetic-token").catch(error => error);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(killGroup).toHaveBeenCalledWith(-123456, "SIGKILL");
    expect(describeCloudPreviewReleaseFailure(await result)).toContain("class=timeout");
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe("cloud preview target startup deadline", () => {
  const sha = "a".repeat(40);
  const starting = { schemaVersion: 1, rendererSha: sha, serializerId: "cloudflare-preview", phase: "starting" };
  const rollout = { id: "current-rollout", created_at: "2026-10-28T09:54:30Z", status: "progressing",
    health: { errors: [], instances: { healthy: 0, active: 0, assigned: 0 } },
    progress: { version_distribution: { target_version_instances: 0, current_version_instances: 0 } } };

  function fixture(rows: unknown = [rollout]) {
    let elapsed = 0;
    return { now: () => elapsed,
      sleep: vi.fn(async (ms: number) => { elapsed += ms; }),
      readControl: vi.fn(async () => starting), readRollouts: vi.fn(async () => rows),
      readApplication: vi.fn(async () => ({ id: "application", active_rollout_id: null as string | null,
        health: { instances: { healthy: 0 } } })) };
  }

  it("stops a zero-healthy rollout at 180 seconds, without waiting 20 minutes", async () => {
    const deps = fixture();
    await expect(waitForCloudPreviewStartup(sha, deps)).rejects.toMatchObject({ name: "CloudPreviewZeroHealthyError" });
    expect(deps.now()).toBe(180_000);
    expect(deps.sleep).toHaveBeenCalledTimes(18);
  });

  it.each([0, 1])("does not count application health as target health while old instances remain (target=%s)", async targetCount => {
    const deps = fixture([{ ...rollout, health: { instances: { healthy: 1 } },
      progress: { version_distribution: { target_version_instances: targetCount, current_version_instances: 1 } } }]);
    deps.readApplication.mockResolvedValue({ id: "application", active_rollout_id: null, health: { instances: { healthy: 1 } } });
    await expect(waitForCloudPreviewStartup(sha, deps)).rejects.toMatchObject({ name: "CloudPreviewZeroHealthyError" });
  });

  it("does not extend startup for a target that is assigned but has zero healthy instances", async () => {
    const deps = fixture([{ ...rollout, health: { instances: { healthy: 0, assigned: 1 } },
      progress: { version_distribution: { target_version_instances: 1, current_version_instances: 0 } } }]);
    await expect(waitForCloudPreviewStartup(sha, deps)).rejects.toMatchObject({ name: "CloudPreviewZeroHealthyError" });
    expect(deps.now()).toBe(180_000);
  });

  it("reads more than 100 historical rollouts using the provider's limit/last cursor", async () => {
    const rows = Array.from({ length: 102 }, (_, index) => ({ ...rollout, id: `rollout-${index}` }));
    const readPage = vi.fn(async (query: string) => query === "?limit=100" ? rows.slice(0, 100) : rows.slice(100));
    expect(await readCloudPreviewRollouts(readPage)).toEqual(rows);
    expect(readPage.mock.calls).toEqual([["?limit=100"], ["?limit=100&last=rollout-99"]]);
  });

  it("rejects repeated pages rather than scanning indefinitely or accepting partial history", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ ...rollout, id: `rollout-${index}` }));
    const readPage = vi.fn(async () => rows);
    await expect(readCloudPreviewRollouts(readPage)).rejects.toThrow("pagination is incomplete");
    expect(readPage).toHaveBeenCalledTimes(2);
  });

  it.each(["VMFailed", "VMFailedToStart", "RuntimeStartFailed", "NetworkingIPAssignmentFailed"])(
    "fails immediately on the target's %s event without printing its message", async name => {
      const deps = fixture([{ ...rollout, health: { errors: [{ event: { name, message: "private provider details" } }] } }]);
      const failure = await waitForCloudPreviewStartup(sha, deps).catch(error => error);
      expect(failure.name).toBe("CloudPreviewPlacementError");
      expect(failure.message).not.toContain("private provider details");
      expect(deps.sleep).not.toHaveBeenCalled();
    },
  );

  it("detects the no-instance error in target rollout health", async () => {
    const deps = fixture([{ ...rollout, health: { errors: [{ event: {
      message: "There is no container instance that can be provided to this Durable Object" } }] } }]);
    await expect(waitForCloudPreviewStartup(sha, deps)).rejects.toMatchObject({ name: "CloudPreviewPlacementError" });
  });

  it("ignores historical rollout errors and preserves exact ready verification", async () => {
    const stale = { ...rollout, id: "previous-rollout", status: "reverted", health: { errors: [{ event: { name: "VMFailed" } }] } };
    const deps = fixture([stale, rollout]);
    deps.readControl.mockImplementation(async () => deps.now() >= 120_000 ? { ...starting, phase: "ready" } : starting);
    await expect(waitForCloudPreviewStartup(sha, { ...deps, previousRolloutIds: [stale.id] })).resolves.toBeUndefined();
    expect(deps.now()).toBe(120_000);
  });

  it("allows a healthy target to await its exact readiness attestation beyond 180 seconds", async () => {
    const deps = fixture([{ ...rollout, health: { instances: { healthy: 1, active: 0, assigned: 0 } },
      progress: { version_distribution: { target_version_instances: 1, current_version_instances: 0 } } }]);
    deps.readApplication.mockResolvedValue({ id: "application", active_rollout_id: null, health: { instances: { healthy: 1 } } });
    deps.readControl.mockImplementation(async () => deps.now() >= 240_000 ? { ...starting, phase: "ready" } : starting);
    await expect(waitForCloudPreviewStartup(sha, deps)).resolves.toBeUndefined();
    expect(deps.now()).toBe(240_000);
  });

  it("does not extend the deadline using a stale healthy rollout when fresh application health is zero", async () => {
    const deps = fixture([{ ...rollout, health: { instances: { healthy: 1 } },
      progress: { version_distribution: { target_version_instances: 1, current_version_instances: 0 } } }]);
    await expect(waitForCloudPreviewStartup(sha, deps)).rejects.toMatchObject({ name: "CloudPreviewZeroHealthyError" });
  });

  it("allows a previously healthy target to recover from a brief zero count while attesting ready", async () => {
    const deps = fixture([{ ...rollout, progress: { version_distribution: { target_version_instances: 1, current_version_instances: 0 } } }]);
    deps.readApplication.mockImplementation(async () => ({ id: "application", active_rollout_id: null,
      health: { instances: { healthy: deps.now() < 170_000 ? 1 : 0 } } }));
    deps.readControl.mockImplementation(async () => deps.now() >= 240_000 ? { ...starting, phase: "ready" } : starting);
    await expect(waitForCloudPreviewStartup(sha, deps)).resolves.toBeUndefined();
    expect(deps.now()).toBe(240_000);
  });

  it.each([undefined, "1970-01-01T00:00:01Z"])("does not let retained errors override later healthy observations: %s", async time => {
    const deps = fixture([{ ...rollout, health: { errors: [{ event: { name: "VMFailed", time } }] },
      progress: { version_distribution: { target_version_instances: 1, current_version_instances: 0 } } }]);
    deps.readApplication.mockImplementation(async () => ({ id: "application", active_rollout_id: null,
      health: { instances: { healthy: deps.now() < 170_000 ? 1 : 0 } } }));
    deps.readControl.mockImplementation(async () => deps.now() >= 240_000 ? { ...starting, phase: "ready" } : starting);
    await expect(waitForCloudPreviewStartup(sha, deps)).resolves.toBeUndefined();
    expect(deps.now()).toBe(240_000);
  });

  it("still bounds persistent zero health after an initially healthy target", async () => {
    const deps = fixture([{ ...rollout, progress: { version_distribution: { target_version_instances: 1, current_version_instances: 0 } } }]);
    deps.readApplication.mockImplementation(async () => ({ id: "application", active_rollout_id: null,
      health: { instances: { healthy: deps.now() < 170_000 ? 1 : 0 } } }));
    await expect(waitForCloudPreviewStartup(sha, deps)).rejects.toMatchObject({ name: "CloudPreviewZeroHealthyError" });
    expect(deps.now()).toBe(340_000);
  });

  it("rechecks exact ready at the health failure boundary", async () => {
    const deps = fixture();
    let attested = false;
    deps.readApplication.mockImplementation(async () => {
      if (deps.now() >= 180_000) attested = true;
      return { id: "application", active_rollout_id: null, health: { instances: { healthy: 0 } } };
    });
    deps.readControl.mockImplementation(async () => attested ? { ...starting, phase: "ready" } : starting);
    await expect(waitForCloudPreviewStartup(sha, deps)).resolves.toBeUndefined();
    expect(deps.now()).toBe(180_000);
  });

  it("allows a healthy same-image retry with no new rollout to attest exact ready", async () => {
    const deps = fixture();
    deps.readApplication.mockResolvedValue({ id: "application", active_rollout_id: null, health: { instances: { healthy: 1 } } });
    deps.readControl.mockImplementation(async () => deps.now() >= 240_000 ? { ...starting, phase: "ready" } : starting);
    await expect(waitForCloudPreviewStartup(sha, { ...deps, previousRolloutIds: [rollout.id] })).resolves.toBeUndefined();
    expect(deps.now()).toBe(240_000);
  });

  it("still stops a same-image retry's active zero-healthy rollout after 180 seconds", async () => {
    const deps = fixture();
    deps.readApplication.mockResolvedValue({ id: "application", active_rollout_id: rollout.id, health: { instances: { healthy: 0 } } });
    await expect(waitForCloudPreviewStartup(sha, { ...deps, previousRolloutIds: [rollout.id] }))
      .rejects.toMatchObject({ name: "CloudPreviewZeroHealthyError" });
    expect(deps.now()).toBe(180_000);
  });

  it("lets a same-image retry recover despite an undated retained error on its active rollout", async () => {
    const deps = fixture([{ ...rollout, health: { errors: [{ event: { name: "VMFailed" } }], instances: { healthy: 0 } } }]);
    deps.readApplication.mockResolvedValue({ id: "application", active_rollout_id: rollout.id, health: { instances: { healthy: 0 } } });
    deps.readControl.mockImplementation(async () => deps.now() >= 120_000 ? { ...starting, phase: "ready" } : starting);
    await expect(waitForCloudPreviewStartup(sha, { ...deps, previousRolloutIds: [rollout.id] })).resolves.toBeUndefined();
  });

  it("uses fresh application health rather than retained fallback rollout health", async () => {
    const deps = fixture([{ ...rollout, health: { errors: [{ event: { name: "VMFailed" } }], instances: { healthy: 0 } },
      progress: { version_distribution: { target_version_instances: 1, current_version_instances: 0 } } }]);
    deps.readApplication.mockResolvedValue({ id: "application", active_rollout_id: rollout.id, health: { instances: { healthy: 1 } } });
    deps.readControl.mockImplementation(async () => deps.now() >= 240_000 ? { ...starting, phase: "ready" } : starting);
    await expect(waitForCloudPreviewStartup(sha, { ...deps, previousRolloutIds: [rollout.id] })).resolves.toBeUndefined();
    expect(deps.now()).toBe(240_000);
  });

  it("still detects a fresh placement event on the reused active rollout", async () => {
    const deps = fixture([{ ...rollout, health: { errors: [{ event: { name: "VMFailed", time: "1970-01-01T00:00:01Z" } }] } }]);
    deps.readApplication.mockResolvedValue({ id: "application", active_rollout_id: rollout.id, health: { instances: { healthy: 0 } } });
    await expect(waitForCloudPreviewStartup(sha, { ...deps, previousRolloutIds: [rollout.id] }))
      .rejects.toMatchObject({ name: "CloudPreviewPlacementError" });
  });

  it("preserves first-application cron propagation only when there is no rollout", async () => {
    const deps = fixture([]);
    deps.readControl.mockImplementation(async () => deps.now() >= 15 * 60_000 ? { ...starting, phase: "ready" } : starting);
    await expect(waitForCloudPreviewStartup(sha, { ...deps, firstApplication: true })).resolves.toBeUndefined();
    expect(deps.now()).toBe(15 * 60_000);
    const stalled = fixture();
    await expect(waitForCloudPreviewStartup(sha, { ...stalled, firstApplication: true }))
      .rejects.toMatchObject({ name: "CloudPreviewZeroHealthyError" });
  });

  it("fails closed on missing, unreadable or incomplete rollout metadata", async () => {
    for (const rows of [null, {}, [{ ...rollout, created_at: "invalid" }], Array(100).fill(rollout)]) {
      await expect(waitForCloudPreviewStartup(sha, fixture(rows))).rejects.toThrow("rollout metadata is incomplete");
    }
    const deps = fixture();
    deps.readRollouts.mockRejectedValue(new Error("fixed provider read failure"));
    await expect(waitForCloudPreviewStartup(sha, deps)).rejects.toThrow("fixed provider read failure");
  });

  it("does not restore ready or wait when control identity changes or admission is paused", async () => {
    for (const control of [{ ...starting, rendererSha: "b".repeat(40) }, { ...starting, phase: "paused" }]) {
      const deps = fixture();
      deps.readControl.mockResolvedValue(control);
      await expect(waitForCloudPreviewStartup(sha, deps)).rejects.toThrow("identity changed");
      expect(deps.readRollouts).not.toHaveBeenCalled();
    }
  });

  it("tolerates one transient health read failure before the exact renderer attests ready", async () => {
    const deps = fixture();
    deps.readRollouts.mockRejectedValueOnce(new CloudPreviewProviderReadError());
    deps.readControl.mockImplementation(async () => deps.now() >= 120_000 ? { ...starting, phase: "ready" } : starting);
    await expect(waitForCloudPreviewStartup(sha, deps)).resolves.toBeUndefined();
    expect(deps.now()).toBe(120_000);
  });

  it("bounds persistently unavailable health without claiming a known zero-healthy count", async () => {
    const deps = fixture();
    deps.readRollouts.mockRejectedValue(new CloudPreviewProviderReadError());
    await expect(waitForCloudPreviewStartup(sha, deps)).rejects.toMatchObject({ name: "CloudPreviewProviderReadError",
      message: expect.stringContaining("Keep previews paused") });
    expect(deps.now()).toBe(180_000);
  });

  it("keeps preflight read errors free of a startup pause/recovery claim", () => {
    expect(new CloudPreviewProviderReadError().message).toBe("Container health could not be read.");
  });

  it("keeps first-cron propagation tolerant of a transient read error after three minutes", async () => {
    const deps = fixture([]);
    let failed = false;
    deps.readRollouts.mockImplementation(async () => {
      if (deps.now() >= 780_000 && !failed) { failed = true; throw new CloudPreviewProviderReadError(); }
      return [];
    });
    deps.readControl.mockImplementation(async () => deps.now() >= 900_000 ? { ...starting, phase: "ready" } : starting);
    await expect(waitForCloudPreviewStartup(sha, { ...deps, firstApplication: true })).resolves.toBeUndefined();
    expect(failed).toBe(true);
    expect(deps.now()).toBe(900_000);
  });
});

describe("cloud preview release failure line", () => {
  it("prints the error class and message without credential text", () => {
    const token = "cf-token-value-0123456789";
    const account = `{"private_key":"${"A".repeat(40)}"}`;
    const storage = `{"secretAccessKey":"${"B".repeat(40)}"}`;
    const error = new TypeError(`Pause failed near ${token} and ${account}\nand ${storage}`);
    const line = describeCloudPreviewReleaseFailure(error, [token, account, storage]);
    expect(line).toBe("TypeError: Pause failed near [redacted] and [redacted] and [redacted]");
    expect(line).not.toContain(token);
    expect(line).not.toContain("private_key");
    expect(line).not.toContain("secretAccessKey");
    expect(line).not.toContain("\n");
  });

  it("redacts a parsed credential part quoted without its JSON", () => {
    const privateKey = `-----BEGIN PRIVATE KEY-----
${"K".repeat(64)}
-----END PRIVATE KEY-----
`;
    const account = JSON.stringify({ type: "service_account", private_key_id: "f".repeat(40), private_key: privateKey });
    const storage = JSON.stringify({ accessKeyId: "A".repeat(20), secretAccessKey: "S".repeat(40) });
    const secrets = releaseSecretsFor(account, storage, "cf-token-value-0123456789");
    const error = new Error(`Key ${privateKey} id ${"f".repeat(40)} access ${"A".repeat(20)} secret ${"S".repeat(40)}`);
    const line = describeCloudPreviewReleaseFailure(error, secrets);
    expect(line).toBe("Error: Key [redacted] id [redacted] access [redacted] secret [redacted]");
  });

  it("keeps the raw inputs when a credential does not parse", () => {
    expect(releaseSecretsFor("not json", "also not json", "token-value")).toEqual(["not json", "also not json", "token-value"]);
  });

  it("does not stringify a non-Error throw", () => {
    expect(describeCloudPreviewReleaseFailure({ private_key: "secret-value" }, [])).toBe(
      "Error: Unknown cloud preview release failure",
    );
  });
});


describe("Wrangler retries", () => {
  const run = (exits: (child: ReturnType<typeof childProcess>) => void) => {
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      setImmediate(() => exits(child as ReturnType<typeof childProcess>));
      return child as unknown as ReturnType<typeof spawn>;
    });
    const wait = vi.fn().mockResolvedValue(undefined);
    return { wait, result: retryWrangler(prepared, ["deploy"], "synthetic-token", undefined, { wait, log: vi.fn() }) };
  };
  it("deploys again after an unknown provider failure", async () => {
    let attempt = 0;
    const { result } = run(child => { child.stderr.write("Unrecognized provider failure"); setImmediate(() => child.emit("close", attempt++ ? 0 : 1, null)); });
    await expect(result).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(2);
  });
  it("does not repeat a refused credential", async () => {
    const { wait, result } = run(child => { child.stderr.write("Authentication error: invalid API token"); setImmediate(() => child.emit("close", 1, null)); });
    await expect(result).rejects.toThrow("class=authentication");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });
});

describe("pre-mutation Containers reads", () => {
  it("returns a successful third read after two transient failures", async () => {
    const read = vi.fn().mockRejectedValueOnce(new CloudPreviewProviderReadError())
      .mockRejectedValueOnce(new CloudPreviewProviderReadError()).mockResolvedValue("verified");
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect(await retryCloudPreviewRead(read, { wait: sleep })).toBe("verified");
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("does not defer invalid metadata, authorization or identity failures", async () => {
    const failure = new Error("invalid provider metadata");
    const read = vi.fn().mockRejectedValue(failure);
    const sleep = vi.fn();
    await expect(retryCloudPreviewRead(read, { wait: sleep })).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("renderer release credentials", () => {
  const dev = { CMS_TARGET: "development", CMS_DEV_ADMIN_ORIGIN: "https://dev-admin.njpbs.org", CMS_DEV_API_ORIGIN: "https://dev-cms-api.njpbs.org",
    CMS_DEV_PUBLIC_ORIGIN: "https://dev.njpbs.org", CMS_DEV_MEDIA_ORIGIN: "https://dev-media.njpbs.org",
    CMS_DEV_API_WORKER: "njpbs-dev-cms-api", CMS_DEV_PREVIEW_RENDERER: "njpbs-dev-cms-preview-renderer", CMS_DEV_ADMIN_PAGES: "njpbs-dev-admin" };
  const full = { CMS_PREVIEW_FIREBASE_ACCOUNT: "account", CMS_PREVIEW_R2_CREDENTIAL: "storage", CLOUDFLARE_API_TOKEN: "token",
    CMS_DEV_ACCESS_CLIENT_ID: "client", CMS_DEV_ACCESS_CLIENT_SECRET: "secret" };

  it("refuses a missing dev secret by its development name", () => {
    for (const [name, secret] of [["CMS_PREVIEW_FIREBASE_ACCOUNT", "CMS_DEV_PREVIEW_FIREBASE_ACCOUNT"],
      ["CMS_PREVIEW_R2_CREDENTIAL", "CMS_DEV_PREVIEW_R2_CREDENTIAL"], ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_DEV_PREVIEW_RENDERER_TOKEN"],
      ["CMS_DEV_ACCESS_CLIENT_SECRET", "CMS_DEV_ACCESS_CLIENT_SECRET"]]) {
      expect(() => releaseCredentials({ ...dev, ...full, [name]: "" }), name).toThrow(`${secret} is required for a development renderer release`);
    }
  });

  it("takes and clears the dev Access client only on development", () => {
    const env: NodeJS.ProcessEnv = { ...dev, ...full };
    expect(releaseCredentials(env)).toEqual({ rawAccount: "account", rawStorage: "storage", token: "token",
      publicationAccess: { clientId: "client", clientSecret: "secret" } });
    expect(Object.keys(full).filter(name => name in env)).toEqual([]);
    const production: NodeJS.ProcessEnv = { ...full, CLOUDFLARE_API_TOKEN: "" };
    expect(releaseCredentials(production)).toEqual({ rawAccount: "account", rawStorage: "storage", token: "", publicationAccess: undefined });
    expect(production.CMS_DEV_ACCESS_CLIENT_ID).toBe("client");
  });
});
