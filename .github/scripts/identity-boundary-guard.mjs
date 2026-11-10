import { readdirSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ADR =
  "ADR 0015 (docs/decisions/0015-two-identity-system-boundary.md)";

export const MEMBER_GATE = Object.freeze([
  "site/src/lib/pmsso-login.ts",
  "site/src/lib/member-gated-playback.ts",
  "site/src/lib/mvault-entitlement.ts",
  "functions/lib/pbs/mvault-entitlement.js",
  "functions/lib/pbs/mvault-lookup.js",
]);

export const STAFF_IDENTITY = Object.freeze([
  "packages/content-core/src/rbac.ts",
  "admin/src/lib/principal.ts",
  "admin/src/lib/access.ts",
  "admin/src/context/AuthContext.tsx",
  "admin/src/context/authReducer.ts",
  "functions/lib/auth.js",
  "functions/lib/principal.js",
  "functions/lib/rbac.js",
  "functions/roles.js",
  // Role provisioning owns staff authority just as much as the readers above:
  // staff-access.js approves a request and writes the graded user grant,
  // staff-profile.js refuses sessions without an existing approved profile,
  // and deactivate-staff.js clears roles and grants on offboarding. None of
  // these names is matched by IDENTITY_VOCAB, so listing them is the only
  // classification.
  "functions/staff-access.js",
  "functions/staff-profile.js",
  "functions/deactivate-staff.js",
  "functions/reactivate-staff.js",
  "cms-api/src/firebase-auth.ts",
]);

export const EXECUTABLE_SOURCE_EXTENSION =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

export const SCAN_ROOTS = Object.freeze([
  "site/src",
  "admin/src",
  "functions",
  "cms-api/src",
  "packages/content-core/src",
]);

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".astro",
  "tests",
  "__tests__",
]);
const NON_SOURCE = /\.d\.[cm]?ts$|\.(test|spec)\.[cm]?[tj]sx?$/;
const IDENTITY_VOCAB =
  /pmsso|mvault|passport|entitlement|member-gated|rbac|principal|authcontext|authreducer|roles\.[cm]?[tj]sx?$/i;

// Name matches that deliberately are not identity owners. Empty today. Any future
// entry needs a reason beside it so the completeness escape remains reviewable.
export const EXEMPT_NON_OWNERS = Object.freeze([]);

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));

export function withoutExecutableExtension(path) {
  return path.replace(EXECUTABLE_SOURCE_EXTENSION, "");
}

const MEMBER_TARGETS = new Set(MEMBER_GATE.map(withoutExecutableExtension));
const STAFF_TARGETS = new Set(STAFF_IDENTITY.map(withoutExecutableExtension));

// A `/` opens a regular expression literal only where an operand is expected.
// The literal body may hold a quote, so consuming it keeps the string scanner in
// step; anywhere else the same character is division and carries no state.
const REGEX_OPENS_AFTER =
  /[({[,;:=+\-*/%&|^!~?<>]$|\b(?:await|case|delete|do|else|in|instanceof|new|of|return|typeof|void|yield)$/;

const SIMPLE_ESCAPES = new Map([
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
  ["0", "\0"],
]);

/** Index just past a single- or double-quoted literal that starts at `start`. */
function scanQuoted(source, start, quote) {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    // An unescaped line break cannot appear in a quoted literal; treating the
    // literal as ended there keeps one stray quote from swallowing the file.
    if (char === "\n") return index;
    index += 1;
  }
  return source.length;
}

/** Index just past a template literal, including nested `${}` substitutions. */
function scanTemplate(source, start) {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "`") return index + 1;
    if (char === "$" && source[index + 1] === "{") {
      index = scanSubstitution(source, index + 2);
      continue;
    }
    index += 1;
  }
  return source.length;
}

/** Index just past the `}` that closes a template substitution. */
function scanSubstitution(source, start) {
  let index = start;
  let depth = 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'") {
      index = scanQuoted(source, index, char);
      continue;
    }
    if (char === "`") {
      index = scanTemplate(source, index);
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return source.length;
}

/** Index just past a regular expression literal that starts at `start`. */
function scanRegularExpression(source, start) {
  let index = start + 1;
  let inCharacterClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    // A regular expression literal never spans a line; stopping here keeps a
    // misread division from consuming the rest of the file.
    if (char === "\n") return index;
    if (char === "[") inCharacterClass = true;
    else if (char === "]") inCharacterClass = false;
    else if (char === "/" && !inCharacterClass) return index + 1;
    index += 1;
  }
  return source.length;
}

/**
 * Strip comments before parsing import spellings. The scan is string-aware: a
 * `/*` inside a quoted, template, or regular expression literal (`"image/*"`)
 * is literal text, not a comment opener, so it can neither hide a real import
 * nor invent one. Comment openers are tested first, so a JSX `{/* ... *\/}`
 * comment is still removed. This is the established guard contract: it
 * recognizes the repository's import forms without evaluating source code.
 */
export function stripComments(source) {
  let output = "";
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      output += " ";
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      output += " ";
      index = end === -1 ? source.length : end + 2;
      continue;
    }

    let end = null;
    if (char === '"' || char === "'") end = scanQuoted(source, index, char);
    else if (char === "`") end = scanTemplate(source, index);
    else if (char === "/" && REGEX_OPENS_AFTER.test(output.trimEnd())) {
      end = scanRegularExpression(source, index);
    }

    if (end === null) {
      output += char;
      index += 1;
      continue;
    }
    // Literals are kept verbatim; the specifier patterns read them next.
    output += source.slice(index, end);
    index = end;
  }

  return output;
}

/**
 * Decode one literal body to the value the engine sees. An escaped specifier
 * that spells its separators as unicode, hex, or backslash escapes still
 * resolves at runtime to an ordinary relative path, so the boundary compares
 * cooked values rather than source spellings.
 */
export function cookStringLiteral(raw) {
  if (!raw.includes("\\")) return raw;

  let cooked = "";
  let index = 0;
  while (index < raw.length) {
    if (raw[index] !== "\\") {
      cooked += raw[index];
      index += 1;
      continue;
    }

    const escape = raw[index + 1];
    if (escape === undefined) break;

    if (escape === "u" && raw[index + 2] === "{") {
      const close = raw.indexOf("}", index + 3);
      const digits = close === -1 ? "" : raw.slice(index + 3, close);
      const code = /^[0-9a-fA-F]{1,6}$/.test(digits)
        ? Number.parseInt(digits, 16)
        : Number.NaN;
      if (code <= 0x10ffff) {
        cooked += String.fromCodePoint(code);
        index = close + 1;
        continue;
      }
    } else if (escape === "u" || escape === "x") {
      const width = escape === "u" ? 4 : 2;
      const digits = raw.slice(index + 2, index + 2 + width);
      if (digits.length === width && /^[0-9a-fA-F]+$/.test(digits)) {
        cooked += String.fromCharCode(Number.parseInt(digits, 16));
        index += 2 + width;
        continue;
      }
    } else if (escape === "\n" || escape === "\r") {
      // Line continuation contributes nothing to the specifier.
      index += escape === "\r" && raw[index + 2] === "\n" ? 3 : 2;
      continue;
    }

    cooked += SIMPLE_ESCAPES.get(escape) ?? escape;
    index += 2;
  }
  return cooked;
}

// Quoted bodies allow escapes so an escaped specifier is captured whole; the
// template form is separate because only it can carry a `${}` substitution.
const QUOTED_BODY = String.raw`"((?:[^"\\\r\n]|\\[\s\S])*)"|'((?:[^'\\\r\n]|\\[\s\S])*)'`;
const TEMPLATE_BODY = String.raw`\x60((?:[^\x60\\]|\\[\s\S])*)\x60`;

const QUOTED_SPECIFIERS = Object.freeze([
  new RegExp(String.raw`\bfrom\s*(?:${QUOTED_BODY})`, "g"),
  new RegExp(String.raw`\bimport\s*(?:${QUOTED_BODY})`, "g"),
  new RegExp(String.raw`\bimport\s*\(\s*(?:${QUOTED_BODY})`, "g"),
  new RegExp(String.raw`\brequire\s*\(\s*(?:${QUOTED_BODY})`, "g"),
]);

const TEMPLATE_SPECIFIERS = Object.freeze([
  new RegExp(String.raw`\bimport\s*\(\s*${TEMPLATE_BODY}`, "g"),
  new RegExp(String.raw`\brequire\s*\(\s*${TEMPLATE_BODY}`, "g"),
]);

/**
 * Return repo-relative, extensionless local import targets from one source file.
 * Covers static imports, re-exports, bare imports, dynamic imports, and CommonJS
 * require calls. Dynamic import and require also accept a no-substitution template
 * literal; an interpolated template is not a statically resolved module target.
 * Specifiers are cooked before resolution, so an escape spelling resolves the way
 * the runtime resolves it. Repo paths are normalized with POSIX semantics on
 * every host.
 */
export function localImportTargets(ownerPath, source) {
  const code = stripComments(source);
  const specifiers = [];

  for (const pattern of QUOTED_SPECIFIERS) {
    for (const match of code.matchAll(pattern)) {
      specifiers.push(cookStringLiteral(match[1] ?? match[2]));
    }
  }
  for (const pattern of TEMPLATE_SPECIFIERS) {
    for (const match of code.matchAll(pattern)) {
      if (!match[1].includes("${")) {
        specifiers.push(cookStringLiteral(match[1]));
      }
    }
  }

  const ownerDirectory = posix.dirname(ownerPath);
  return specifiers
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) =>
      withoutExecutableExtension(
        posix.normalize(posix.join(ownerDirectory, specifier)),
      ),
    );
}

function readOwner(root, ownerPath, violations) {
  let source;
  try {
    source = readFileSync(resolve(root, ownerPath), "utf8");
  } catch (error) {
    violations.push({
      rule: "identity-owner-unreadable",
      owner: ownerPath,
      target: null,
      message: `${ownerPath} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return null;
  }

  if (source.length === 0) {
    violations.push({
      rule: "identity-owner-empty",
      owner: ownerPath,
      target: null,
      message: `${ownerPath} is empty; the identity-boundary guard cannot classify it`,
    });
    return null;
  }

  return source;
}

function collectSourceFiles(root, relativeDirectory, files, violations) {
  let entries;
  try {
    entries = readdirSync(resolve(root, relativeDirectory), {
      withFileTypes: true,
    });
  } catch (error) {
    violations.push({
      rule: "identity-scan-root-unreadable",
      owner: relativeDirectory,
      target: null,
      message: `${relativeDirectory} could not be scanned: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return;
  }

  for (const entry of entries) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        collectSourceFiles(root, relativePath, files, violations);
      }
      continue;
    }
    if (
      entry.isFile() &&
      EXECUTABLE_SOURCE_EXTENSION.test(entry.name) &&
      !NON_SOURCE.test(entry.name)
    ) {
      files.push(relativePath);
    }
  }
}

/**
 * Scan one repository tree and return every mechanical boundary violation. The
 * returned objects are stable data so CI and Vitest exercise the same
 * implementation and owner classification.
 */
export function identityBoundaryViolations(root = REPO_ROOT) {
  const violations = [];

  for (const owner of MEMBER_GATE) {
    const source = readOwner(root, owner, violations);
    if (source === null) continue;
    const leaks = localImportTargets(owner, source).filter((target) =>
      STAFF_TARGETS.has(target),
    );
    for (const target of leaks) {
      violations.push({
        rule: "member-imports-staff-identity",
        owner,
        target,
        message:
          `${owner} imports staff identity (${target}); the member gate must ` +
          `never reach staff identity (${ADR})`,
      });
    }
  }

  for (const owner of STAFF_IDENTITY) {
    const source = readOwner(root, owner, violations);
    if (source === null) continue;
    const leaks = localImportTargets(owner, source).filter((target) =>
      MEMBER_TARGETS.has(target),
    );
    for (const target of leaks) {
      violations.push({
        rule: "staff-imports-member-gate",
        owner,
        target,
        message:
          `${owner} imports the member gate (${target}); staff identity reaches ` +
          `members only through the sanctioned one-way members.view lookup (${ADR})`,
      });
    }
  }

  const sourceFiles = [];
  for (const scanRoot of SCAN_ROOTS) {
    collectSourceFiles(root, scanRoot, sourceFiles, violations);
  }

  const identityNamed = sourceFiles
    .filter((relativePath) => IDENTITY_VOCAB.test(relativePath))
    .sort();
  const classified = new Set([
    ...MEMBER_GATE,
    ...STAFF_IDENTITY,
    ...EXEMPT_NON_OWNERS,
  ]);

  const vocabularyOwners = [...MEMBER_GATE, ...STAFF_IDENTITY].filter(
    (relativePath) => IDENTITY_VOCAB.test(relativePath),
  );
  for (const owner of vocabularyOwners) {
    if (!identityNamed.includes(owner)) {
      violations.push({
        rule: "listed-owner-not-scanned",
        owner,
        target: null,
        message:
          `${owner} is a listed identity owner but the completeness scan did ` +
          `not reach it; SCAN_ROOTS or the walker changed (${ADR})`,
      });
    }
  }

  for (const relativePath of identityNamed) {
    if (!classified.has(relativePath)) {
      violations.push({
        rule: "identity-owner-unclassified",
        owner: relativePath,
        target: null,
        message:
          `${relativePath} is identity-named but is neither a listed owner nor ` +
          `an explicit non-owner; classify it in the canonical guard (${ADR})`,
      });
    }
  }

  return violations;
}

export function formatIdentityBoundaryViolations(violations) {
  return violations
    .map(
      (violation, index) =>
        `${index + 1}. [${violation.rule}] ${violation.message}`,
    )
    .join("\n");
}

function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectInvocation()) {
  const violations = identityBoundaryViolations();
  if (violations.length > 0) {
    console.error(
      `identity-boundary guard: ${violations.length} violation(s)\n` +
        formatIdentityBoundaryViolations(violations),
    );
    process.exitCode = 1;
  } else {
    console.log(
      `identity-boundary guard: ${
        MEMBER_GATE.length + STAFF_IDENTITY.length
      } identity owners clean.`,
    );
  }
}
