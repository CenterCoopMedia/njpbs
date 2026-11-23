import { createHash } from "node:crypto";

// The extractor permits 2 MiB of XML per record. JSON escapes can take six
// bytes per source byte, with additional space needed for the envelope.
const MAX_LINE_BYTES = 13 * 1024 * 1024;
const COUNTS = { story: 0, attachment: 0, author: 0, unmappable: 0 };
const STATUSES = {
  story: ["publish", "future", "draft", "pending", "private"],
  attachment: ["inherit", "private", "publish"],
};
const REASONS = new Set([
  "invalid-scalar-field", "invalid-source-id", "invalid-date", "invalid-taxonomy",
  "ambiguous-featured-attachment", "unsupported-post-type", "password-protected-item",
  "unsupported-status", "invalid-permalink", "invalid-attachment-url", "missing-author-login", "record-limit",
]);

export class ArchiveInputError extends Error {}

export const sha256 = value => createHash("sha256").update(value).digest("hex");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const string = value => typeof value === "string" && value.isWellFormed();
const matching = (value, pattern) => string(value) && pattern.test(value);
const id = value => matching(value, /^[1-9][0-9]{0,19}$/);
const optional = (value, check) => value === null || check(value);
const keys = (value, ...required) => object(value) && Object.keys(value).length === required.length &&
  required.every(key => Object.hasOwn(value, key));

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!object(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function date(value, utc) {
  if (!matching(value, utc ? /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/ : /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/)) return false;
  const prefix = value.slice(0, 19);
  const time = new Date(`${prefix}.000Z`);
  return Number.isFinite(time.getTime()) && time.toISOString() === `${prefix}.000Z` && !prefix.startsWith("0000");
}

function webUrl(value) {
  if (!matching(value, /^https?:\/\/[^/\s\\]/i) || /[\s\\\x00-\x1f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return !!url.hostname && !url.username && !url.password && url.port !== "0" && !/^https?:\/\/[^/?#]*@/i.test(value);
  } catch {
    return false;
  }
}

function validRecord(row) {
  const { kind, revision, ...source } = row;
  if (!keys(revision, "modifiedAt", "sha256") || !optional(revision.modifiedAt, value => date(value, true)) ||
      !matching(revision.sha256, /^[a-f0-9]{64}$/)) return false;

  if (kind === "author") {
    if (!keys(source, "authorId", "login", "displayName") || !id(source.authorId) ||
        !string(source.login) || !source.login.trim() || !string(source.displayName) || revision.modifiedAt !== null) return false;
  } else {
    const attachment = kind === "attachment";
    if (!keys(source, "postId", "sourceStatus", "lifecycle", "title", "slug", "permalink", "postDate", "postDateUtc",
      "authorLogin", "taxonomy", "parentPostId", "html", "excerpt", attachment ? "attachmentUrl" : "featuredAttachmentId") ||
        !id(source.postId) || !STATUSES[kind].includes(source.sourceStatus) || source.lifecycle !== "staged" ||
        ![source.title, source.slug, source.html, source.excerpt].every(string) || !webUrl(source.permalink) ||
        !optional(source.postDate, value => date(value, false)) || !optional(source.postDateUtc, value => date(value, true)) ||
        !optional(source.authorLogin, value => string(value) && !!value.trim()) || !optional(source.parentPostId, id) ||
        !(attachment ? webUrl(source.attachmentUrl) : optional(source.featuredAttachmentId, id)) ||
        !Array.isArray(source.taxonomy) || source.taxonomy.length > 4096 || !source.taxonomy.every(term =>
          keys(term, "taxonomy", "slug", "label") && [term.taxonomy, term.slug, term.label].every(string) && !!term.taxonomy.trim() && !!term.slug.trim())) {
      return false;
    }
  }
  return sha256(canonicalJson({ kind, ...source })) === revision.sha256;
}

async function* lines(input) {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let parts = [];
  let length = 0;
  let number = 1;
  for await (const chunk of input) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      length += end - start;
      if (length > MAX_LINE_BYTES) throw new ArchiveInputError(`Line ${number} exceeds the interchange limit.`);
      parts.push(chunk.subarray(start, end));
      if (newline === -1) break;
      let row;
      try {
        row = JSON.parse(decoder.decode(Buffer.concat(parts, length)));
      } catch {
        throw new ArchiveInputError(`Invalid UTF-8 or JSON on line ${number}.`);
      }
      yield { number, row };
      number++;
      parts = [];
      length = 0;
      start = newline + 1;
    }
  }
  if (length) throw new ArchiveInputError(`Incomplete interchange line ${number}.`);
}

/** Yield validated rows and check the extractor's final tally. */
export async function* readWordPressArchive(input) {
  const counts = { ...COUNTS };
  const reasons = {};
  let complete = false;
  let source;
  for await (const { number, row } of lines(input)) {
    if (!object(row) || complete) throw new ArchiveInputError(`Unexpected row on line ${number}.`);
    if (number === 1) {
      if (!keys(row, "kind", "format", "version", "source") || row.kind !== "header" ||
          row.format !== "wordpress-archive" || row.version !== 1 || !matching(row.source, /^[a-z0-9][a-z0-9-]{0,62}$/)) {
        throw new ArchiveInputError("Expected a WordPress archive version 1 header.");
      }
      source = row.source;
    } else if (row.kind === "summary") {
      const matches = (actual, expected) => keys(actual, ...Object.keys(expected)) &&
        Object.keys(expected).every(key => actual[key] === expected[key]);
      if (!keys(row, "kind", "counts", "reasons") || !matches(row.counts, counts) || !matches(row.reasons, reasons)) {
        throw new ArchiveInputError(`Interchange summary does not match the rows on line ${number}.`);
      }
      complete = true;
    } else if (row.kind === "unmappable") {
      if (!keys(row, "kind", "entity", "ordinal", "reason") || !["item", "author"].includes(row.entity) ||
          row.ordinal !== number - 1 || !REASONS.has(row.reason)) {
        throw new ArchiveInputError(`Invalid unmappable record on line ${number}.`);
      }
      counts.unmappable++;
      reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
      yield { source, number, row };
    } else {
      if (!["story", "attachment", "author"].includes(row.kind) || !validRecord(row)) {
        throw new ArchiveInputError(`Invalid archive record or revision on line ${number}.`);
      }
      counts[row.kind]++;
      yield { source, number, row };
    }
  }
  if (!complete) throw new ArchiveInputError("The interchange file has no complete summary.");
}
