import { execFile } from "node:child_process";

export function parsePreviewOperatorArguments(args: string[]) {
  if (args.length !== 3 || !["--serve", "--preflight"].includes(args[0]) ||
    !/^[a-f0-9]{40}$/.test(args[1]) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(args[2])) {
    throw new Error("Usage: run-cms-preview-serializer --serve|--preflight <40-character-commit> <serializer-id>");
  }
  return { preflight: args[0] === "--preflight", rendererSha: args[1], serializerId: args[2] };
}

export async function assertPreviewSandboxAvailable() {
  await new Promise<void>((resolve, reject) => execFile("/usr/bin/bwrap", [
    "--unshare-all", "--unshare-user", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--", "/usr/bin/true",
  ], { env: { PATH: "/usr/bin:/bin" }, timeout: 5_000, maxBuffer: 4096 }, error =>
    error ? reject(new Error("Private preview build isolation is unavailable")) : resolve()));
}
