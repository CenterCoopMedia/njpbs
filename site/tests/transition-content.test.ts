// @vitest-environment node
// Pins the transition callout (#284), the captions-help notes (#290),
// and the press/media contact line (#288) that were added to the giving-family,
// live/closed-captioning, and contact/about pages. These specs read the page and
// component sources off disk, so they run in the Node environment.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { givingTransitionNotice, passportLookupUrl, transitionNoticeSlugs } from "../src/data/launch-fallback";

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

// Collapse runs of whitespace so assertions survive markdown line wrapping and
// Astro template indentation.
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const withoutLinkMarkup = (s: string) =>
  s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<span class="sr-only">.*?<\/span>/gs, "")
    .replace(/<\/?a\b[^>]*>/g, "");

const FAQ = read("../src/content/pages/faq.md");
const CLOSED_CAPTIONING = read("../src/content/pages/closed-captioning.md");
const CONTACT = read("../src/content/pages/contact.md");
const SUBPAGE = read("../src/components/PublicSubpage.astro");

describe("transition callout on the giving-family pages (#284)", () => {
  it("is wired to /give/, /support/, /passport/, and /donate/", () => {
    expect([...transitionNoticeSlugs].sort()).toEqual([
      "donate",
      "give",
      "passport",
      "support",
    ]);
  });

  it("repeats the FAQ wording verbatim, so it introduces no new claim", () => {
    // The callout copy must match the live /faq/ answers exactly. Tying the two
    // together means a later change to the FAQ guidance forces the callout to
    // change with it (and vice versa) instead of silently drifting apart.
    const faq = collapse(withoutLinkMarkup(FAQ));
    for (const paragraph of givingTransitionNotice.paragraphs) {
      expect(faq).toContain(collapse(paragraph));
    }
  });

  it("carries the donation cutoff and current Passport help", () => {
    const text = collapse(givingTransitionNotice.paragraphs.join(" "));
    expect(text).toContain("June 30, 2026");
    expect(text).toContain("PBS manages Passport account status");
    expect(text).not.toContain("July 31, 2026");
  });

  it("links both the full FAQ and the PBS Passport lookup from the page body", () => {
    expect(givingTransitionNotice.links).toEqual([
      { label: "See the full transition FAQ", href: "/faq/" },
      { label: "Look up Passport access", href: passportLookupUrl, external: true },
    ]);
    expect(FAQ).toContain(
      `<a href="${passportLookupUrl}" rel="noopener" target="_blank">PBS Passport lookup tool<span class="sr-only"> (opens in new tab)</span></a>`,
    );
  });
});

describe("captions-help notes on live and closed-captioning (#290)", () => {
  it("adds a 'Watching with captions' section to the live page", () => {
    expect(SUBPAGE).toContain("Watching with captions");
    expect(collapse(SUBPAGE)).toContain(
      "use the CC, or closed-caption, control in the PBS player toolbar",
    );
  });

  it("leads closed-captioning with how to turn captions on, cross-linking live and accessibility", () => {
    expect(collapse(CLOSED_CAPTIONING)).toContain(
      "Captions are available on NJ PBS programming",
    );
    expect(CLOSED_CAPTIONING).toContain("(live.md)");
    expect(CLOSED_CAPTIONING).toContain("(accessibility.md)");
  });

  it("keeps the FCC certification and complaint sections intact", () => {
    expect(CLOSED_CAPTIONING).toContain(
      "## Closed-captioning quality certification",
    );
    expect(CLOSED_CAPTIONING).toContain("## Written complaints");
    expect(CLOSED_CAPTIONING).toContain("fcc.gov/accessibilitycomplaints");
  });
});

describe("press and media contact line (#288)", () => {
  it("adds a labeled press line to the contact page", () => {
    expect(collapse(CONTACT)).toContain("For press and media inquiries, contact");
    expect(CONTACT).toContain(
      "[njpbs@montclair.edu](mailto:njpbs@montclair.edu?subject=Press%20inquiry)",
    );
  });

  it("adds a matching press line to the about page's how-to-reach-us block", () => {
    expect(SUBPAGE).toContain(
      "For press and media inquiries, email njpbs@montclair.edu.",
    );
  });
});
