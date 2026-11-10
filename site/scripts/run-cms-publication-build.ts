import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cmsPublicationErrorFromIdentity, safeExternalErrorIdentity } from "./cms-publication-error-identity";

const thisFile = fileURLToPath(import.meta.url);
const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const tsxLoader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
const signalPreload = fileURLToPath(new URL("./cms-publication-build-signals.cjs", import.meta.url));
const failurePrefix = "CMS publication build failed: ";

/** Keep Astro, Vite and the native search runtime out of the idle serializer. */
export async function runCmsPublicationBuild(
  environment: Record<string, string | undefined>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--require", signalPreload, "--import", tsxLoader, thisFile], {
      cwd: siteRoot,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "inherit", "pipe"],
    });
    let failure = new Error("The CMS publication build child failed");
    let pendingLine: string | null = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      const parts = chunk.toString("utf8").split("\n");
      for (let index = 0; index < parts.length; index += 1) {
        if (pendingLine !== null) {
          pendingLine += parts[index];
          if (pendingLine.length > 512) pendingLine = null;
        }
        if (index < parts.length - 1) {
          if (pendingLine?.startsWith(failurePrefix)) {
            failure = cmsPublicationErrorFromIdentity(pendingLine.slice(failurePrefix.length));
          }
          pendingLine = "";
        }
      }
    });
    child.once("error", () => reject(new Error("The CMS publication build child failed")));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(failure);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  // Preserve the same drain behavior if this entry is invoked directly.
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  void import("./build-with-production-sync.mjs")
    .then(({ runBuild }) => runBuild())
    .then(
      () => process.exit(0),
      (error: unknown) => {
        let identity: string | null = null;
        try { identity = safeExternalErrorIdentity(error); } catch {}
        const line = identity && identity.length <= 256
          ? `${failurePrefix}${identity}\n` : "CMS publication build failed\n";
        process.stderr.write(line, () => process.exit(1));
      },
    );
}
