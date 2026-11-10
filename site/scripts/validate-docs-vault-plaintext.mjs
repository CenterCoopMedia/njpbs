// Validate the exact plaintext buffers that docs-vault is about to encrypt.
// The parent process sends them over stdin so file changes between validation
// and the vault's phase-1 read cannot make different bytes pass the check.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lint } from "markdownlint/promise";
import remarkParse from "remark-parse";
import remarkValidateLinks from "remark-validate-links";
import { unified } from "unified";
import { VFile } from "vfile";
import { parse as parseYaml } from "yaml";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(scriptDir, "../..");
const configPath = path.join(sourceRoot, ".markdownlint-cli2.yaml");

async function readRequest() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!path.isAbsolute(request?.root) || !Array.isArray(request?.documents)) {
    throw new Error("expected an absolute root and a documents array");
  }
  for (const document of request.documents) {
    if (
      typeof document?.rel !== "string" ||
      document.rel === "" ||
      typeof document?.text !== "string"
    ) {
      throw new Error("every document needs a non-empty rel path and text");
    }
    const abs = path.resolve(request.root, document.rel);
    if (path.isAbsolute(document.rel) || !abs.startsWith(request.root + path.sep)) {
      throw new Error(`document path escapes the validation root: ${document.rel}`);
    }
  }
  return request;
}

function markdownlintConfig() {
  const parsed = parseYaml(fs.readFileSync(configPath, "utf8"));
  if (!parsed?.config || typeof parsed.config !== "object") {
    throw new Error(`${configPath}: expected a config mapping`);
  }
  return parsed.config;
}

function formatLintIssue(rel, issue) {
  const rule = issue.ruleNames?.[0] ?? "markdownlint";
  const detail = issue.errorDetail ? ` (${issue.errorDetail})` : "";
  return `${rel}:${issue.lineNumber}: ${rule} ${issue.ruleDescription}${detail}`;
}

async function validate(request) {
  const failures = [];
  const strings = Object.fromEntries(
    request.documents.map(({ rel, text }) => [rel, text]),
  );
  const lintResults = await lint({ strings, config: markdownlintConfig() });
  for (const { rel } of request.documents) {
    for (const issue of lintResults[rel] ?? []) {
      failures.push(formatLintIssue(rel, issue));
    }
  }

  const links = unified().use(remarkParse).use(remarkValidateLinks, {
    root: request.root,
    repository: false,
  });
  for (const { rel, text } of request.documents) {
    const file = new VFile({
      cwd: request.root,
      path: path.resolve(request.root, rel),
      value: text,
    });
    await links.run(links.parse(file), file);
    for (const message of file.messages) {
      failures.push(
        `${rel}:${message.line ?? 1}: ${message.ruleId ?? "relative-link"} ${message.reason}`,
      );
    }
  }
  return failures;
}

try {
  const request = await readRequest();
  const failures = await validate(request);
  process.stdout.write(`${JSON.stringify({ failures })}\n`);
} catch (error) {
  console.error(`docs vault plaintext validator failed: ${error.message}`);
  process.exitCode = 1;
}
