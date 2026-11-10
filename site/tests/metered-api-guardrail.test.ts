import { describe, it, expect, vi } from "vitest";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  findMarkdownlintConfigViolations,
  findPackageScriptViolations,
  findMeteredApiViolations,
  isMeteredApiScanTarget,
  isMarkdownlintConfigPath,
  scanMarkdownlintConfigFiles,
  scanPackageManifestFiles,
  runSourceScan,
} from "../../.github/scripts/metered-api-scan.mjs";

// Unit spec for the no-metered-API guardrail (issue #245). The source-tree scan
// that runs it over site/src, site/scripts, site/tests, and site/worker lives at
// scripts/metered-api-guardrail-source.test.ts and runs under npm run guardrails.

const scannerPath = join(
  process.cwd(),
  "../.github/scripts/metered-api-scan.mjs",
);

describe("findMeteredApiViolations", () => {
  it("returns nothing for empty input", () => {
    expect(findMeteredApiViolations("")).toEqual([]);
  });

  it("flags a fetch to the Anthropic API host", () => {
    const v = findMeteredApiViolations(
      'await fetch("https://api.anthropic.com/v1/messages")',
    );
    expect(v.map((x) => x.rule)).toContain("metered-api-host");
  });

  it("flags the OpenAI API host", () => {
    const v = findMeteredApiViolations(
      'fetch("https://api.openai.com/v1/chat")',
    );
    expect(v.map((x) => x.rule)).toContain("metered-api-host");
  });

  it("flags the Google generative-language host", () => {
    const v = findMeteredApiViolations(
      "url = 'https://generativelanguage.googleapis.com/v1beta/models'",
    );
    expect(v.map((x) => x.rule)).toContain("metered-api-host");
  });

  it("flags an Azure OpenAI resource endpoint", () => {
    const v = findMeteredApiViolations(
      'fetch("https://my-resource.openai.azure.com/openai/deployments/gpt-4/chat")',
    );
    expect(v.map((x) => x.rule)).toContain("metered-api-host");
  });

  it("flags an @anthropic-ai/sdk import", () => {
    const v = findMeteredApiViolations(
      'import Anthropic from "@anthropic-ai/sdk";',
    );
    expect(v.map((x) => x.rule)).toContain("metered-api-sdk");
  });

  it("flags an openai default import", () => {
    const v = findMeteredApiViolations('import OpenAI from "openai";');
    expect(v.map((x) => x.rule)).toContain("metered-api-sdk");
  });

  it("flags a require of openai", () => {
    const v = findMeteredApiViolations('const OpenAI = require("openai");');
    expect(v.map((x) => x.rule)).toContain("metered-api-sdk");
  });

  it("flags a dynamic import of a provider SDK", () => {
    const v = findMeteredApiViolations(
      'const m = await import("@google/generative-ai");',
    );
    expect(v.map((x) => x.rule)).toContain("metered-api-sdk");
  });

  it("flags an openai subpath import", () => {
    const v = findMeteredApiViolations(
      'import { toFile } from "openai/uploads";',
    );
    expect(v.map((x) => x.rule)).toContain("metered-api-sdk");
  });

  it("flags a template-literal specifier in a dynamic import", () => {
    const v = findMeteredApiViolations("const m = await import(`openai`);");
    expect(v.map((x) => x.rule)).toContain("metered-api-sdk");
  });

  it("flags a template-literal specifier in a require", () => {
    const v = findMeteredApiViolations(
      "const a = require(`@anthropic-ai/sdk`);",
    );
    expect(v.map((x) => x.rule)).toContain("metered-api-sdk");
  });

  it("does not flag a bare template literal outside an import context", () => {
    // A provider name in a plain template literal is not a metered call; only an
    // import/require/from specifier is.
    const v = findMeteredApiViolations("const label = `openai`;");
    expect(v).toEqual([]);
  });

  it("flags wrapper SDKs that reach the same metered hosts", () => {
    for (const spec of [
      "@ai-sdk/openai",
      "@ai-sdk/anthropic",
      "@ai-sdk/google",
      "@langchain/openai",
      "@langchain/anthropic",
      "langchain/chat_models/openai",
      "langchain/llms/openai",
    ]) {
      const v = findMeteredApiViolations(`import { x } from "${spec}";`);
      expect(v.map((r) => r.rule)).toContain("metered-api-sdk");
    }
  });

  it("does NOT flag non-provider wrapper subpaths", () => {
    for (const spec of [
      "@ai-sdk/react",
      "@ai-sdk/provider",
      "@langchain/core",
      "langchain/prompts",
      "langchain/text_splitter",
    ]) {
      expect(findMeteredApiViolations(`import { x } from "${spec}";`)).toEqual(
        [],
      );
    }
  });

  it("flags a python anthropic import", () => {
    const v = findMeteredApiViolations(
      "import anthropic\nclient = anthropic.Anthropic()",
    );
    expect(v.map((x) => x.rule)).toContain("metered-api-sdk");
  });

  it("flags a python google.generativeai import", () => {
    const v = findMeteredApiViolations("import google.generativeai as genai");
    expect(v.map((x) => x.rule)).toContain("metered-api-sdk");
  });

  it("flags the google-genai SDK's canonical from-import", () => {
    // `from google import genai; client = genai.Client()` is the documented form.
    expect(
      findMeteredApiViolations("from google import genai").map((x) => x.rule),
    ).toContain("metered-api-sdk");
    expect(
      findMeteredApiViolations("from google import generativeai").map(
        (x) => x.rule,
      ),
    ).toContain("metered-api-sdk");
  });

  it("does NOT flag an unrelated google.cloud import", () => {
    expect(
      findMeteredApiViolations("from google.cloud import storage"),
    ).toEqual([]);
    expect(findMeteredApiViolations("import google.auth")).toEqual([]);
  });

  it("flags a python from-import", () => {
    const v = findMeteredApiViolations("from openai import OpenAI");
    expect(v.map((x) => x.rule)).toContain("metered-api-sdk");
  });

  it("flags a comma-separated python import list", () => {
    expect(
      findMeteredApiViolations("import os, openai").map((x) => x.rule),
    ).toContain("metered-api-sdk");
    expect(
      findMeteredApiViolations("import json, sys, anthropic").map(
        (x) => x.rule,
      ),
    ).toContain("metered-api-sdk");
  });

  it("does NOT flag a python module whose name merely contains a provider", () => {
    expect(findMeteredApiViolations("import openai_helper")).toEqual([]);
    expect(findMeteredApiViolations("import os  # call openai later")).toEqual(
      [],
    );
  });

  it("does NOT flag the subscription CLIs run as child processes", () => {
    expect(
      findMeteredApiViolations('spawnSync("claude", ["-p", prompt])'),
    ).toEqual([]);
    expect(
      findMeteredApiViolations('execFileSync("gemini", ["-p", prompt])'),
    ).toEqual([]);
    expect(findMeteredApiViolations('run("codex exec review")')).toEqual([]);
  });

  it("does NOT flag a bare provider name in prose or a comment", () => {
    expect(
      findMeteredApiViolations(
        "// drafting runs through the anthropic claude CLI, not the API",
      ),
    ).toEqual([]);
    expect(
      findMeteredApiViolations(
        "<p>Caption drafts use OpenAI Whisper offline.</p>",
      ),
    ).toEqual([]);
  });

  it("does NOT flag PBS or embed hosts", () => {
    expect(
      findMeteredApiViolations('src="https://player.pbs.org/ga-livestream/"'),
    ).toEqual([]);
    expect(
      findMeteredApiViolations("https://media.services.pbs.org/api/v1/shows/"),
    ).toEqual([]);
    expect(
      findMeteredApiViolations("https://jaws-prod.cdn.pbs.org/js/gc.js"),
    ).toEqual([]);
    expect(
      findMeteredApiViolations("https://image.pbs.org/contentchannels/x.jpg"),
    ).toEqual([]);
  });

  it("reports the matched text so a failure is actionable", () => {
    const v = findMeteredApiViolations(
      'fetch("https://api.openai.com/v1/chat")',
    );
    expect(v[0]).toHaveProperty("match");
    expect(v[0].match.length).toBeGreaterThan(0);
  });
});

describe("findPackageScriptViolations", () => {
  it("decodes escaped inline imports in package scripts", () => {
    const source = JSON.stringify({
      scripts: {
        postinstall: "node -e 'require(\"openai\")'",
      },
    });

    expect(
      findPackageScriptViolations(source).map((violation) => violation.rule),
    ).toContain("metered-api-sdk");
  });

  it("checks every package script conservatively, beyond rebuild lifecycle hooks", () => {
    const source = JSON.stringify({
      scripts: {
        prepare: "curl https://api.anthropic.com/v1/messages",
        verify: "curl https://api.openai.com/v1/chat",
      },
    });

    const matches = findPackageScriptViolations(source).map(
      (violation) => violation.match,
    );
    expect(matches.some((match) => match.startsWith("scripts.prepare:"))).toBe(
      true,
    );
    expect(matches.some((match) => match.startsWith("scripts.verify:"))).toBe(
      true,
    );
  });

  it("does not mistake a declared package for an executed import", () => {
    const source = JSON.stringify({ dependencies: { openai: "1.0.0" } });
    expect(findPackageScriptViolations(source)).toEqual([]);
  });

  it("flags a Python SDK import embedded in an inline lifecycle command", () => {
    const source = JSON.stringify({
      scripts: {
        postinstall:
          "pip install openai && python3 -c 'import openai; openai.OpenAI().models.list()'",
      },
    });

    expect(
      findPackageScriptViolations(source).map((violation) => violation.rule),
    ).toContain("metered-api-sdk");
  });

  it.each([
    "python3 -c '__import__(\"openai\").OpenAI()'",
    "python3 -c'import openai'",
    'python3 -c"import openai"',
    "python3 -cimport openai",
    'python3 -X dev -c "import openai"',
    'python3 -W ignore -c "import anthropic"',
    "python -c 'import importlib; importlib.import_module(\"anthropic\")'",
    "python3 -m openai models list",
    "python3 -mopenai models list",
    "/usr/bin/python3.12 -X utf8 -c 'import openai'",
  ])("flags the Python SDK command form: %s", (command) => {
    const source = JSON.stringify({ scripts: { postinstall: command } });
    expect(
      findPackageScriptViolations(source).map((violation) => violation.rule),
    ).toContain("metered-api-sdk");
  });

  it("does not treat another tool's --import flag as Python source", () => {
    const source = JSON.stringify({
      scripts: { lint: "eslint --import openai-plugin src" },
    });
    expect(findPackageScriptViolations(source)).toEqual([]);
  });

  it.each(["customRules", "markdownItPlugins", "outputFormatters"])(
    "rejects %s in the package.json markdownlint-cli2 key",
    (hook) => {
      const source = JSON.stringify({
        "markdownlint-cli2": { [hook]: ["./outside-scan.mjs"] },
      });
      expect(
        findPackageScriptViolations(source).map((violation) => violation.rule),
      ).toContain("markdownlint-module-hook");
    },
  );
});

describe("findMarkdownlintConfigViolations", () => {
  it.each(["customRules", "markdownItPlugins", "outputFormatters"])(
    "forbids the repository-loaded %s module hook",
    (hook) => {
      expect(
        findMarkdownlintConfigViolations(
          `${hook}:\n  - "./outside-scan.mjs"\n`,
        ).map((violation) => violation.rule),
      ).toContain("markdownlint-module-hook");
      expect(
        findMarkdownlintConfigViolations(
          `{ "${hook}": ["./outside-scan.mjs"] }`,
        ).map((violation) => violation.rule),
      ).toContain("markdownlint-module-hook");
    },
  );

  it("scans executable config bodies for direct metered calls", () => {
    expect(
      findMarkdownlintConfigViolations(
        'await fetch("https://api.openai.com/v1/chat");',
      ).map((violation) => violation.rule),
    ).toContain("metered-api-host");
  });

  it("allows the repository's declarative rule configuration", () => {
    expect(
      findMarkdownlintConfigViolations(
        'config:\n  default: true\nglobs:\n  - "**/*.md"\n',
      ),
    ).toEqual([]);
  });
});

describe("isMarkdownlintConfigPath", () => {
  it("recognizes root and nested supported config names", () => {
    expect(isMarkdownlintConfigPath(".markdownlint-cli2.yaml")).toBe(true);
    expect(isMarkdownlintConfigPath("docs/.markdownlint.cjs")).toBe(true);
    expect(isMarkdownlintConfigPath("wiki/guides/.markdownlint-cli2.mjs")).toBe(
      true,
    );
  });

  it("does not treat unrelated config names as Markdown lint inputs", () => {
    expect(isMarkdownlintConfigPath("docs/markdownlint.config.mjs")).toBe(
      false,
    );
  });

  it("discovers supported configs below the repository root", () => {
    const root = mkdtempSync(join(tmpdir(), "metered-api-configs-"));
    try {
      mkdirSync(join(root, "docs", "nested"), { recursive: true });
      mkdirSync(join(root, "coverage"), { recursive: true });
      mkdirSync(join(root, ".astro"), { recursive: true });
      mkdirSync(join(root, "dist"), { recursive: true });
      mkdirSync(join(root, "node_modules", "ignored"), { recursive: true });
      writeFileSync(join(root, ".markdownlint-cli2.yaml"), "config: {}\n");
      writeFileSync(
        join(root, "docs", "nested", ".markdownlint.cjs"),
        "module.exports = {};\n",
      );
      writeFileSync(
        join(root, "coverage", ".markdownlint.cjs"),
        "module.exports = {};\n",
      );
      writeFileSync(
        join(root, ".astro", ".markdownlint-cli2.mjs"),
        "export default {};\n",
      );
      writeFileSync(
        join(root, "dist", ".markdownlint-cli2.cjs"),
        "module.exports = {};\n",
      );
      writeFileSync(
        join(root, "node_modules", "ignored", ".markdownlint.cjs"),
        "module.exports = {};\n",
      );

      expect(scanMarkdownlintConfigFiles(root)).toEqual([
        ".astro/.markdownlint-cli2.mjs",
        ".markdownlint-cli2.yaml",
        "coverage/.markdownlint.cjs",
        "dist/.markdownlint-cli2.cjs",
        "docs/nested/.markdownlint.cjs",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("scanPackageManifestFiles", () => {
  it("discovers first-party manifests while excluding installed dependencies", () => {
    const root = mkdtempSync(join(tmpdir(), "metered-api-manifests-"));
    try {
      mkdirSync(join(root, "packages", "future"), { recursive: true });
      mkdirSync(join(root, "node_modules", "ignored"), { recursive: true });
      writeFileSync(join(root, "package.json"), "{}\n");
      writeFileSync(join(root, "packages", "future", "package.json"), "{}\n");
      writeFileSync(
        join(root, "node_modules", "ignored", "package.json"),
        "{}\n",
      );

      expect(scanPackageManifestFiles(root)).toEqual([
        "package.json",
        "packages/future/package.json",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("historical target-root scan mode", () => {
  it("scans an older layout without requiring current-only manifests or lint config", () => {
    const root = mkdtempSync(join(tmpdir(), "metered-api-historical-"));
    try {
      mkdirSync(join(root, "legacy"), { recursive: true });
      writeFileSync(join(root, "package.json"), '{"scripts":{"test":"node legacy/app.js"}}\n');
      writeFileSync(join(root, "legacy", "app.js"), "console.log('safe');\n");

      const result = spawnSync(
        process.execPath,
        [scannerPath, "--target-root", root],
        { encoding: "utf8" },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/metered-api scan: \d+ files clean/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scans every existing source, manifest, and Markdown lint config", () => {
    const root = mkdtempSync(join(tmpdir(), "metered-api-historical-bad-"));
    try {
      mkdirSync(join(root, "legacy"), { recursive: true });
      mkdirSync(join(root, "packages", "old"), { recursive: true });
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(join(root, "package.json"), "{}\n");
      writeFileSync(
        join(root, "legacy", "bad.js"),
        'fetch("https://api.openai.com/v1/chat");\n',
      );
      writeFileSync(
        join(root, "packages", "old", "package.json"),
        `${JSON.stringify({ scripts: { test: "node -e 'require(\"openai\")'" } })}\n`,
      );
      writeFileSync(
        join(root, "docs", ".markdownlint.cjs"),
        'module.exports = { customRules: ["./rule.cjs"] };\n',
      );

      const result = spawnSync(
        process.execPath,
        [scannerPath, "--target-root", root],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("legacy/bad.js");
      expect(result.stderr).toContain("packages/old/package.json");
      expect(result.stderr).toContain("docs/.markdownlint.cjs");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes the nested trusted bootstrap checkout from the selected tree", () => {
    const root = mkdtempSync(join(tmpdir(), "metered-api-nested-gate-"));
    try {
      const nestedScanner = join(
        root,
        ".trusted-gate",
        ".github",
        "scripts",
        "metered-api-scan.mjs",
      );
      mkdirSync(join(root, "legacy"), { recursive: true });
      mkdirSync(join(root, ".trusted-gate", ".github", "scripts"), {
        recursive: true,
      });
      writeFileSync(join(root, "package.json"), "{}\n");
      writeFileSync(join(root, "legacy", "app.js"), "console.log('safe');\n");
      copyFileSync(scannerPath, nestedScanner);

      const result = spawnSync(
        process.execPath,
        [nestedScanner, "--target-root", root],
        { encoding: "utf8" },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/metered-api scan: \d+ files clean/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps current-layout validation strict in normal mode", () => {
    const root = mkdtempSync(join(tmpdir(), "metered-api-current-layout-"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      mkdirSync(join(root, "legacy"), { recursive: true });
      writeFileSync(join(root, "package.json"), "{}\n");
      writeFileSync(join(root, "legacy", "app.js"), "console.log('safe');\n");

      expect(runSourceScan(root)).toBe(1);
      expect(error.mock.calls.flat().join("\n")).toContain(
        "admin/package.json is a required scan target",
      );
    } finally {
      error.mockRestore();
      log.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("isMeteredApiScanTarget", () => {
  it("scans hand-written source across the code extensions", () => {
    expect(isMeteredApiScanTarget("site/src/lib/report-form.ts")).toBe(true);
    expect(isMeteredApiScanTarget("site/scripts/sync-launch-content.mjs")).toBe(
      true,
    );
    expect(isMeteredApiScanTarget("site/worker/index.ts")).toBe(true);
    expect(isMeteredApiScanTarget("site/scripts/resample-nj-edge.py")).toBe(
      true,
    );
    expect(isMeteredApiScanTarget("site/src/islands/ReportProblem.astro")).toBe(
      true,
    );
  });

  it("scans ordinary test files so a test can not sneak in a metered call", () => {
    expect(isMeteredApiScanTarget("site/scripts/guardrails-dist.test.ts")).toBe(
      true,
    );
    expect(
      isMeteredApiScanTarget(
        "site/scripts/metered-api-guardrail-source.test.ts",
      ),
    ).toBe(true);
  });

  it("exempts only the in-graph ban-list fixture", () => {
    expect(
      isMeteredApiScanTarget("site/src/lib/metered-api-guardrail.ts"),
    ).toBe(true);
    expect(
      isMeteredApiScanTarget("site/tests/metered-api-guardrail.test.ts"),
    ).toBe(false);
    expect(isMeteredApiScanTarget("tests/metered-api-guardrail.test.ts")).toBe(
      true,
    );
  });

  it("exempts by exact path, not basename, so a same-named file elsewhere is scanned", () => {
    expect(isMeteredApiScanTarget("site/worker/metered-api-guardrail.ts")).toBe(
      true,
    );
    expect(
      isMeteredApiScanTarget(
        "site/src/lib/nested/metered-api-guardrail.test.ts",
      ),
    ).toBe(true);
  });

  it("ignores non-source files", () => {
    expect(
      isMeteredApiScanTarget("site/src/data/launch-media-manager.json"),
    ).toBe(false);
    expect(isMeteredApiScanTarget("site/public/CNAME")).toBe(false);
  });
});
