// @vitest-environment node
// This spec reads the page markdown off disk, so it needs the Node environment
// (the suite default, happy-dom, gives import.meta.url an http: URL that
// fileURLToPath rejects).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isPublicPageId } from "../../packages/content-core/src/public-pages";
import { pageCompositionSeed } from "../../packages/content-core/src/page-composition-seeds";
import { launchArticlePageSlugs } from "../src/data/launch-fallback";
import GithubSlugger from "github-slugger";

// Public compliance pages must retain their statutory links and section structure.

const PAGES_DIR = fileURLToPath(
  new URL("../src/content/pages/", import.meta.url),
);

function pagePath(slug: string): string {
  return `${PAGES_DIR}${slug}.md`;
}

function pageText(slug: string): string {
  return readFileSync(pagePath(slug), "utf8");
}

// The frontmatter block between the first two `---` fences. A substring match
// over this block is enough for the structural checks below; no YAML dep needed.
function frontmatter(slug: string): string {
  const m = pageText(slug).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : "";
}

// A page "declares sections" when its frontmatter has a `sections:` key followed
// by at least one `- ` list item before the next top-level key.
function declaredSections(slug: string): string[] {
  const block = frontmatter(slug).match(/\r?\nsections:\r?\n([\s\S]*?)(?:\r?\n\w|$)/);
  if (!block) return [];
  return [...block[1].matchAll(/^\s*-\s*"?([^"\n]+)"?\s*$/gm)].map((x) =>
    x[1].trim(),
  );
}

// The body text of a `## <heading>` section: the lines from that heading to the
// next `## ` heading (or end of file). The frontmatter is stripped first, so a
// heading name that also appears in the frontmatter `sections:` list cannot
// satisfy a body-level assertion, and content asserted here cannot silently
// drift into a different section.
//
// HTML comments are stripped for the same reason. rehypeStripComments keeps them out
// of the rendered page, so a phrase sitting in a comment is text no reader ever sees,
// and an assertion it satisfied would be claiming the page says something it does not.
// These pages use comments to hold drafting notes about copy that was deliberately
// left out, which is exactly the text most likely to collide with an assertion.
function sectionBody(slug: string, heading: string): string {
  const body = pageText(slug)
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

// The four NJ PBS transmitters are licensed to the state authority (NJPBA).
// Each call sign has one online FCC public inspection file.
const NJ_PBS_CALL_SIGNS = ["WNJT", "WNJN", "WNJB", "WNJS"];
const EEO_REPORT_URL =
  "https://www.nj.gov/treasury/njpba/assets/files/pdf/2026/FCCANNUALEEOREPORT2026.pdf";
const MONTCLAIR_PUBLIC_MEETINGS_URL =
  "https://www.montclair.edu/board-of-trustees/agenda-and-schedule/";
const NJPBA_PUBLIC_MEETINGS_URL =
  "https://www.nj.gov/treasury/njpba/minutes.shtml";
const MONTCLAIR_ACCESSIBILITY_URL =
  "https://www.montclair.edu/digital-accessibility-initiative/";
const MONTCLAIR_PRIVACY_URL =
  "https://www.montclair.edu/privacy-notice/";

describe("compliance pages (NJPBA legal checklist)", () => {
  it("public-file covers all four station public files", () => {
    const text = pageText("public-file");
    for (const call of NJ_PBS_CALL_SIGNS) {
      expect(text).toContain(call);
    }
  });

  it("closed-captioning keeps the three FCC complaint sections", () => {
    const sections = declaredSections("closed-captioning").join(" ").toLowerCase();

    expect(sections).toMatch(/quality certification/);
    expect(sections).toMatch(/immediate/);
    expect(sections).toMatch(/written complaints/);
  });

  it("closed-captioning publishes the current contact and complaint process", () => {
    const text = pageText("closed-captioning");

    expect(text).toContain("njpbs@montclair.edu");
    expect(text).toContain("800-882-6622");
    expect(text).toContain("tel:+18008826622");
    expect(text).toContain("Stefanie Murray");
    expect(text).toContain("Director, Center for Cooperative Media");
    expect(text).toContain("NJ PBS closed-captioning contact");
    expect(text).toContain("Montclair State University");
    expect(text).toContain("Center for Cooperative Media");
    expect(text).toContain("47 C.F.R. § 79.1");
    expect(text).toContain("Calls should be used for live or in-progress captioning problems");
    expect(text).toContain("immediate response to captioning concerns");
    expect(text).toContain("no later than 24 hours");
    expect(text).toContain("30 days");
    expect(text).toContain("60 days");
    expect(text).toContain("fcc.gov/accessibilitycomplaints");
    expect(text).toContain("For captioning problems during a program");
    expect(text).toContain("Fax: not available");

    for (const staleTerm of [
      "WNET",
      "WLIW",
      "NJTVONLINE",
      "thirteen.org",
      "being finalized",
      "dedicated engineering contact",
      "NJPBA Engineering",
      "Frank Graybill",
      "Chris Mather",
      "825 Eighth Avenue",
    ]) {
      expect(text).not.toContain(staleTerm);
    }
  });

  it.each(["closed-captioning", "public-file"])("keeps %s phone contacts within the published contact set", slug => {
    // Published NJ PBS contacts: https://njpbs.org/accessibility/, https://njpbs.org/closed-captioning/, https://njpbs.org/contact, https://njpbs.org/donor-advised-fund/, https://njpbs.org/posts/application-deadline-for-nj-property-tax-relief-is-days-away-dont-miss-out/, https://njpbs.org/posts/nj-pbs-announces-six-staff-appointments/, https://njpbs.org/public-file/, https://njpbs.org/support, https://njpbs.org/support/
    const publishedPhones = ["(800) 882-6622", "(888) 238-1233", "609-984-9449", "800-882-6622", "973-655-3701"];
    const digits = (value: string) => value.replace(/\D/g, "").slice(-10);
    const allowed = new Set(publishedPhones.map(digits));
    const phones = pageText(slug).match(/(?:\+?1[ .-]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[ .-]?[2-9]\d{2}[ .-]?\d{4}/g) ?? [];
    for (const phone of phones) {
      expect(allowed.has(digits(phone)), "page contains a phone outside the published contact set").toBe(true);
    }
  });

  it("accessibility publishes a working public accessibility statement", () => {
    const text = pageText("accessibility");

    expect(text).toContain("WCAG 2.1");
    expect(text).toContain("level AA");
    expect(text).toContain("njpbs@montclair.edu");
    expect(text).toContain("800-882-6622");
    expect(text).toContain(MONTCLAIR_ACCESSIBILITY_URL);
    // "Publishes" means the statement is final, not a draft (issue #184). The
    // draft flag does not gate rendering for an allowlisted compliance page, so
    // pin the published state or a regression back to draft passes unnoticed.
    expect(frontmatter("accessibility")).toMatch(/^draft:\s*false\s*$/m);
  });

  it("accessibility describes the native schedule grid honestly in the Known limitations body", () => {
    // Assert against the section BODY (frontmatter stripped) so the "Known
    // limitations" entry in the frontmatter sections list cannot satisfy the
    // check and the disclosure cannot drift to another section unnoticed.
    const known = sectionBody("accessibility", "Known limitations");
    // Normalize whitespace so the assertions survive markdown line wrapping.
    const normalized = known.replace(/\s+/g, " ");

    expect(known).not.toBe("");
    expect(normalized).toContain("native schedule grid");
    expect(normalized).toContain("keyboard");
    expect(normalized).toContain("focus returns");
    expect(normalized).toContain("empty current-day state");
    expect(normalized).not.toContain("PBS TV-listings widget");
    expect(normalized).not.toContain("embedded partner widget");
  });

  it("privacy explains site data and third-party PBS service boundaries", () => {
    const text = pageText("privacy");

    expect(text).toContain("njpbs@montclair.edu");
    expect(text).toContain("watch.njpbs.org");
    expect(text).toContain("PBS app");
    expect(text).toContain("PBS donation");
    expect(text).toContain(MONTCLAIR_PRIVACY_URL);
  });

  // Asserted against the section body, not the page, so a choice cannot drift into a
  // section the footer opt-out link does not reach. Each choice is asserted on its own
  // rather than through one carrier phrase, because a shared phrase lets a deleted
  // choice hide behind a surviving one.
  //
  // What the page may offer is bounded by what the station can actually do. The
  // contact requests stay available, while #232 adds a direct control for the
  // browser's stored analytics choice.
  it("offers privacy requests and a working analytics-choice control", () => {
    const choices = sectionBody("privacy", "Your privacy choices");

    expect(choices).toMatch(/tell you what personal information it holds/i);
    expect(choices).toMatch(/correct information that is wrong/i);
    // The deletion phrase is asserted in full because a shorter match let the copy
    // narrow the choice without failing: "delete information it no longer needs to
    // keep" satisfied /delete information/ while describing the station's retention
    // practice rather than offering the reader anything it could act on.
    expect(choices).toMatch(/delete personal information it holds about you/i);
    expect(choices).toMatch(/opt out of any sale of your personal information/i);
    expect(choices).toMatch(/targeted\s+advertising/i);
    // The address, not a pointer to it. This section is what the footer anchor lands
    // on, so "the contact below" would spend the one click it just saved.
    expect(choices).toMatch(/\[njpbs@montclair\.edu\]\(mailto:njpbs@montclair\.edu\)/i);

    expect(pageText("privacy")).toMatch(/global privacy control/i);
    expect(choices).toContain("data-consent-open");
  });

  it("uses markdown mailto links so rendered contact links keep accessible names", () => {
    for (const slug of ["closed-captioning", "accessibility", "privacy"]) {
      const text = pageText(slug);
      expect(text).not.toMatch(/<a\s+href="mailto:njpbs@montclair\.edu">/);
      expect(text).toContain("[njpbs@montclair.edu](mailto:njpbs@montclair.edu)");
    }
  });

  it("eeo links the FCC EEO report (broadcast EEO, distinct from CPB EEO)", () => {
    const text = pageText("eeo");
    const sections = declaredSections("eeo").join(" ").toLowerCase();
    expect(sections.length).toBeGreaterThan(0);
    expect(sections).toMatch(/eeo|equal employment/);
    expect(text).toContain(EEO_REPORT_URL);
  });

  it("meeting-notices covers both NJPBA and MSU notices", () => {
    const text = pageText("meeting-notices");
    expect(text).toContain("NJPBA");
    expect(text).toContain("Montclair State University");
    expect(text).toContain(MONTCLAIR_PUBLIC_MEETINGS_URL);
    expect(text).toContain(NJPBA_PUBLIC_MEETINGS_URL);
    expect(text).not.toMatch(/\bMSU\b/);
  });
});

// A page that exists but isn't linked anywhere is not "on the site". The branded
// prototype shell (PublicSiteLayout.astro) renders the site-wide footer on every
// page, so each compliance page must be reachable from there — this pins that the
// footer keeps the link, closing the exist-but-unlinked gap.
const LAYOUT = readFileSync(
  fileURLToPath(new URL("../src/layouts/PublicSiteLayout.astro", import.meta.url)),
  "utf8",
);
const CMS_BLOCKS = readFileSync(
  fileURLToPath(new URL("../src/components/CmsBlocks.astro", import.meta.url)),
  "utf8",
);
const QA_AUDIT = readFileSync(
  fileURLToPath(new URL("../../qa/audit_dist.py", import.meta.url)),
  "utf8",
);

describe("compliance pages are reachable from the footer", () => {
  it("keeps the visible compliance links requested for the legal row", () => {
    expect(LAYOUT).toContain('pageHref("closed-captioning")');
    expect(LAYOUT).toContain('pageHref("accessibility")');
    expect(LAYOUT).toContain('pageHref("privacy")');
    expect(LAYOUT).toContain(EEO_REPORT_URL);
  });

  // The footer opt-out link is an anchor, so it depends on a heading it cannot see:
  // Astro derives the id from the heading text, and a renamed heading would leave the
  // link pointing at nothing and quietly scrolling to the top of the page instead. A
  // dead opt-out link is worse than an obvious one, because the page still looks like
  // it offers the choice. Deriving the slug with Astro's own slugger couples the two.
  //
  // github-slugger is what Astro uses, so it is the only derivation that can be trusted
  // here. A hand-rolled `toLowerCase().replace(/[^a-z0-9]+/g, "-")` agrees on today's
  // heading and diverges the moment one gains punctuation: "Your privacy choices &
  // rights" slugs to "your-privacy-choices--rights", and a trailing period leaves a
  // trailing hyphen. That failure mode is worse than no test, because the run would fail
  // on the rename, and the obvious repair is to copy the derived slug out of the test
  // into the layout, which would produce exactly the dead link this test exists to
  // prevent. It arrives through astro rather than as a direct dependency, so if it ever
  // goes missing, add it to site/package.json rather than reaching for the regex.
  //
  // A published CMS page for the privacy pageId takes precedence in [...slug].astro,
  // so CmsBlocks supplies the same stable id when the corresponding headline appears.
  it("anchors the privacy-choices opt-out at a heading that exists", () => {
    const heading = "Your privacy choices";
    const slug = new GithubSlugger().slug(heading);

    expect(declaredSections("privacy")).toContain(heading);
    expect(pageText("privacy")).toContain(`## ${heading}`);
    expect(LAYOUT).toContain(`pageHref("privacy")}#${slug}`);
    expect(CMS_BLOCKS).toContain('entry.data.pageId !== "privacy"');
    expect(CMS_BLOCKS).toContain('text.trim() !== "Your privacy choices"');
    expect(CMS_BLOCKS).toContain('block.type === "headline"');
    expect(CMS_BLOCKS).toContain("privacyChoicesHeadingId(block.data.text)");
    expect(CMS_BLOCKS).toContain("richTextHeadingId");
    expect(CMS_BLOCKS).toContain('"your-privacy-choices"');
  });


  it("footer carries the four FCC public-file URLs", () => {
    for (const call of NJ_PBS_CALL_SIGNS) {
      expect(LAYOUT).toContain(
        `publicfiles.fcc.gov/tv-profile/${call.toLowerCase()}`,
      );
    }
  });

  it("links the public-file landing page from the footer alongside the FCC files (#289)", () => {
    // The four FCC links route straight to publicfiles.fcc.gov; the /public-file/
    // landing carries the FCC-required station-representative contact and an
    // explainer. Surface it in the footer next to the raw FCC links so that
    // contact is one click deep, not two. It sits in the FCC row, not the
    // legalLinks const, so the "no duplicate in the legal row" check above holds.
    expect(LAYOUT).toContain('pageHref("public-file")');
    const legalBlock = LAYOUT.match(/const legalLinks:[\s\S]*?\];/)?.[0] ?? "";
    expect(legalBlock).not.toContain('pageHref("public-file")');
  });

  it("treats privacy as an indexable public root page in the QA audit", () => {
    expect(QA_AUDIT).toContain('"/privacy/index.html"');
  });
});

describe("donor transparency policy and publication boundary", () => {
  const SLUG = "donor-transparency";

  it("is not routed or linked while its copy is unapproved", () => {
    expect(isPublicPageId(SLUG)).toBe(false);
    expect(launchArticlePageSlugs).not.toContain(SLUG);
    expect(LAYOUT).not.toContain(SLUG);
  });

  it("keeps internal review notes out of the page source", () => {
    expect(pageText(SLUG)).not.toMatch(/<!--[\s\S]*?-->/);
    expect(pageText(SLUG)).not.toContain("archive was still encrypted");
  });

  it("cites the statutory donor standard without asserting current grant status", () => {
    const donorPolicy = sectionBody(
      SLUG,
      "We do not share your information with candidates or political committees",
    );

    expect(donorPolicy).not.toContain("no longer makes those grants");
    expect(donorPolicy).toContain("47 U.S.C. 396(k)(12)");
  });

  it("does not promise a targeted-advertising right in the donor policy", () => {
    const donorRights = sectionBody(SLUG, "Donor rights");

    expect(donorRights).toContain("opt out of marketing contact");
    expect(donorRights).not.toMatch(/targeted\s+advertising/i);
  });

  it("offers a donor-request intake point without promising an unverified SLA", () => {
    const contact = sectionBody(SLUG, "Contact").replace(/\s+/g, " ");

    expect(contact).toContain("intake point for donor-privacy requests");
    expect(contact).not.toMatch(
      /respond within|response (?:time|deadline)|time the law requires/i,
    );
  });


  it("states need-to-know access as station policy, not an unchosen CRM feature", () => {
    const recordsUse = sectionBody(SLUG, "How your records are used");

    expect(recordsUse).toContain(
      "We limit access to staff whose work requires it",
    );
    expect(recordsUse).not.toContain("a system that limits access");
  });

  it("links the published FAQ for operator and membership updates", () => {
    const transferPolicy = sectionBody(
      SLUG,
      "NJ PBS operations",
    ).replace(/\s+/g, " ");
    const faqPolicy = pageText("faq").replace(/\s+/g, " ");

    expect(transferPolicy).toContain("https://njpbs.org/faq/");
    expect(faqPolicy).toContain("Montclair State University is the new operator of NJ PBS");
    expect(JSON.stringify(pageCompositionSeed("faq"))).toContain("Montclair State University is the new operator of NJ PBS");
    expect(transferPolicy).not.toContain("authorized chain");
  });



  it("identifies the public operator without asserting a donor-data path", () => {
    const transferPolicy = sectionBody(
      SLUG,
      "NJ PBS operations",
    ).replace(/\s+/g, " ");

    expect(transferPolicy).toContain(
      "Montclair State University became the operator of NJ PBS",
    );
    expect(transferPolicy).not.toContain(
      "Operation of NJ PBS moved from WNET to the State of New Jersey",
    );
  });
});
