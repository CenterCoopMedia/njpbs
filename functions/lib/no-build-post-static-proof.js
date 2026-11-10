"use strict";
// Pure static-proof parsing, shared by live admission and immutable replay.
const { isDeepStrictEqual } = require("node:util");
const { outputForPath } = require("./post-background-paths");
const { isServerMintableSlugShape } = require("./post-slug-contract");

const INPUT_FIELDS = ["schemaVersion", "postId", "operationId", "sourceVersion", "visible", "slug", "ownedSlugs", "snapshotDigest", "contextDigest"];
const PROOF_FIELDS = [...INPUT_FIELDS, "files"];
const MAX_FILES = 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
function refuse(message = "The static Post return no longer matches its admitted publication.") {
  throw Object.assign(new Error(message), { status: 409 });
}
function exactFields(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key));
}
function projectStaticInput(value) {
  if (!exactFields(value, INPUT_FIELDS) || value.schemaVersion !== 1 ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.postId ?? "") || !/^[A-Za-z0-9]{20}$/.test(value.operationId ?? "") ||
      !Number.isSafeInteger(value.sourceVersion) || value.sourceVersion < 1 || typeof value.visible !== "boolean" ||
      !isServerMintableSlugShape(value.slug) || !Array.isArray(value.ownedSlugs) || value.ownedSlugs.length < 1 ||
      value.ownedSlugs.length > 100 || value.ownedSlugs.some(slug => !isServerMintableSlugShape(slug)) ||
      !isDeepStrictEqual(value.ownedSlugs, [...new Set(value.ownedSlugs)].sort()) || !value.ownedSlugs.includes(value.slug) ||
      !/^[a-f0-9]{64}$/.test(value.snapshotDigest ?? "") || !/^[a-f0-9]{64}$/.test(value.contextDigest ?? "")) refuse();
  return { ...value, ownedSlugs: [...value.ownedSlugs] };
}
function projectStaticProof(value) {
  if (!exactFields(value, PROOF_FIELDS)) refuse("The static Post proof is invalid.");
  const { files, ...input } = value;
  projectStaticInput(input);
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) refuse();
  let total = 0;
  const paths = new Set();
  for (const file of files) {
    if (!exactFields(file, ["path", "bytes", "digest"]) || typeof file.path !== "string" ||
        file.path.length > 256 || !file.path.startsWith("/") || /[%?#\\\s]/.test(file.path) ||
        new URL(file.path, "https://njpbs.org").pathname !== file.path || file.path.startsWith("//") ||
        !(outputForPath(file.path) || input.ownedSlugs.some(slug => file.path === `/posts/${slug}/`) ||
          ["/_publication.json", "/_content-status.json"].includes(file.path)) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > MAX_FILE_BYTES ||
        !/^[a-f0-9]{64}$/.test(file.digest ?? "") || paths.has(file.path)) refuse();
    paths.add(file.path);
    total += file.bytes;
  }
  if (total > MAX_TOTAL_BYTES || !["/posts/", "/feeds/news.xml", "/api/v1/content.json", "/pagefind/pagefind.js",
    "/search/meaning-index.json", "/_publication.json", "/_content-status.json"].every(path => paths.has(path)) ||
      (!paths.has("/sitemap-index.xml") && !paths.has("/sitemap.xml")) ||
      (input.visible && !paths.has(`/posts/${input.slug}/`)) ||
      (!input.visible && input.ownedSlugs.some(slug => paths.has(`/posts/${slug}/`)))) refuse();
  return { ...input, files: files.map(file => ({ ...file })) };
}

// A static proof without its file list is the input it was built from.
function staticProofInput(proof) {
  return Object.fromEntries(Object.entries(proof).filter(([key]) => key !== "files"));
}
module.exports = { MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, projectStaticInput, projectStaticProof, staticProofInput };
