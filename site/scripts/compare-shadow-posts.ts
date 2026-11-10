import { readFile } from "node:fs/promises";
import { comparePostHtml } from "../src/lib/post-html-comparison";
import { postPublicPath } from "../src/lib/public-content-routes";

// Explicit operator invocation only. Tests import the pure fixture comparator.
const slugs = process.argv.slice(2);
if (!slugs.length) throw new Error("Usage: npm run compare:shadow -- slug [slug ...]");
const cookieFile = process.env.NJPBS_SHADOW_COMPARE_COOKIE_FILE;
const staffCookie = cookieFile ? (await readFile(cookieFile, "utf8")).trim() : undefined;
if (staffCookie && !/^__Host-njpbs-staff=[A-Za-z0-9._-]{1,3500}$/.test(staffCookie)) {
  throw new Error("Invalid staff comparison cookie file");
}
let differences = false;
for (const slug of slugs) {
  const path = postPublicPath(slug);
  try {
    const pages = [];
    let shadow: { rendererSha: string; sourceVersion: string; inputSha256: string } | undefined;
    for (const origin of ["https://njpbs.org", "https://dev-public.example.org"]) {
      const start = performance.now();
      const response = await fetch(origin + path, { headers: origin === "https://dev-public.example.org" && staffCookie ? { cookie: staffCookie } : {}, redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!response.ok || !response.headers.get("Content-Type")?.includes("text/html")) throw new Error(`Page read failed (${response.status})`);
      if (origin === "https://dev-public.example.org") {
        const rendererSha = response.headers.get("X-Njpbs-Renderer-Sha") ?? "";
        const sourceVersion = response.headers.get("X-Njpbs-Source-Version") ?? "";
        const inputSha256 = response.headers.get("X-Njpbs-Input-Sha256") ?? "";
        if (!/^[a-f0-9]{40}$/.test(rendererSha) || !/^[1-9][0-9]*$/.test(sourceVersion) ||
          !/^[a-f0-9]{64}$/.test(inputSha256)) {
          throw new Error("Dev response lacks shadow renderer evidence");
        }
        shadow = { rendererSha, sourceVersion, inputSha256 };
      }
      pages.push({ html: await response.text(), durationMs: Math.round(performance.now() - start) });
    }
    const delta = comparePostHtml(pages[0].html, pages[1].html);
    differences ||= delta.length > 0;
    console.log(JSON.stringify({ slug, liveMs: pages[0].durationMs, devMs: pages[1].durationMs, shadow, differences: delta }));
  } catch (error) {
    differences = true;
    console.log(JSON.stringify({ slug, error: error instanceof Error ? error.message : "Comparison failed" }));
  }
}
process.exitCode = differences ? 1 : 0;
