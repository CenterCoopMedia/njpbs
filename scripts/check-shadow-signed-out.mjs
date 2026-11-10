import { devAccessOrigin } from "./lib/deployment-settings.mjs";
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

devAccessOrigin();

// Keep response headers/bodies in memory: Access redirects contain login tokens.
const paths = [
  "/posts/nj-pbs-announces-six-staff-appointments/",
  "/posts/_shadow-assets/_astro/",
];
const redirectBody = "<html><head><title>302 Found</title></head><body><center><h1>302 Found</h1></center><hr><center>cloudflare</center></body></html>";
let failed = false;
let summary = `Source: ${process.env.GITHUB_SHA}\n\n| Signed-out path | Status | Refused |\n| --- | --- | --- |\n`;
for (const path of paths) {
  // Ignore curl configuration, send no credentials and follow no redirects.
  const result = spawnSync("curl", [
    "--disable", "--silent", "--show-error", "--max-time", "30",
    "--include", "--suppress-connect-headers", `https://dev-public.example.org${path}`,
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  let status = "000";
  let refused = false;
  if (result.status !== 0) {
    // Report only process codes; never raw curl diagnostics or response data.
    console.error(`Signed-out transport failed: exit=${result.status}; signal=${result.signal ?? "none"}; code=${result.error?.code ?? "none"}`);
  }
  if (result.status === 0) {
    const response = result.stdout.replace(/\r\n/g, "\n");
    const boundary = response.indexOf("\n\n");
    const lines = response.slice(0, boundary).split("\n");
    status = /^HTTP\/\S+ (\d{3})(?:\s|$)/.exec(lines.shift())?.[1] ?? "000";
    const headers = new Headers();
    try {
      for (const line of lines) {
        const colon = line.indexOf(":");
        if (colon < 1) throw new Error("Invalid header");
        headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
      }
      const body = response.slice(boundary + 2).trim();
      const hasContentEvidence = [...headers.keys()].some(name => name.startsWith("x-njpbs-"));
      if (boundary >= 0 && !hasContentEvidence) {
        if (status === "302") {
          const location = new URL(headers.get("location"));
          refused = location.origin === devAccessOrigin() &&
            !location.username && !location.password &&
            location.pathname === "/cdn-cgi/access/login/dev-public.example.org" &&
            (body === "" || body.replace(/\s+</g, "<") === redirectBody);
        } else if (status === "401" || status === "403") {
          // Match the staff gateway, not an unrelated WAF/bot block of this client.
          const staffHeaders = headers.get("cache-control") === "private, no-store" &&
            headers.get("x-robots-tag") === "noindex, nofollow, noarchive" &&
            headers.get("referrer-policy") === "no-referrer" &&
            headers.get("x-content-type-options") === "nosniff";
          refused = staffHeaders && body === (status === "401" ? "Unauthorized" : "Site access unavailable");
        }
      }
    } catch { /* Malformed responses fail closed without printing their contents. */ }
  }
  failed ||= !refused;
  console.log(`Signed-out ${path}: ${status}; refused=${refused}`);
  summary += `| ${path} | ${status} | ${refused ? "yes" : "no"} |\n`;
}
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
if (failed) {
  console.error("Expected an Access login redirect or a 401/403 refusal with no content.");
  process.exitCode = 1;
}
