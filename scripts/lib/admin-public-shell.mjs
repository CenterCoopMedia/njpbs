import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const REQUIRED_ROBOTS_DIRECTIVES = Object.freeze([
  "noindex",
  "nofollow",
  "noarchive",
]);

const HEAD_METADATA_ELEMENTS = new Set([
  "base",
  "basefont",
  "bgsound",
  "link",
  "meta",
  "title",
  "noframes",
  "noscript",
  "style",
  "template",
  "script",
]);

const ROBOTS_DIRECTIVE_NAMES = new Set([
  "all",
  "index",
  "noindex",
  "follow",
  "nofollow",
  "none",
  "archive",
  "noarchive",
  "nositelinkssearchbox",
  "nosnippet",
  "indexifembedded",
  "max-snippet",
  "max-image-preview",
  "max-video-preview",
  "notranslate",
  "noimageindex",
  "unavailable_after",
]);

function unscopedRobotsDirectives(values) {
  const directives = new Set();

  for (const rawValue of values) {
    let userAgentScope = null;

    for (const rawPart of String(rawValue).split(",")) {
      let part = rawPart.trim().toLowerCase();
      if (!part) continue;

      const separator = part.indexOf(":");
      if (separator > 0) {
        const prefix = part.slice(0, separator).trim();
        const scopedDirective = part.slice(separator + 1).trim();
        if (
          prefix &&
          scopedDirective &&
          !ROBOTS_DIRECTIVE_NAMES.has(prefix)
        ) {
          userAgentScope = prefix;
          part = scopedDirective;
        }
      }

      if (userAgentScope === null) directives.add(part);
    }
  }

  return directives;
}

function missingDirectives(values) {
  const directives = unscopedRobotsDirectives(values);
  return REQUIRED_ROBOTS_DIRECTIVES.filter(
    (directive) => !directives.has(directive),
  );
}

function headerBlocks(source) {
  const blocks = [];
  let current = null;

  for (const rawLine of String(source).split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (!/^\s/.test(rawLine)) {
      current = { pattern: trimmed, operations: [] };
      blocks.push(current);
      continue;
    }

    if (!current) continue;

    if (trimmed.startsWith("!")) {
      const name = trimmed.slice(1).trim().toLowerCase();
      if (name) current.operations.push({ type: "remove", name });
      continue;
    }

    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim().toLowerCase();
    const value = trimmed.slice(separator + 1).trim();
    current.operations.push({ type: "set", name, value });
  }

  return blocks;
}

function applyRobotsOperations(values, operations, { replaceOnSet = false } = {}) {
  let effectiveValues = [...values];
  let sawSet = false;

  for (const operation of operations) {
    if (operation.name !== "x-robots-tag") continue;

    if (operation.type === "remove") {
      effectiveValues = [];
      sawSet = false;
      continue;
    }

    if (replaceOnSet && !sawSet) effectiveValues = [];
    effectiveValues.push(operation.value);
    sawSet = true;
  }

  return effectiveValues;
}

export function validateRobotsHeaders(source) {
  const blocks = headerBlocks(source);
  const globalBlocks = blocks.filter((block) => block.pattern === "/*");
  if (globalBlocks.length === 0) {
    return ["admin/public/_headers has no global /* rule"];
  }

  let globalValues = [];
  for (const block of globalBlocks) {
    globalValues = applyRobotsOperations(globalValues, block.operations);
  }

  if (globalValues.length === 0) {
    return ["the global /* rule has no X-Robots-Tag header"];
  }

  const errors = [];
  const globalMissing = missingDirectives(globalValues);
  if (globalMissing.length > 0) {
    errors.push(
      `the global X-Robots-Tag is missing: ${globalMissing.join(", ")}`,
    );
  }

  for (const block of blocks) {
    if (block.pattern === "/*") continue;
    const robotsOperations = block.operations.filter(
      (operation) => operation.name === "x-robots-tag",
    );
    if (robotsOperations.length === 0) continue;

    const effectiveValues = applyRobotsOperations(
      globalValues,
      robotsOperations,
      { replaceOnSet: true },
    );
    const missing = missingDirectives(effectiveValues);
    if (effectiveValues.length === 0) {
      errors.push(
        `the ${block.pattern} rule removes the required X-Robots-Tag header`,
      );
    } else if (missing.length > 0) {
      errors.push(
        `the ${block.pattern} X-Robots-Tag override is missing: ${missing.join(", ")}`,
      );
    }
  }

  return errors;
}

function metaAttributes(tag) {
  const attributes = new Map();
  const duplicates = new Set();
  const body = tag
    .replace(/^<\s*meta\b/i, "")
    .replace(/\/?>\s*$/i, "");
  const attributePattern =
    /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

  for (const match of body.matchAll(attributePattern)) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (attributes.has(name)) {
      duplicates.add(name);
      continue;
    }
    attributes.set(name, value);
  }

  return { attributes, duplicates };
}

function scanHtmlTags(source) {
  const html = String(source);
  const lowerHtml = html.toLowerCase();
  const tags = [];
  let cursor = 0;

  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) break;

    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      cursor = end < 0 ? html.length : end + 3;
      continue;
    }

    if (html.startsWith("<!", start) || html.startsWith("<?", start)) {
      const end = html.indexOf(">", start + 2);
      cursor = end < 0 ? html.length : end + 1;
      continue;
    }

    let end = start + 1;
    let quote = null;
    for (; end < html.length; end += 1) {
      const character = html[end];
      if (quote) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === ">") break;
    }
    if (end >= html.length) break;

    const raw = html.slice(start, end + 1);
    const match = raw.match(/^<\s*(\/?)\s*([a-zA-Z][^\s/>]*)/);
    cursor = end + 1;
    if (!match) continue;

    const closing = match[1] === "/";
    const name = match[2].toLowerCase();
    const selfClosing = /\/\s*>$/.test(raw);
    tags.push({ raw, closing, name, selfClosing });

    if (!closing && !selfClosing && (name === "script" || name === "style")) {
      const closeStart = lowerHtml.indexOf(`</${name}`, cursor);
      if (closeStart < 0) break;
      cursor = closeStart;
    }
  }

  return tags;
}

function activeHeadMetaTags(source) {
  const explicit = [];
  const implicit = [];
  let explicitHeadSeen = false;
  let inHead = false;
  let bodySeen = false;
  let templateDepth = 0;
  let noScriptDepth = 0;

  for (const tag of scanHtmlTags(source)) {
    if (tag.name === "template") {
      if (tag.closing) {
        templateDepth = Math.max(0, templateDepth - 1);
      } else if (!tag.selfClosing) {
        templateDepth += 1;
      }
      continue;
    }

    if (templateDepth > 0) continue;

    if (tag.name === "noscript") {
      if (tag.closing) {
        noScriptDepth = Math.max(0, noScriptDepth - 1);
      } else if (!tag.selfClosing) {
        noScriptDepth += 1;
      }
      continue;
    }

    if (noScriptDepth > 0) continue;

    if (tag.name === "head") {
      if (tag.closing) {
        inHead = false;
      } else {
        explicitHeadSeen = true;
        inHead = true;
      }
      continue;
    }

    if (tag.name === "body" && !tag.closing) {
      bodySeen = true;
      inHead = false;
      continue;
    }

    if (
      !tag.closing &&
      tag.name !== "html" &&
      !HEAD_METADATA_ELEMENTS.has(tag.name) &&
      (inHead || (!explicitHeadSeen && !bodySeen))
    ) {
      bodySeen = true;
      inHead = false;
    }

    if (tag.name !== "meta" || tag.closing) continue;
    if (inHead) {
      explicit.push(tag.raw);
    } else if (!explicitHeadSeen && !bodySeen) {
      implicit.push(tag.raw);
    }
  }

  return explicitHeadSeen ? explicit : implicit;
}

export function validateRobotsMeta(source) {
  const values = [];
  const errors = [];

  for (const tag of activeHeadMetaTags(source)) {
    const { attributes, duplicates } = metaAttributes(tag);
    if ((attributes.get("name") ?? "").trim().toLowerCase() !== "robots") {
      continue;
    }

    const duplicatedSecurityAttributes = ["name", "content"].filter((name) =>
      duplicates.has(name),
    );
    if (duplicatedSecurityAttributes.length > 0) {
      errors.push(
        `the robots meta tag has duplicate ${duplicatedSecurityAttributes.join(
          " and ",
        )} attribute${duplicatedSecurityAttributes.length === 1 ? "" : "s"}`,
      );
      continue;
    }

    values.push(attributes.get("content") ?? "");
  }

  if (values.length === 0 && errors.length === 0) {
    return ["admin/index.html has no active robots meta tag in <head>"];
  }

  if (values.length > 0) {
    const missing = missingDirectives(values);
    if (missing.length > 0) {
      errors.push(`the robots meta tag is missing: ${missing.join(", ")}`);
    }
  }

  return errors;
}

export function validateAdminPublicShell({ headersSource, htmlSource }) {
  return [
    ...validateRobotsHeaders(headersSource),
    ...validateRobotsMeta(htmlSource),
  ];
}

function runCli() {
  const [, , headersPath, htmlPath] = process.argv;
  if (!headersPath || !htmlPath) {
    console.error(
      "usage: node scripts/lib/admin-public-shell.mjs <_headers> <index.html>",
    );
    return 2;
  }

  let headersSource;
  let htmlSource;
  try {
    headersSource = readFileSync(headersPath, "utf8");
    htmlSource = readFileSync(htmlPath, "utf8");
  } catch (error) {
    console.error(
      `error: could not read the Admin public-shell files: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  const errors = validateAdminPublicShell({ headersSource, htmlSource });
  for (const error of errors) console.error(`error: ${error}`);
  return errors.length === 0 ? 0 : 1;
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedUrl === import.meta.url) process.exitCode = runCli();
