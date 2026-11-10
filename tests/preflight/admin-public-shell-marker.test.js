import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  validateAdminPublicShell,
  validateRobotsHeaders,
  validateRobotsMeta,
} from "../../scripts/lib/admin-public-shell.mjs";

const VALIDATOR = fileURLToPath(
  new URL("../../scripts/lib/admin-public-shell.mjs", import.meta.url),
);
const HEADERS = fileURLToPath(
  new URL("../../admin/public/_headers", import.meta.url),
);
const INDEX = fileURLToPath(
  new URL("../../admin/index.html", import.meta.url),
);

describe("Admin public-shell robots policy", () => {
  it("accepts the canonical spaced directives in current source", () => {
    const headersSource = readFileSync(HEADERS, "utf8");
    const htmlSource = readFileSync(INDEX, "utf8");

    expect(validateAdminPublicShell({ headersSource, htmlSource })).toEqual([]);
    expect(() =>
      execFileSync(process.execPath, [VALIDATOR, HEADERS, INDEX], {
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it("accepts insignificant whitespace, case, ordering, and extra directives", () => {
    expect(
      validateRobotsHeaders(
        "/*\n  x-robots-tag: NOARCHIVE,noindex, nofollow, nosnippet\n",
      ),
    ).toEqual([]);
    expect(
      validateRobotsMeta(
        "<META content='nofollow, noarchive, NOINDEX, nosnippet' NAME='Robots'>",
      ),
    ).toEqual([]);
  });

  it("combines repeated unscoped robots declarations", () => {
    expect(
      validateRobotsHeaders(
        "/*\n  X-Robots-Tag: noindex\n  X-Robots-Tag: nofollow, noarchive\n",
      ),
    ).toEqual([]);
    expect(
      validateRobotsMeta(
        '<meta name="robots" content="noindex"><meta name="robots" content="nofollow,noarchive">',
      ),
    ).toEqual([]);
  });

  it("does not count user-agent-scoped header directives globally", () => {
    expect(
      validateRobotsHeaders(
        [
          "/*",
          "  X-Robots-Tag: noindex, noarchive",
          "  X-Robots-Tag: googlebot: noindex, nofollow",
          "",
        ].join("\n"),
      ),
    ).toEqual(["the global X-Robots-Tag is missing: nofollow"]);

    expect(
      validateRobotsHeaders(
        [
          "/*",
          "  X-Robots-Tag: noindex, noarchive",
          "  X-Robots-Tag: googlebot: noindex, nofollow",
          "  X-Robots-Tag: nofollow",
          "",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("rejects a header that is missing or weaker than the required policy", () => {
    expect(validateRobotsHeaders("/*\n  Cache-Control: no-store\n")).toEqual([
      "the global /* rule has no X-Robots-Tag header",
    ]);
    expect(
      validateRobotsHeaders("/*\n  X-Robots-Tag: noindex, nofollow\n"),
    ).toEqual(["the global X-Robots-Tag is missing: noarchive"]);
    expect(
      validateRobotsHeaders(
        "/private/*\n  X-Robots-Tag: noindex, nofollow, noarchive\n",
      ),
    ).toEqual(["admin/public/_headers has no global /* rule"]);
  });

  it("rejects route-level robots removals and weaker overrides", () => {
    const globalPolicy =
      "/*\n  X-Robots-Tag: noindex, nofollow, noarchive\n";

    expect(
      validateRobotsHeaders(
        `${globalPolicy}/preview/*\n  ! X-Robots-Tag\n`,
      ),
    ).toEqual([
      "the /preview/* rule removes the required X-Robots-Tag header",
    ]);

    expect(
      validateRobotsHeaders(
        `${globalPolicy}/preview/*\n  X-Robots-Tag: noindex\n`,
      ),
    ).toEqual([
      "the /preview/* X-Robots-Tag override is missing: nofollow, noarchive",
    ]);

    expect(
      validateRobotsHeaders(
        `${globalPolicy}/preview/*\n  X-Robots-Tag: noarchive, nofollow, noindex\n`,
      ),
    ).toEqual([]);
  });

  it("rejects a meta tag that is missing or weaker than the required policy", () => {
    expect(validateRobotsMeta("<head><title>Admin</title></head>")).toEqual([
      "admin/index.html has no active robots meta tag in <head>",
    ]);
    expect(
      validateRobotsMeta('<meta name="robots" content="noindex, nofollow">'),
    ).toEqual(["the robots meta tag is missing: noarchive"]);
    expect(
      validateRobotsMeta(
        '<!-- <meta name="robots" content="noindex,nofollow,noarchive"> -->',
      ),
    ).toEqual([
      "admin/index.html has no active robots meta tag in <head>",
    ]);
  });

  it("only accepts active robots metadata in the document head", () => {
    const marker =
      '<meta name="robots" content="noindex,nofollow,noarchive">';

    for (const html of [
      `<html><head><script>const marker = ${JSON.stringify(marker)};</script></head></html>`,
      `<html><head><style>/* ${marker} */</style></head></html>`,
      `<html><head><template>${marker}</template></head></html>`,
      `<html><head><title>Admin</title></head><body>${marker}</body></html>`,
    ]) {
      expect(validateRobotsMeta(html)).toEqual([
        "admin/index.html has no active robots meta tag in <head>",
      ]);
    }

    expect(
      validateRobotsMeta(`<html><head>${marker}</head><body></body></html>`),
    ).toEqual([]);
  });

  it("rejects duplicate security-relevant meta attributes", () => {
    expect(
      validateRobotsMeta(
        '<head><meta name="robots" content="index,follow" content="noindex,nofollow,noarchive"></head>',
      ),
    ).toEqual(["the robots meta tag has duplicate content attribute"]);

    expect(
      validateRobotsMeta(
        '<head><meta name="robots" name="viewport" content="noindex,nofollow,noarchive"></head>',
      ),
    ).toEqual(["the robots meta tag has duplicate name attribute"]);
  });
});
