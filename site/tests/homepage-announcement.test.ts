// @vitest-environment node
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HOMEPAGE_ANNOUNCEMENT as A, announcementTextStrings } from "../src/lib/homepage-announcement";
import { findGuardrailViolations } from "../src/lib/guardrails";
import { contrastRatio, meetsAA } from "../src/lib/contrast";
import { resolveTokenColor } from "./color-token-test-utils";
import { renderHomepageAnnouncement } from "../../packages/content-core/src/homepage-announcement-render";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const PUBLIC_SUBPAGE = read("../src/components/PublicSubpage.astro");

describe("shared homepage announcement renderer", () => {
  it("escapes draft text and link attributes before emitting HTML", () => {
    const html = renderHomepageAnnouncement({
      message: "<strong>Update</strong>",
      link: { label: "Watch & listen", href: '/watch/?show="news"&day=next' },
    });
    expect(html).toContain("&lt;strong&gt;Update&lt;/strong&gt;");
    expect(html).toContain("Watch &amp; listen");
    expect(html).toContain('href="/watch/?show=&quot;news&quot;&amp;day=next"');
  });

  it("omits unsafe links and requires a safe first link before the second", () => {
    const safe = { label: "Schedule", href: "/schedule/" };
    const unsafe = { label: "Unsafe", href: "//example.org/" };
    expect(renderHomepageAnnouncement({ message: "Update", link: unsafe, secondLink: safe })).not.toContain("<a ");
    const html = renderHomepageAnnouncement({ message: "Update", link: safe, secondLink: unsafe });
    expect(html).toContain('href="/schedule/"');
    expect(html).not.toContain("example.org");
  });
});

describe("homepage announcement copy", () => {
  it("states the acquisition in accurate future tense", () => {
    expect(A.heading).toBe(
      "Montclair State University will acquire NJ Spotlight.",
    );
    expect(A.link.label).toBe("Read the announcement");
  });

  it("links only to Stefanie's supplied Montclair announcement", () => {
    expect(A.link.href).toBe(
      "https://inside.montclair.edu/news/montclair-state-university-acquire-nj-spotlight-commits-continuing-its-watchdog-journalism-through",
    );
  });

  it("reuses the sourced announcement on the About page", () => {
    expect(
      (A as typeof A & { aboutDescription?: string }).aboutDescription,
    ).toBe(
      "Montclair State University will acquire NJ Spotlight and has committed to continuing its watchdog journalism through NJ PBS.",
    );
    expect(PUBLIC_SUBPAGE).toContain(
      'import { HOMEPAGE_ANNOUNCEMENT } from "../lib/homepage-announcement";',
    );
    expect(PUBLIC_SUBPAGE).toContain('heading: "NJ Spotlight News"');
    expect(PUBLIC_SUBPAGE).toContain(
      "body: [HOMEPAGE_ANNOUNCEMENT.aboutDescription]",
    );
    expect(PUBLIC_SUBPAGE).toContain(
      "{ ...HOMEPAGE_ANNOUNCEMENT.link, external: true }",
    );
  });

  it("clears the binding public-copy guardrails", () => {
    expect(findGuardrailViolations(announcementTextStrings().join("\n"))).toEqual(
      [],
    );
  });
});

describe("homepage announcement accessibility", () => {
  it.each(A.foregrounds)(
    "fg %o clears AA against the announcement surface",
    (fg) => {
      const ratio = contrastRatio(
        resolveTokenColor(fg.color),
        resolveTokenColor(A.surfaceColor),
      );
      expect(meetsAA(ratio, { large: fg.large })).toBe(true);
    },
  );
});
