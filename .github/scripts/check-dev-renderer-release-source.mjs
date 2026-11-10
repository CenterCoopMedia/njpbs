import { devRendererReleaseMode, assertDevRendererReleaseSource } from "../../scripts/lib/dev-renderer-release-source.mjs";

try {
  const mode = devRendererReleaseMode(process.env);
  const source = mode.rendererOnly ? assertDevRendererReleaseSource(mode.sourceSha, process.env) : null;
  process.stdout.write(JSON.stringify({ rendererOnly: mode.rendererOnly, preservePreviewPause: mode.preservePreviewPause,
    restorePreviewBootstrap: mode.restorePreviewBootstrap,
    ...(source ? { source } : {}) }) + "\n");
} catch {
  process.stderr.write("Development renderer release inputs refused\n");
  process.exitCode = 1;
}
