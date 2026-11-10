// @vitest-environment node
// Unit spec for the shared Pagefind index reader (issues #226, #496, #228).
//
// Every scan we want over the generated index is a question about what is inside
// dist/pagefind/, and all three of them break the same way if asked the obvious
// way: Pagefind writes each fragment gzipped, so a text search over that
// directory finds nothing regardless of what the index actually contains.
//
// Measured on a synthetic build 2026-07-31: a fragment whose decompressed body is
//   pagefind_dcd{"url":"/wiki/secret.html","content":"Internal runbook. ..."}
// returns zero hits for both `/wiki/` and the body text under `grep -rc` over
// dist/pagefind/. That is a silent failure in both directions. Pointed at an
// exclusion guard (#226 internal and retired-route scope, #496 transcript bodies) it passes
// green while the content is fully indexed. Pointed at an inclusion assertion
// (#228 catalog coverage) it reports the catalog missing when it is present.
//
// So the decompression lives in one module the three scans share, and the trap
// itself is pinned as a test below, because the failure mode is invisible: the
// naive version does not error, it just answers the wrong question convincingly.
import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import * as pagefind from "pagefind";
import {
  PAGEFIND_FRAGMENT_PREFIX,
  decodePagefindFragment,
  findRedactedUrls,
  findBannedContent,
} from "../src/lib/pagefind-index";

// Build a fragment byte-for-byte the way Pagefind writes one: the magic prefix,
// then the JSON body, gzipped whole.
const fragment = (url: string, content: string): Buffer =>
  gzipSync(
    Buffer.from(
      `${PAGEFIND_FRAGMENT_PREFIX}${JSON.stringify({
        url,
        content,
        word_count: content.split(/\s+/).length,
      })}`,
      "utf8",
    ),
  );

const WIKI = fragment("/wiki/secret.html", "Internal runbook. Passphrase rotation notes.");
const PUBLIC = fragment("/about/", "About NJ PBS and the transition.");

it("whole-page exclusion overrides nested body markers, even without eligible pages", async () => {
  const { index } = await pagefind.createIndex();
  if (!index) throw new Error("Pagefind index was not created");
  try {
    await index.addHTMLFile({
      url: "/preview/",
      content: '<html lang="en" data-pagefind-ignore="all"><head><title>Private draft</title></head><body><main data-pagefind-body>Private draft content</main></body></html>',
    });
    const excluded = await index.getFiles();
    expect(excluded.errors).toEqual([]);
    expect(excluded.files?.filter((file) => file.path.includes("fragment/"))).toEqual([]);
    await index.addHTMLFile({
      url: "/about/",
      content: '<html lang="en"><body><main data-pagefind-body>Public station information</main></body></html>',
    });
    const mixed = await index.getFiles();
    expect(mixed.errors).toEqual([]);
    expect(mixed.files?.filter((file) => file.path.includes("fragment/"))
      .map((file) => decodePagefindFragment(file.content).url)).toEqual(["/about/"]);
  } finally {
    await index.deleteIndex();
    await pagefind.close();
  }
});

describe("decodePagefindFragment", () => {
  it("decompresses a fragment and reads its url and content", () => {
    expect(decodePagefindFragment(WIKI)).toEqual({
      url: "/wiki/secret.html",
      content: "Internal runbook. Passphrase rotation notes.",
    });
  });

  it("strips the pagefind_dcd magic prefix ahead of the JSON", () => {
    // Parsing the decompressed bytes from offset zero throws, because the body
    // is not JSON until the prefix is removed. Pinned so a rewrite that reaches
    // for JSON.parse(raw) fails here rather than in CI against a real build.
    const raw = gzipSync(Buffer.from(`${PAGEFIND_FRAGMENT_PREFIX}{"url":"/a/","content":"x"}`));
    expect(() => decodePagefindFragment(raw)).not.toThrow();
    expect(decodePagefindFragment(raw).url).toBe("/a/");
  });

  it("fails loudly on input that is not a gzipped fragment", () => {
    // An unreadable fragment must never decode to an empty result: that is the
    // shape that makes a leak scan report clean.
    expect(() => decodePagefindFragment(Buffer.from("not gzip"))).toThrow(
      /not a gzipped pagefind fragment/i,
    );
  });

  it("fails loudly when a fragment omits url or content", () => {
    // Same rule as the branch above, one layer in. A fragment that parses but
    // carries neither field is exactly as unreadable as one that will not
    // decompress, and defaulting the fields to "" would hide that behind a
    // fragment that reads as a real, empty, public page: it counts toward a
    // healthy fragment total, its empty url is under no redacted prefix, and
    // its empty body matches no banned pattern. A Pagefind release that renamed
    // these keys would then turn every guard built on this module green.
    const missing = (json: string) =>
      gzipSync(Buffer.from(`${PAGEFIND_FRAGMENT_PREFIX}${json}`));

    expect(() => decodePagefindFragment(missing('{"content":"x"}'))).toThrow(
      /missing url or content/i,
    );
    expect(() => decodePagefindFragment(missing('{"url":"/a/"}'))).toThrow(
      /missing url or content/i,
    );
    // A non-string of the right key name is the same failure, not a coercion.
    expect(() =>
      decodePagefindFragment(missing('{"url":null,"content":"x"}')),
    ).toThrow(/missing url or content/i);
  });

  it("the naive text scan this module exists to replace finds nothing", () => {
    // The regression this whole module guards. The url and the body text are
    // both plainly present once decompressed, and both invisible to a scan of
    // the stored bytes. If a future change stores fragments uncompressed this
    // assertion flips and the module can be reconsidered on purpose.
    expect(WIKI.includes(Buffer.from("/wiki/"))).toBe(false);
    expect(WIKI.includes(Buffer.from("Passphrase"))).toBe(false);

    const decoded = decodePagefindFragment(WIKI);
    expect(decoded.url).toContain("/wiki/");
    expect(decoded.content).toContain("Passphrase");
  });
});

describe("findRedactedUrls", () => {
  const REDACTED = ["/wiki/", "/prototype/"] as const;

  it("names every fragment whose url is under a redacted prefix", () => {
    const frags = [WIKI, PUBLIC, fragment("/prototype/draft/", "Draft copy.")].map(
      decodePagefindFragment,
    );
    expect(findRedactedUrls(frags, REDACTED)).toEqual([
      "/wiki/secret.html",
      "/prototype/draft/",
    ]);
  });

  it("returns nothing for an index that only carries public pages", () => {
    const frags = [PUBLIC, fragment("/give/", "Support NJ PBS.")].map(decodePagefindFragment);
    expect(findRedactedUrls(frags, REDACTED)).toEqual([]);
  });

  it("does not flag a public url that merely contains a redacted word", () => {
    // /wiki/ is redacted; an editorial page about the station wiki
    // is not. The check is a path-prefix test, not a substring test.
    const frags = [fragment("/about/our-wiki/", "Station design.")].map(
      decodePagefindFragment,
    );
    expect(findRedactedUrls(frags, REDACTED)).toEqual([]);
  });
});

describe("findBannedContent", () => {
  it("names the fragment and the match when banned text enters the index", () => {
    // ADR 0016: transcript bodies must never be indexed (#496).
    const frags = [
      PUBLIC,
      fragment("/watch/show/ep-1/", "Full transcript follows: welcome back to the program."),
    ].map(decodePagefindFragment);

    expect(findBannedContent(frags, [/full transcript follows/i])).toEqual([
      { url: "/watch/show/ep-1/", match: "Full transcript follows" },
    ]);
  });

  it("returns nothing when no fragment carries banned text", () => {
    expect(findBannedContent([decodePagefindFragment(PUBLIC)], [/full transcript follows/i])).toEqual(
      [],
    );
  });
});
