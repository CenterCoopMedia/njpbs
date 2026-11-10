// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { donateUrl, passportLookupUrl } from "../src/data/launch-fallback";

const readPage = (slug: string) =>
  readFileSync(new URL(`../src/content/pages/${slug}.md`, import.meta.url), "utf8");

describe("accepted transition FAQ and contact help pages", () => {
  it("publishes the accepted public FAQ content", () => {
    const text = readPage("faq");

    expect(text).toContain("What is changing at NJ PBS?");
    expect(text).toContain("Beginning July 1, 2026, Montclair State University is the new operator of NJ PBS.");
    expect(text).toContain("Does my existing access to PBS Passport continue without interruption?");
    expect(text).toContain("PBS manages Passport account status");
    expect(text).toContain(
      `<a href="${passportLookupUrl}" rel="noopener" target="_blank">PBS Passport lookup tool<span class="sr-only"> (opens in new tab)</span></a>`,
    );
    expect(text).not.toContain("through July 31, 2026");
    expect(text).not.toContain("before July 31, 2026");
    expect(text).toContain(donateUrl);
    expect(text).toContain("Email [njpbs@montclair.edu](mailto:njpbs@montclair.edu?subject=NJ%20PBS%20question) or call [800-882-6622](tel:+18008826622).");
    expect(text).not.toContain("Who processes donations now?");
    expect(text).not.toContain("The Montclair State University Foundation will process donations this summer.");
    expect(text).not.toContain("Member email draft");
    expect(text).not.toContain("Internal Slack post");
  });

  it("does not send recurring donors to a nonexistent NJ PBS account sign-in (#285)", () => {
    const text = readPage("faq");
    const normalized = text.replace(/\s+/g, " ");

    // give.njpbs.org is shut down and no dedicated NJ PBS sign-in exists yet, so
    // the removed instruction to "sign in to the new NJ PBS system" must not come
    // back. This is the load-bearing guard. Check the whitespace-normalized text,
    // not the raw markdown, so a reintroduction wrapped across a line break
    // (".. new NJ PBS\nsystem ..") cannot slip past the assertion.
    expect(normalized).not.toContain("sign in to the new NJ PBS system");

    // The real invariant is that the "What happens to my recurring donation?"
    // answer and the adjacent "Do I need to do anything right now?" answer must
    // not diverge: both route to the donation portal with no login. Pin each
    // answer's routing by a contiguous phrase unique to it, so benign copy edits
    // do not break the test while a reverted sign-in step would.
    expect(normalized).toContain(
      "set up a new monthly recurring gift through the new donation portal",
    );
    expect(normalized).toContain(
      "make a one-time donation through the new donation portal",
    );
  });

  it("publishes contact information on a local page instead of relying on mailto navigation", () => {
    const text = readPage("contact");

    expect(text).toContain("[njpbs@montclair.edu](mailto:njpbs@montclair.edu?subject=NJ%20PBS%20question)");
    expect(text).toContain("[800-882-6622](tel:+18008826622)");
    expect(text).toContain("(faq.md)");
    expect(text).toContain("(accessibility.md)");
  });
});
