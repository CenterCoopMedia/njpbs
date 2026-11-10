import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);

// Existing source and fixture checks exercise each step's shell program. Follow
// extracted calls while leaving the actual workflow available for wiring checks.
export function readCmsDeployWorkflow() {
  return readFileSync(new URL(".github/workflows/cms-staging-deploy.yml", root), "utf8")
    .replace(/^( *)run: bash "\$RUNNER_TEMP\/(?:release-gate|cms-smoke-gate)"\/(\.github\/scripts\/cms-deploy\/[a-z-]+\.sh)\n/gm,
      (_, indent, path) => {
        const script = readFileSync(new URL(path, root), "utf8");
        if (!script.startsWith("#!/usr/bin/env bash\n")) throw new Error(`Unexpected script header: ${path}`);
        return `${indent}run: |\n${script.slice(script.indexOf("\n") + 1)
          .split("\n").slice(0, -1).map(line => `${indent}  ${line}`).join("\n")}\n`;
      });
}
