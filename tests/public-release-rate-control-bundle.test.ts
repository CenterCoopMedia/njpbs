import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareCmsRateControlBundle, rateControlModuleManifest } from "../scripts/lib/public-release-rate-control-bundle.mjs";

it("matches the ordinary tracked CMS deployment config's canonical module bytes", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "rate-canonical-test-"));
  try {
    const root = resolve("."), file = join(scratch, "canonical.multipart");
    // The independent oracle is the existing deployment's actual config path.
    // Provider access is impossible; credentials/user config are not inherited.
    execFileSync(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "versions", "upload",
      "--config", join(root, "cms-api/wrangler.jsonc"), "--dry-run", "--outdir", join(scratch, "modules"), "--outfile", file], {
      cwd: scratch, stdio: "ignore", env: { PATH: process.env.PATH, HOME: scratch, XDG_CONFIG_HOME: scratch,
        WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(scratch, "wrangler.log"),
        CLOUDFLARE_API_BASE_URL: "http://127.0.0.1:9/client/v4", CI: "true" },
    });
    const bytes = await readFile(file), boundary = bytes.subarray(0, bytes.indexOf(10)).toString("ascii").trim().slice(2);
    const form = await new Response(bytes, { headers: { "content-type": `multipart/form-data; boundary=${boundary}` } }).formData();
    const metadata = JSON.parse(form.get("metadata") as string), modules = [];
    for (const [name, part] of form) if (name !== "metadata") modules.push({ name, content_type: (part as Blob).type,
      content_base64: Buffer.from(await (part as Blob).arrayBuffer()).toString("base64") });
    expect((await prepareCmsRateControlBundle()).bundle).toEqual({ mainModule: metadata.main_module, modules: rateControlModuleManifest(modules) });
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
