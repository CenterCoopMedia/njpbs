// @vitest-environment node

import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCmsPublicationBuild } from "../scripts/run-cms-publication-build";
import { safeExternalErrorIdentity } from "../scripts/cms-publication-error-identity";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function buildChild() {
  const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
  vi.mocked(spawn).mockReturnValueOnce(child as ReturnType<typeof spawn>);
  return child;
}

describe("publication build process boundary", () => {
  it("waits for the child to exit and keeps the supplied environment out of the parent", async () => {
    vi.stubEnv("CMS_PREVIEW_PAGE_ID", "ambient-preview");
    const child = buildChild();
    const completed = vi.fn();
    const pending = runCmsPublicationBuild({
      CMS_CONTENT_MODE: "published",
      CMS_PREVIEW_PAGE_ID: undefined,
      GOOGLE_APPLICATION_CREDENTIALS: "/run/credentials/fixture/firebase",
    }).then(completed);

    const [command, args, options] = vi.mocked(spawn).mock.calls.at(-1)!;
    expect(command).toBe(process.execPath);
    expect(args).toEqual([
      "--require",
      fileURLToPath(new URL("../scripts/cms-publication-build-signals.cjs", import.meta.url)),
      "--import",
      fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url)),
      fileURLToPath(new URL("../scripts/run-cms-publication-build.ts", import.meta.url)),
    ]);
    expect(options).toMatchObject({
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        CMS_CONTENT_MODE: "published",
        CMS_PREVIEW_PAGE_ID: undefined,
        GOOGLE_APPLICATION_CREDENTIALS: "/run/credentials/fixture/firebase",
      },
      stdio: ["ignore", "inherit", "pipe"],
    });
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    expect(process.env.CMS_PREVIEW_PAGE_ID).toBe("ambient-preview");
    child.emit("close", 0, null);
    await pending;
    expect(completed).toHaveBeenCalledOnce();
  });

  it.each([[1, null], [null, "SIGKILL"]])("rejects failed or interrupted builds: %s %s", async (code, signal) => {
    const child = buildChild();
    const pending = runCmsPublicationBuild({});
    child.emit("close", code, signal);
    await expect(pending).rejects.toThrow("The CMS publication build child failed");
  });

  it("redacts process startup errors", async () => {
    const child = buildChild();
    const pending = runCmsPublicationBuild({});
    child.emit("error", new Error("private process diagnostic"));
    child.emit("close", -2, null);
    await expect(pending).rejects.toThrow("The CMS publication build child failed");
  });

  it("retains a safe identity split across child stderr chunks", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const child = buildChild();
    const pending = runCmsPublicationBuild({});
    child.stderr.emit("data", Buffer.from("ordinary build log\nCMS publication build failed: code E"));
    child.stderr.emit("data", Buffer.from("NOENT\n"));
    child.emit("close", 1, null);
    await expect(pending).rejects.toMatchObject({
      message: "The CMS publication build child failed",
      code: "ENOENT",
    });
  });

  it.each([
    "name FirebaseError, code private-code",
    "name PrivateError, code ENOENT",
    `code ${"E".repeat(600)}`,
  ])("rejects an unapproved or oversized child identity: %s", async (identity) => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const child = buildChild();
    const pending = runCmsPublicationBuild({});
    child.stderr.emit("data", Buffer.from(`CMS publication build failed: ${identity}\n`));
    child.emit("close", 1, null);
    await expect(pending).rejects.toMatchObject({
      message: "The CMS publication build child failed",
    });
    await pending.catch(error => {
      expect(safeExternalErrorIdentity(error)).toBeNull();
      expect(error).not.toHaveProperty("code");
    });
  });

  it("ignores the rest of an oversized stderr line across chunks", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const child = buildChild();
    const pending = runCmsPublicationBuild({});
    child.stderr.emit("data", Buffer.from("x".repeat(600)));
    child.stderr.emit("data", Buffer.from("CMS publication build failed: code ENOENT\n"));
    child.emit("close", 1, null);
    await expect(pending).rejects.toMatchObject({
      message: "The CMS publication build child failed",
    });
    await pending.catch(error => {
      expect(safeExternalErrorIdentity(error)).toBeNull();
      expect(error).not.toHaveProperty("code");
    });
  });

  it.each(["SIGTERM", "SIGINT"] as const)("drains when %s arrives during loader initialization", async (signal) => {
    const directory = mkdtempSync(fileURLToPath(new URL("../.build-signal-", import.meta.url)));
    const loader = `${directory}/loader.mjs`;
    const main = `${directory}/build.mjs`;
    const gate = `${directory}/gate`;
    writeFileSync(gate, "waiting");
    writeFileSync(loader, `
      import { watch } from "node:fs";
      await new Promise((resolve) => {
        const watcher = watch(${JSON.stringify(gate)}, () => {
          watcher.close();
          resolve();
        });
        process.stdout.write("loader waiting\\n");
      });
    `);
    writeFileSync(main, 'process.stdout.write("build completed\\n");');
    const { spawn: realSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    let child!: ReturnType<typeof realSpawn>;
    vi.mocked(spawn).mockImplementationOnce((command, args, options) => {
      child = realSpawn(command, (args as string[]).map((arg) => {
        if (arg.endsWith("/tsx/dist/loader.mjs")) return loader;
        if (arg.endsWith("/run-cms-publication-build.ts")) return main;
        return arg;
      }), { ...options, env: {}, stdio: ["ignore", "pipe", "pipe"] });
      return child;
    });
    const pending = runCmsPublicationBuild({}).then(() => true, () => false);
    const closed = once(child, "close");
    let output = "";
    child.stdout!.on("data", (data) => { output += String(data); });
    try {
      await once(child.stdout!, "data", { signal: AbortSignal.timeout(5_000) });
      expect(output).toContain("loader waiting");
      expect(child.kill(signal)).toBe(true);
      // Keep module initialization gated until the OS has delivered the signal.
      await delay(50);
      writeFileSync(gate, "resume");
      expect(await pending).toBe(true);
      expect(output).toContain("build completed");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['new FirebaseError({ code: "permission-denied", message: detail })',
      "name FirebaseError, code permission-denied"],
    ['new FirebaseError({ code: "firestore/permission-denied", message: detail })',
      "name FirebaseError, code firestore/permission-denied"],
    ['new GoogleError(detail, 7)', "name GoogleError, code PERMISSION_DENIED"],
    ['Object.assign(new Error(detail), { code: "ENOENT" })', "code ENOENT"],
    ['new Error(detail)', null],
    ['Object.assign(new Error(detail), { name: "FirebaseError", code: "permission-denied" })', null],
  ])("keeps only the safe identity of a real child failure: %s", async (thrown, identity) => {
    const directory = mkdtempSync(fileURLToPath(new URL("../scripts/.build-error-", import.meta.url)));
    const entry = `${directory}.ts`;
    const build = `${directory}/build.mjs`;
    const detail = "synthetic private build detail";
    writeFileSync(build, `
      import { FirebaseError } from "firebase-admin/app";
      class GoogleError extends Error {
        constructor(message, code) { super(message); this.code = code; }
      }
      const detail = ${JSON.stringify(detail)};
      export function runBuild() { throw ${thrown}; }
    `);
    const source = readFileSync(fileURLToPath(new URL("../scripts/run-cms-publication-build.ts", import.meta.url)), "utf8");
    writeFileSync(entry, source.replace('import("./build-with-production-sync.mjs")',
      `import(${JSON.stringify(pathToFileURL(build).href)})`));
    const { spawn: realSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    let child!: ReturnType<typeof realSpawn>;
    vi.mocked(spawn).mockImplementationOnce((command, args, options) => {
      child = realSpawn(command, (args as string[]).map((arg) =>
        arg.endsWith("/run-cms-publication-build.ts") ? entry : arg),
      {
        ...options,
        // Site CI installs only this SDK; the Functions runtime resolves it via NODE_PATH.
        env: { NODE_PATH: fileURLToPath(new URL("../node_modules", import.meta.url)) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return child;
    });
    const pending = runCmsPublicationBuild({});
    const closed = once(child, "close");
    let stderr = "";
    child.stderr!.on("data", (data) => { stderr += String(data); });
    try {
      await expect(pending).rejects.toMatchObject({
        message: "The CMS publication build child failed",
      });
      await pending.catch(error => { expect(safeExternalErrorIdentity(error)).toBe(identity); });
      expect(stderr).toBe(`CMS publication build failed${identity ? `: ${identity}` : ""}\n`);
      expect(stderr).not.toContain(detail);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
      rmSync(entry, { force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
