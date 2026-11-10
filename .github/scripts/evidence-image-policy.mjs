import { execFileSync } from "node:child_process";
import { extname } from "node:path";

// Keep runtime assets, guide illustrations, and test fixtures with their consumers.
const allowedRoots = [
  "admin/tests/visual/baselines/",
  "admin/public/",
  "admin/src/dev/fixtures/",
  "site/public/",
  "site/src/internal/admin-guide/",
  "site/tests/fixtures/",
  "branding/",
  "functions/assets/",
  "premiere-boardwalk-panel/icons/",
  "docs/njpbs-digital-content-playbook/assets/",
];
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0").filter(Boolean);
const evidence = paths.filter((path) => imageExtensions.has(extname(path).toLowerCase()) &&
  !allowedRoots.some((root) => path.startsWith(root)));

if (evidence.length) {
  console.error("Store pull-request evidence outside this source repository. See the contributor rules");
  for (const path of evidence) console.error(JSON.stringify(path));
  process.exitCode = 1;
} else {
  console.log("Image policy passed.");
}
