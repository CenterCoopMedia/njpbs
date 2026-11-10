import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TOKENS = readFileSync(
  fileURLToPath(new URL("../src/styles/design-tokens.css", import.meta.url)),
  "utf8",
);

export function resolveTokenColor(
  value: string,
  localVars: Record<string, string> = {},
  seen = new Set<string>(),
): string {
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) return trimmed.toLowerCase();

  const variable = trimmed.match(/^var\(--([a-zA-Z0-9-]+)\)$/)?.[1];
  if (!variable) return "";
  if (seen.has(variable)) throw new Error(`CSS token cycle at --${variable}`);
  seen.add(variable);

  if (variable in localVars) {
    return resolveTokenColor(localVars[variable], localVars, seen);
  }

  const match = TOKENS.match(new RegExp(`--${variable}:\\s*([^;]+);`));
  return match ? resolveTokenColor(match[1].trim(), localVars, seen) : "";
}

