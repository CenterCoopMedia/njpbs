// Shared reader for the generated Pagefind index.
//
// Pagefind fragments contain gzipped bytes with a magic prefix before the JSON.
// Search guards must decode that content before checking excluded routes,
// transcript text and complete catalog coverage. Searching compressed bytes
// could miss indexed private text or incorrectly report public pages absent.
// Malformed fragments refuse rather than appearing empty.
//
// This module decodes bytes and queries fragments; callers read the directory.

import { gunzipSync } from "node:zlib";

/** The magic prefix Pagefind writes ahead of a fragment's JSON body. */
export const PAGEFIND_FRAGMENT_PREFIX = "pagefind_dcd";

/** The part of a Pagefind fragment the scans ask questions about. */
export interface PagefindFragment {
  /** The site-root-relative url of the indexed page, e.g. "/about/". */
  url: string;
  /** The indexed body text Pagefind will return as a search excerpt. */
  content: string;
}

/** A banned-text hit: which page carried it, and the text that matched. */
export interface BannedContentHit {
  url: string;
  match: string;
}

/**
 * Decode one `.pf_fragment` file's bytes into its url and indexed content.
 *
 * Throws rather than returning an empty fragment when the input is unreadable.
 * An exclusion guard that treats "could not read this" as "nothing bad in here"
 * is the precise failure this module exists to prevent, so there is deliberately
 * no lenient path.
 */
export function decodePagefindFragment(raw: Uint8Array): PagefindFragment {
  let body: string;
  try {
    body = gunzipSync(raw).toString("utf8");
  } catch (cause) {
    throw new Error(
      "not a gzipped pagefind fragment: the index could not be read, which must " +
        "never be reported as an index with nothing in it",
      { cause },
    );
  }

  // The JSON starts after the magic prefix. Locating the first brace rather than
  // slicing a fixed width keeps this working if the prefix ever changes length.
  const start = body.indexOf("{");
  if (start === -1) {
    throw new Error("pagefind fragment carries no JSON body");
  }

  const parsed = JSON.parse(body.slice(start)) as Partial<PagefindFragment>;

  // Fail closed when either field is absent, for the same reason the gunzip
  // branch above does. Defaulting them to "" hands every caller a fragment that
  // reads as a real, empty, public page: the fragment count still looks healthy,
  // an empty url matches no redacted prefix, and an empty body matches no banned
  // pattern. So a Pagefind release that renamed these keys would not fail the
  // build, it would turn every guard here green while indexing anything.
  if (typeof parsed.url !== "string" || typeof parsed.content !== "string") {
    throw new Error(
      "pagefind fragment is missing url or content: a fragment that cannot be " +
        "read must never be reported as an empty public page",
    );
  }

  return { url: parsed.url, content: parsed.content };
}

/**
 * The urls in `fragments` that sit under one of `redactedPrefixes`.
 *
 * Prefix test, not substring: `/wiki/` is redacted while an editorial
 * page at `/about/our-wiki/` is a normal public page and must not trip
 * the guard.
 */
export function findRedactedUrls(
  fragments: readonly PagefindFragment[],
  redactedPrefixes: readonly string[],
): string[] {
  return fragments
    .filter((fragment) => redactedPrefixes.some((prefix) => fragment.url.startsWith(prefix)))
    .map((fragment) => fragment.url);
}

/**
 * Every fragment whose indexed content matches one of `patterns`, with the text
 * that matched, so a failure names the page and the offending phrase instead of
 * only asserting that something somewhere is wrong.
 *
 * Matching goes through String.match rather than RegExp.exec because exec keeps
 * lastIndex on a /g pattern, which would silently skip hits from one fragment to
 * the next depending on where the previous match ended.
 */
export function findBannedContent(
  fragments: readonly PagefindFragment[],
  patterns: readonly RegExp[],
): BannedContentHit[] {
  const hits: BannedContentHit[] = [];
  for (const fragment of fragments) {
    for (const pattern of patterns) {
      const found = fragment.content.match(pattern);
      if (found) {
        hits.push({ url: fragment.url, match: found[0] });
        break;
      }
    }
  }
  return hits;
}
