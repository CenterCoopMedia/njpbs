import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("CMS image fetch boundary", () => {
  it("admits only the station R2 path and the exact current site-seed path", () => {
    const config = read("astro.config.mjs");

    expect(config).toContain('hostname: "media.njpbs.org"');
    expect(config).toContain('pathname: "/cms-media/**"');
    expect(config).toContain('hostname: "njpbs.org"');
    expect(config).toContain('pathname: "/brand/**"');
    expect(config.match(/remotePatterns/g)).toHaveLength(1);
    expect(config.match(/hostname:/g)).toHaveLength(2);
    expect(config.match(/pathname:/g)).toHaveLength(2);
    expect(config).not.toMatch(/\bdomains\s*:/);
    expect(config).not.toMatch(/hostname:\s*["']\*\./);
  });

  it("keeps the custom media origin in the versioned browser CSP", () => {
    expect(read("public/_headers")).toMatch(
      /img-src[^\n]*https:\/\/media\.njpbs\.org/,
    );
    expect(read("public/_headers")).toMatch(
      /media-src 'self' https:\/\/media\.njpbs\.org;/,
    );
  });

  it("requires MIME and positive dimensions in the Astro content projection", () => {
    const config = read("src/content.config.ts");

    expect(config).toContain("mimeType: z.enum(");
    expect(config).toContain("width: z.number().int().positive(),");
    expect(config).toContain("height: z.number().int().positive(),");
    expect(config).not.toContain("width: z.number().int().positive().optional()");
    expect(config).not.toContain("height: z.number().int().positive().optional()");
  });
});
