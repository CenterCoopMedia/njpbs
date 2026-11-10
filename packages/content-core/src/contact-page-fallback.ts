import type { PageBlock, RichTextDoc } from "./content-model";

export interface ContactPageFallback {
  title: string;
  description: string;
  seoDescription: string;
  noindex: boolean;
  blocks: PageBlock[];
}

function prose(...paragraphs: string[]): RichTextDoc {
  return {
    type: "doc",
    content: paragraphs.map((text) => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    })),
  };
}

function section(heading: string, ...paragraphs: string[]): RichTextDoc {
  return {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: heading }],
      },
      ...paragraphs.map((text) => ({
        type: "paragraph" as const,
        content: [{ type: "text" as const, text }],
      })),
    ],
  };
}

function proseBlock(
  sectionId: string,
  order: number,
  content: RichTextDoc,
): PageBlock {
  return {
    id: `tmp-seed-contact-${sectionId}`,
    type: "prose",
    section: sectionId,
    order,
    visible: true,
    data: { content },
  };
}

/**
 * The reviewed repository-owned Contact composition.
 *
 * The page seed and the public Worker both read this value. Returning a fresh
 * graph prevents either consumer from changing the other consumer's fallback.
 */
export function contactPageFallback(): ContactPageFallback {
  return {
    title: "Contact NJ PBS",
    description:
      "Email or call NJ PBS for viewer, member, Passport, donation, and site questions.",
    seoDescription:
      "Contact NJ PBS for viewer, member, Passport, donation, and website help.",
    noindex: true,
    blocks: [
      proseBlock(
        "body-copy",
        0,
        prose(
          "Use this page to see NJ PBS contact information before choosing how to get in touch. General help links on this site point here so a browser does not open a mail app automatically.",
        ),
      ),
      proseBlock(
        "contact-details",
        1,
        section(
          "How to contact NJ PBS",
          "Email: njpbs@montclair.edu. Phone: 800-882-6622.",
          "Mailing address: NJ PBS, 1 Normal Ave., Montclair, NJ 07043.",
          "Use the email address or phone number above for viewer questions, membership questions, PBS Passport help, donation questions, and questions about this website.",
          "For press and media inquiries, contact njpbs@montclair.edu.",
        ),
      ),
      {
        id: "tmp-seed-contact-contact-actions",
        type: "cta_row",
        section: "contact-actions",
        order: 2,
        visible: true,
        data: {
          ctas: [
            {
              label: "Email NJ PBS",
              href: "mailto:njpbs@montclair.edu?subject=NJ%20PBS%20question",
              variant: "primary",
            },
            {
              label: "Call 800-882-6622",
              href: "tel:+18008826622",
              variant: "secondary",
            },
          ],
        },
      },
      proseBlock(
        "when-to-contact",
        3,
        section(
          "When to use this page",
          "Contact NJ PBS if you need help with watching NJ PBS live or on demand; PBS Passport access or account lookup; renewing, starting, or changing a donation; or finding the right page for schedule, public file, accessibility, or captioning information.",
          "If your question involves a PBS-hosted service, such as the video player, Passport sign-in, the PBS app, or the donation form, NJ PBS will help route the question to the right support path.",
        ),
      ),
      proseBlock("other-help", 4, section("Other help pages")),
      {
        id: "tmp-seed-contact-help-actions",
        type: "cta_row",
        section: "help-actions",
        order: 5,
        visible: true,
        data: {
          ctas: [
            { label: "Transition FAQ", href: "/faq/", variant: "secondary" },
            {
              label: "Accessibility",
              href: "/accessibility/",
              variant: "secondary",
            },
            {
              label: "Closed captioning",
              href: "/closed-captioning/",
              variant: "secondary",
            },
            { label: "Public file", href: "/public-file/", variant: "secondary" },
          ],
        },
      },
    ],
  };
}
