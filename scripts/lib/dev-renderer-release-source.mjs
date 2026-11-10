import { repositoryMatches, workflowMatches } from "./repository-identity.mjs";
import { assertDevelopmentSource } from "../render-development-config.mjs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SHA = /^[a-f0-9]{40}$/;
const refuse = () => { throw new Error("Development renderer source refused"); };

export function devRendererReleaseMode(environment) {
  const flag = name => {
    // config-input: CMS_DEV_INSTALL_READER_BRIDGE, CMS_DEV_PRESERVE_PREVIEW_PAUSE, CMS_DEV_RELEASE_PREVIEW_RENDERER
    // config-input: CMS_DEV_RENDERER_ONLY, CMS_DEV_RESTORE_PREVIEW_BOOTSTRAP
    const value = environment[name] ?? "false";
    if (!["true", "false"].includes(value)) refuse();
    return value === "true";
  };
  const releasing = flag("CMS_DEV_RELEASE_PREVIEW_RENDERER");
  const rendererOnly = flag("CMS_DEV_RENDERER_ONLY");
  const preservePreviewPause = flag("CMS_DEV_PRESERVE_PREVIEW_PAUSE");
  const restorePreviewBootstrap = flag("CMS_DEV_RESTORE_PREVIEW_BOOTSTRAP");
  const installReaderBridge = flag("CMS_DEV_INSTALL_READER_BRIDGE");
  const sourceSha = environment.CMS_DEV_RENDERER_REQUESTED_SOURCE_SHA ?? "";
  if (rendererOnly ? !releasing || !SHA.test(sourceSha) || !preservePreviewPause : sourceSha !== "" || preservePreviewPause) refuse();
  if (restorePreviewBootstrap && (!rendererOnly || !preservePreviewPause)) refuse();
  if (rendererOnly && installReaderBridge) refuse();
  return { rendererOnly, preservePreviewPause, restorePreviewBootstrap, sourceSha: rendererOnly ? sourceSha : environment.GITHUB_SHA };
}

/** Retained source is an ancestor of the real hosted operator, never a forged event SHA. */
export function assertDevRendererReleaseSource(rendererSha, environment, repository = fileURLToPath(new URL("../..", import.meta.url))) {
  const mode = devRendererReleaseMode(environment);
  if (!mode.rendererOnly || mode.sourceSha !== rendererSha || !SHA.test(environment.GITHUB_SHA ?? "") ||
      environment.GITHUB_REF !== "refs/heads/main" || (!environment.CMS_DEPLOY_OWNER || environment.GITHUB_ACTOR !== environment.CMS_DEPLOY_OWNER) ||
      (!environment.CMS_DEPLOY_OWNER || environment.GITHUB_TRIGGERING_ACTOR !== environment.CMS_DEPLOY_OWNER) || environment.RUNNER_ENVIRONMENT !== "github-hosted" ||
      !repositoryMatches(environment.GITHUB_REPOSITORY, environment, environment.GITHUB_REPOSITORY_ID ?? "") ||
      !workflowMatches(environment.GITHUB_WORKFLOW_REF, "cms-dev-deploy.yml", environment)) refuse();
  const git = (args, trim = true) => {
    const output = execFileSync("/usr/bin/git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
    cwd: repository, encoding: "utf8", maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    return trim ? output.trim() : output;
  };
  try {
    if (git(["rev-parse", "HEAD"]) !== environment.GITHUB_SHA) refuse();
    assertDevelopmentSource(repository, environment);
    git(["merge-base", "--is-ancestor", rendererSha, environment.GITHUB_SHA]);
    const worker = git(["show", `${rendererSha}:preview-renderer/worker.ts`], false);
    if (!["readCurrentCode", "readCurrentCodeReference"].every(name => new RegExp(`async\\s+${name}\\s*\\(`).test(worker))) refuse();
    return { schemaVersion: 1, operatorCommitSha: environment.GITHUB_SHA, rendererSha,
      rendererTree: git(["rev-parse", `${rendererSha}^{tree}`]),
      workerSourceDigest: createHash("sha256").update(worker).digest("hex") };
  } catch { return refuse(); }
}
