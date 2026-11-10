// Which cmsPosts record kinds have a public route, and where that route lives.
//
// This is the one contract three separate boundaries read (#923): the Admin
// lifecycle panel, which decides whether Publish now and Schedule are shown at
// all; the publish snapshot writer in Functions, which refuses to freeze a kind
// no build can render; and the public build, which turns an admitted snapshot
// into a route. Before this module each of those asked `type === "post"` in its
// own words, so opening a second kind meant finding every one of them.
//
// The Functions bundle is uploaded as its own CommonJS source and cannot import
// the TypeScript core, so it carries a hand-written mirror, exactly like the
// status vocabulary and the block model. The parity cases below are what keep
// the two from drifting: a kind opened in one and not the other is either an
// Admin button whose server action refuses, or a server that freezes a snapshot
// no route emits.

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
  LIBRARY_ONLY_RECORD_KINDS,
  PUBLICLY_ROUTED_RECORD_KINDS,
  publicRouteBaseForRecordKind,
  recordKindHasPublicRoute,
} from "../../packages/content-core/src/public-record-kinds";
import { EDITORIAL_TYPES } from "../../packages/content-core/src/content-model";
import { classify } from "../src/lib/legacy-redirects";

const require = createRequire(import.meta.url);
const mirror = require("../../functions/lib/public-record-kinds.js");

describe("the publicly routed record kinds", () => {
  it("names post and program, and only those, in this slice", () => {
    expect([...PUBLICLY_ROUTED_RECORD_KINDS].sort()).toEqual(["event", "post", "program"]);
  });

  it("keeps every other record kind library-only", () => {
    expect([...LIBRARY_ONLY_RECORD_KINDS].sort()).toEqual([
      "newsletter",
      "sponsor",
      "staff",
    ]);
  });

  it("partitions the record kinds exactly, with no kind in both halves", () => {
    expect(
      [...PUBLICLY_ROUTED_RECORD_KINDS, ...LIBRARY_ONLY_RECORD_KINDS].sort(),
    ).toEqual([...EDITORIAL_TYPES].sort());
  });

  it("answers the routed question for a real kind", () => {
    expect(recordKindHasPublicRoute("post")).toBe(true);
    expect(recordKindHasPublicRoute("program")).toBe(true);
    expect(recordKindHasPublicRoute("event")).toBe(true);
    expect(recordKindHasPublicRoute("staff")).toBe(false);
  });

  it("fails closed for a kind it does not know", () => {
    // A retired kind, a page, an empty string, and the prototype-pollution
    // names a plain object lookup would answer truthfully.
    for (const value of [
      "article",
      "page",
      "",
      "Post",
      "constructor",
      "__proto__",
      "toString",
    ]) {
      expect(recordKindHasPublicRoute(value), value).toBe(false);
      expect(publicRouteBaseForRecordKind(value), value).toBeNull();
    }
  });

  it("gives each routed kind a distinct, directory-shaped route base", () => {
    expect(publicRouteBaseForRecordKind("post")).toBe("/posts/");
    expect(publicRouteBaseForRecordKind("program")).toBe("/programs/");
    expect(publicRouteBaseForRecordKind("event")).toBe("/events/");
    const bases = PUBLICLY_ROUTED_RECORD_KINDS.map((kind) =>
      publicRouteBaseForRecordKind(kind),
    );
    expect(new Set(bases).size).toBe(bases.length);
    for (const base of bases) {
      expect(base?.startsWith("/")).toBe(true);
      expect(base?.endsWith("/")).toBe(true);
    }
  });

  it("gives a library-only kind no route base to publish into", () => {
    for (const kind of LIBRARY_ONLY_RECORD_KINDS) {
      expect(publicRouteBaseForRecordKind(kind), kind).toBeNull();
    }
  });

  // A routed record must remain reachable through the edge classifier.
  it("never puts a routed kind inside a namespace the edge answers as gone", () => {
    for (const kind of PUBLICLY_ROUTED_RECORD_KINDS) {
      const base = publicRouteBaseForRecordKind(kind)!;
      expect(classify(`${base}a-real-record/`), kind).toBeNull();
      expect(classify(base), kind).toBeNull();
    }
  });
});

describe("the Functions CommonJS mirror", () => {
  it("carries exactly the canonical routed kinds", () => {
    expect([...mirror.PUBLICLY_ROUTED_RECORD_KINDS].sort()).toEqual(
      [...PUBLICLY_ROUTED_RECORD_KINDS].sort(),
    );
  });

  it("answers the routed question identically for every kind and non-kind", () => {
    for (const value of [
      ...EDITORIAL_TYPES,
      "article",
      "page",
      "",
      "Post",
      "constructor",
      "__proto__",
    ]) {
      expect(mirror.recordKindHasPublicRoute(value), value).toBe(
        recordKindHasPublicRoute(value),
      );
    }
  });

  it("agrees on every route base", () => {
    for (const value of [...EDITORIAL_TYPES, "article", "__proto__"]) {
      expect(mirror.publicRouteBaseForRecordKind(value), value).toBe(
        publicRouteBaseForRecordKind(value),
      );
    }
  });
});
