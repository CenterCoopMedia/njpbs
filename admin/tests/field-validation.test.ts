import { describe, it, expect } from "vitest";
import {
  contradictedBlockContent,
  fieldIsRequired,
  invalidEditorFields,
  isFieldFilled,
  missingRequiredFields,
  missingBlockContent,
  missingRecommendedContent,
  unfinishedDatetimeDraftMessage,
  unreadableDatetimeMessage,
} from "../src/lib/field-validation";
import { emptyRichTextDoc } from "../src/lib/rich-text";
import { editorFieldsForBlock } from "../../packages/content-core/src/editor-admin";
import { defaultBlockData } from "../src/lib/block-factory";
import type { EditorField } from "../../packages/content-core/src/editor-admin";
import { COVERAGE_LIST_LIMITS, type RichTextDoc } from "../../packages/content-core/src/content-model";
import { isBioCardData } from "../../packages/content-core/src/bio-profiles";

const text: EditorField = { key: "t", label: "Title", help: "", kind: "text", required: true };
const rich: EditorField = { key: "b", label: "Body", help: "", kind: "richText", required: true };
const list: EditorField = { key: "l", label: "Tags", help: "", kind: "list", required: true };
const toggle: EditorField = { key: "m", label: "Members", help: "", kind: "toggle", required: true };
const startsAt: EditorField = { key: "startsAt", label: "Starts", help: "", kind: "datetime", required: true };
const endsAt: EditorField = { key: "endsAt", label: "Ends", help: "", kind: "datetime", required: false };
const select: EditorField = {
  key: "source",
  label: "Content source",
  help: "",
  kind: "select",
  required: true,
  options: [
    { value: "pbs_featured", label: "PBS featured programs" },
    { value: "spotlight_news", label: "NJ Spotlight News" },
  ],
};
const releasable: EditorField = {
  key: "alt",
  label: "Alt text",
  help: "",
  kind: "text",
  required: true,
  requiredUnless: "altDecorative",
};
const release: EditorField = {
  key: "altDecorative",
  label: "Mark as decorative",
  help: "",
  kind: "toggle",
  required: false,
};
const contextualAlt: EditorField = {
  key: "heroImageAlt",
  label: "Lead image alt text",
  help: "",
  kind: "text",
  required: true,
  requiredWhen: "heroImage",
  requiredUnless: "heroImageDecorative",
};

const filledDoc: RichTextDoc = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "words" }] }],
};
const unsafeLinkedDoc: RichTextDoc = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Watch",
          marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
        },
      ],
    },
  ],
};

describe("isFieldFilled", () => {
  it("treats a blank or whitespace string as unfilled", () => {
    expect(isFieldFilled(text, "")).toBe(false);
    expect(isFieldFilled(text, "   ")).toBe(false);
    expect(isFieldFilled(text, "Budget")).toBe(true);
  });

  it("treats a stored instant the control cannot show as unfilled", () => {
    // A legacy event holds a bare day in startsAt, which the date-time control renders
    // as blank. Reading it as a non-blank string would report the field filled while
    // the editor looks at an empty one with no message beside it (#509).
    expect(isFieldFilled(startsAt, "2026-08-01")).toBe(false);
    expect(isFieldFilled(startsAt, "2026-07-24T23:30:00-04:00")).toBe(false);
    expect(isFieldFilled(startsAt, "")).toBe(false);
    expect(isFieldFilled(startsAt, "2026-08-01T17:00:00.000Z")).toBe(true);
  });

  it("treats an empty rich-text doc as unfilled and one with text as filled", () => {
    expect(isFieldFilled(rich, emptyRichTextDoc())).toBe(false);
    expect(isFieldFilled(rich, filledDoc)).toBe(true);
  });

  it("treats an empty list as unfilled and a non-empty one as filled", () => {
    expect(isFieldFilled(list, [])).toBe(false);
    expect(isFieldFilled(list, ["arts"])).toBe(true);
  });

  it("always treats a toggle as filled", () => {
    expect(isFieldFilled(toggle, false)).toBe(true);
    expect(isFieldFilled(toggle, true)).toBe(true);
  });

  it("treats only an exact finite select option as filled", () => {
    expect(isFieldFilled(select, "pbs_featured")).toBe(true);
    expect(isFieldFilled(select, "custom_query")).toBe(false);
    expect(isFieldFilled(select, "")).toBe(false);
  });
});

describe("missingRequiredFields", () => {
  it("reports required empties in order and ignores optional empties", () => {
    const optional: EditorField = { key: "o", label: "Dek", help: "", kind: "text", required: false };
    const fields = [text, optional, rich];
    const missing = missingRequiredFields(fields, { t: "", o: "", b: emptyRichTextDoc() });
    expect(missing.map((f) => f.key)).toEqual(["t", "b"]);
  });

  it("returns nothing when every required field is filled", () => {
    const missing = missingRequiredFields([text, rich], { t: "Budget", b: filledDoc });
    expect(missing).toEqual([]);
  });

  it("requires contextual alt text only while its image is selected", () => {
    expect(fieldIsRequired(contextualAlt, {})).toBe(false);
    expect(fieldIsRequired(contextualAlt, { heroImage: "" })).toBe(false);
    expect(
      fieldIsRequired(contextualAlt, {
        heroImage: "asset-lead",
        heroImageDecorative: false,
      }),
    ).toBe(true);
    expect(
      fieldIsRequired(contextualAlt, {
        heroImage: "asset-lead",
        heroImageDecorative: true,
      }),
    ).toBe(false);
  });
});

describe("invalidEditorFields", () => {
  const website: EditorField = {
    key: "href",
    label: "Website",
    help: "The sponsor's link.",
    kind: "url",
    required: true,
  };

  it("names an unreadable stored time instead of calling the field required", () => {
    // The record holds a value and saving will replace it, so "is required" would read as
    // "never set" and give the editor no reason to expect an overwrite.
    expect(invalidEditorFields([startsAt], { startsAt: "2026-08-01" })).toEqual([
      {
        field: startsAt,
        message:
          'Starts holds "2026-08-01", which is not a date and time this control can show. Clear it or set a new one.',
      },
    ]);
    // The complement, which is what makes the distinction mean anything: a field that
    // genuinely holds nothing still says so.
    expect(invalidEditorFields([startsAt], { startsAt: "" })).toEqual([
      { field: startsAt, message: "Starts is required." },
    ]);
  });

  it("reports an optional end time nothing else would look at", () => {
    // endsAt is not required, so the completeness rule never reaches it. Without its own
    // check a legacy bare day survives an unrelated edit unmentioned, and the server does
    // not normalize event fields the way it does publishAt.
    expect(
      invalidEditorFields(
        [endsAt],
        { endsAt: "2026-08-01" },
        { allowIncomplete: true },
      ),
    ).toEqual([
      {
        field: endsAt,
        message:
          'Ends holds "2026-08-01", which is not a date and time this control can show. Clear it or set a new one.',
      },
    ]);
    // Genuinely omitted stays omitted: an optional field left blank is not an error.
    expect(invalidEditorFields([endsAt], { endsAt: "" })).toEqual([]);
    expect(invalidEditorFields([endsAt], {})).toEqual([]);
    expect(invalidEditorFields([endsAt], { endsAt: "2026-08-01T21:00:00.000Z" })).toEqual([]);
  });

  it("uses the renderer's href policy for a filled url field", () => {
    expect(invalidEditorFields([website], { href: "javascript:alert(1)" })).toEqual([
      {
        field: website,
        message: "Website must use http, https, mailto, tel, or a relative link.",
      },
    ]);
    expect(invalidEditorFields([website], { href: "https://njpbs.org/" })).toEqual([]);
  });

  it("rejects a select value outside its declared finite choices", () => {
    expect(invalidEditorFields([select], { source: "custom_query" })).toEqual([
      {
        field: select,
        message: "Content source must use one of the available choices.",
      },
    ]);
    expect(invalidEditorFields([select], { source: "pbs_featured" })).toEqual([]);
  });

  it("names both bounds of a promotion program list", () => {
    const programs: EditorField = {
      key: "cards",
      label: "Programs",
      help: "",
      kind: "list",
      required: true,
      minItems: 3,
      maxItems: 7,
    };
    expect(invalidEditorFields([programs], { cards: [{}, {}] })[0]?.message).toBe(
      "Programs must contain at least 3. Add 1 to save.",
    );
    expect(
      invalidEditorFields([programs], { cards: [{}, {}] }, { allowIncomplete: true }),
    ).toEqual([]);
    expect(invalidEditorFields(
      [programs],
      { cards: Array.from({ length: 8 }, () => ({})) },
      { allowIncomplete: true },
    )[0]?.message).toBe(
      "Programs can hold at most 7. Remove 1 to save.",
    );
  });

  it("keeps an optional blank url valid but rejects an unsafe value", () => {
    const optional = { ...website, required: false };
    expect(invalidEditorFields([optional], { href: "" })).toEqual([]);
    expect(invalidEditorFields([optional], { href: "//evil.example" })).toEqual([
      {
        field: optional,
        message: "Website must use http, https, mailto, tel, or a relative link.",
      },
    ]);
  });

  it("rejects a renderer-stripped link inside a rich-text field", () => {
    const body: EditorField = {
      key: "body",
      label: "Body",
      help: "Write the article.",
      kind: "richText",
      required: true,
    };
    expect(invalidEditorFields([body], { body: unsafeLinkedDoc })).toEqual([
      {
        field: body,
        message:
          "Body contains a link that must use http, https, mailto, tel, or a relative link.",
      },
    ]);
  });
});

describe("missingBlockContent", () => {
  it("refuses a linked image with no alt text or caption to name the link", () => {
    const fields = editorFieldsForBlock("image");
    const linked = { assetId: "a1", alt: "", caption: " ", href: "https://youtu.be/abc" };
    expect(missingBlockContent(fields, linked)).toEqual([
      "Image link needs alt text or caption to name it for screen readers.",
    ]);
    expect(missingBlockContent(fields, linked, { allowIncomplete: true })).toEqual([]);
    expect(missingBlockContent(fields, { ...linked, caption: "Full episode" })).toEqual([]);
    expect(missingBlockContent(fields, { ...linked, alt: "Watch the newscast" })).toEqual([]);
  });

  it("reports a block's own empty required field in plain words", () => {
    const fields = editorFieldsForBlock("headline");
    expect(missingBlockContent(fields, defaultBlockData("headline"))).toEqual([
      "Heading is required.",
    ]);
  });

  it("reports an empty required list as missing before looking at items", () => {
    const fields = editorFieldsForBlock("image_gallery");
    // A fresh gallery has no images, so the list itself is the missing required field.
    expect(missingBlockContent(fields, defaultBlockData("image_gallery"))).toEqual([
      "Images is required.",
    ]);
  });

  it("reports the required sub-fields of an item already added to a list", () => {
    const fields = editorFieldsForBlock("image_gallery");
    // One image present but blank: the list is filled, so its item's required sub-fields
    // are what remain, labelled by the list and the item's position.
    const data = { images: [{ assetId: "", alt: "", caption: "" }] };
    expect(missingBlockContent(fields, data)).toEqual([
      "Images 1: Image is required.",
    ]);
  });

  it("returns nothing when the block and its items are complete", () => {
    const fields = editorFieldsForBlock("image_gallery");
    const data = { images: [{ assetId: "asset-1", alt: "A reporter at a desk", caption: "" }] };
    expect(missingBlockContent(fields, data)).toEqual([]);
  });

  it("reports unsafe required and optional url fields with their item context", () => {
    expect(
      missingBlockContent(editorFieldsForBlock("cta_row"), {
        ctas: [{ label: "", href: "javascript:alert(1)" }],
      }, { allowIncomplete: true }),
    ).toEqual([
      "Buttons 1: Button link must use http, https, mailto, tel, or a relative link.",
    ]);

    expect(
      missingBlockContent(editorFieldsForBlock("card_grid"), {
        cards: [{ title: "Programs", href: "//evil.example" }],
      }),
    ).toEqual([
      "Cards 1: Card link must use http, https, mailto, tel, or a relative link.",
    ]);
  });

  it("accepts every safe scheme and relative url the renderer keeps", () => {
    const fields = editorFieldsForBlock("embed");
    for (const url of [
      "https://watch.njpbs.org/",
      "http://example.org/",
      "mailto:account-13@example.org",
      "tel:+18008826622",
      "/watch/",
    ]) {
      expect(missingBlockContent(fields, { url })).toEqual([]);
    }
  });

  it("matches the bio model's exact HTTPS source-link rule", () => {
    const fields = editorFieldsForBlock("bio_card");
    const data = {
      profileId: "example-official", kind: "person" as const, name: "Example Official", role: "State senator",
      summary: "A sourced short biography.", sourceUrl: "https://example.org/official", sourceLabel: "Official biography", asOf: "2026-10-03",
    };
    for (const sourceUrl of [
      "https://example.org/official",
      "",
      "   ",
      "\t",
      "http://example.org/official",
      "/official",
      "mailto:news@example.org",
      " https://example.org/official",
      "https://example.org/official ",
      "https://user:secret@example.org/official",
    ]) {
      const candidate = { ...data, sourceUrl };
      expect(missingBlockContent(fields, candidate).length === 0, sourceUrl)
        .toBe(isBioCardData(candidate, true));
      expect(missingBlockContent(fields, candidate, { allowIncomplete: true }).length === 0, sourceUrl)
        .toBe(isBioCardData(candidate, false));
    }
    expect(missingBlockContent(fields, { ...data, sourceUrl: "http://example.org/official" }))
      .toEqual(["Source link must be a secure HTTPS link."]);
  });

  it("reports unsafe links in each block rich-text field", () => {
    expect(
      missingBlockContent(editorFieldsForBlock("prose"), { content: unsafeLinkedDoc }),
    ).toEqual([
      "Body contains a link that must use http, https, mailto, tel, or a relative link.",
    ]);
    expect(
      missingBlockContent(editorFieldsForBlock("card_grid"), {
        cards: [{ title: "Programs", body: unsafeLinkedDoc, href: "" }],
      }),
    ).toEqual([
      "Cards 1: Card text contains a link that must use http, https, mailto, tel, or a relative link.",
    ]);
    expect(
      missingBlockContent(editorFieldsForBlock("faq_item"), {
        question: "Where can I watch?",
        answer: unsafeLinkedDoc,
      }),
    ).toEqual([
      "Answer contains a link that must use http, https, mailto, tel, or a relative link.",
    ]);
  });

  it("names a coverage field that exceeds its stored length", () => {
    expect(
      missingBlockContent(editorFieldsForBlock("coverage_list"), {
        entries: [{
          title: "A".repeat(COVERAGE_LIST_LIMITS.title + 1),
          outlet: "Outlet",
          date: "2026-09-17",
          url: "https://example.com/story",
        }],
      }, { allowIncomplete: true }),
    ).toEqual([
      `Articles 1: Article title can be at most ${COVERAGE_LIST_LIMITS.title} characters. Shorten it to save.`,
    ]);
  });
});

// WCAG 1.1.1 wants a decorative image to carry alt="", and the alt field is required, so
// before the escape the two rules contradicted and a decorative image could not be saved
// at all. These pin both halves: the release, and the contradiction it must not swallow.
describe("a required field released by a sibling toggle", () => {
  it("stays required while the toggle is off or absent", () => {
    expect(fieldIsRequired(releasable, {})).toBe(true);
    expect(fieldIsRequired(releasable, { altDecorative: false })).toBe(true);
    expect(missingRequiredFields([releasable, release], { alt: "" })).toEqual([releasable]);
  });

  it("is released while the toggle is on", () => {
    expect(fieldIsRequired(releasable, { altDecorative: true })).toBe(false);
    expect(
      missingRequiredFields([releasable, release], { alt: "", altDecorative: true }),
    ).toEqual([]);
    expect(
      invalidEditorFields([releasable, release], { alt: "", altDecorative: true }),
    ).toEqual([]);
  });

  // A truthy value that is not `true` is not an answer the toggle control can produce, so
  // reading it as one would let a stray string from an import unlock the requirement.
  it("ignores a non-boolean value in the toggle", () => {
    expect(fieldIsRequired(releasable, { altDecorative: "yes" })).toBe(true);
  });

  // The model parser wants exactly "", so a trimming check here would hand the save
  // boundary a page it refuses with a generic format error naming no field.
  it("reports whitespace left in a released field, which the parser will not accept", () => {
    expect(
      invalidEditorFields([releasable, release], { alt: "   ", altDecorative: true }).map(
        (error) => error.message,
      ),
    ).toEqual(["Alt text must be empty while Mark as decorative is on."]);
  });

  it("reports describing and marking decorative as the contradiction it is", () => {
    expect(
      invalidEditorFields([releasable, release], {
        alt: "A reporter at a desk",
        altDecorative: true,
      }).map((error) => error.message),
    ).toEqual(["Alt text must be empty while Mark as decorative is on."]);
  });
});

describe("the image alt escape as the editor meets it", () => {
  it("lets a decorative gallery image save with no alt text", () => {
    const fields = editorFieldsForBlock("image_gallery");
    expect(
      missingBlockContent(fields, {
        images: [{ assetId: "asset-1", alt: "", altDecorative: true, caption: "" }],
      }),
    ).toEqual([]);
  });

  it("warns about a gallery image that is neither described nor marked decorative", () => {
    const fields = editorFieldsForBlock("image_gallery");
    const data = { images: [{ assetId: "asset-1", alt: "", caption: "" }] };
    expect(missingBlockContent(fields, data)).toEqual([]);
    expect(missingRecommendedContent(fields, data)).toEqual([
      "Images 1: Alt text is empty. You can save and publish, but describe the image or mark it decorative when you can.",
    ]);
    expect(
      missingRecommendedContent(fields, {
        images: [
          { assetId: "", alt: "" },
          { assetId: "asset-2", alt: "", altDecorative: true },
          { assetId: "asset-3", alt: "A reporter" },
        ],
      }),
    ).toEqual([]);
  });

  it("refuses a gallery image that is both described and marked decorative", () => {
    const fields = editorFieldsForBlock("image_gallery");
    expect(
      missingBlockContent(fields, {
        images: [{ assetId: "asset-1", alt: "A reporter", altDecorative: true, caption: "" }],
      }),
    ).toEqual(["Images 1: Alt text must be empty while Mark as decorative is on."]);
  });
});

describe("contradictedBlockContent", () => {
  it("reports only the contradiction, not the incompleteness", () => {
    const fields = editorFieldsForBlock("image_gallery");
    expect(
      contradictedBlockContent(fields, {
        images: [{ assetId: "", alt: "A reporter", altDecorative: true }],
      }),
    ).toEqual(["Images 1: Alt text must be empty while Mark as decorative is on."]);
    expect(contradictedBlockContent(fields, { images: [{ assetId: "", alt: "" }] })).toEqual([]);
  });
});

describe("unreadableDatetimeMessage", () => {
  it("quotes the text the record is actually holding", () => {
    // The point of the message is that the editor can see what is in there. A control that
    // renders blank and a message saying only "cannot be read" leaves them guessing at
    // whether anything is stored at all (#850).
    expect(unreadableDatetimeMessage(endsAt, "2026-08-01")).toBe(
      'Ends holds "2026-08-01", which is not a date and time this control can show. Clear it or set a new one.',
    );
  });

  it("says nothing about a blank field or one the control can read", () => {
    expect(unreadableDatetimeMessage(endsAt, "")).toBeNull();
    expect(unreadableDatetimeMessage(endsAt, "   ")).toBeNull();
    expect(unreadableDatetimeMessage(endsAt, undefined)).toBeNull();
    expect(unreadableDatetimeMessage(endsAt, "2026-08-01T21:00:00.000Z")).toBeNull();
  });

  it("only speaks for a datetime field", () => {
    expect(unreadableDatetimeMessage(text, "2026-08-01")).toBeNull();
  });

  it("trims a stored value too long to read in one line", () => {
    const long = `2026-08-01${"x".repeat(120)}`;
    const message = unreadableDatetimeMessage(endsAt, long);
    expect(message).toContain('"2026-08-01xxxx');
    expect(message).toContain('…"');
    expect((message ?? "").length).toBeLessThan(200);
  });

  it("describes a stored value that is not text at all", () => {
    // A Firestore Timestamp that reached the form unnormalized has no text to quote, so the
    // message says what kind of thing is in the field rather than printing "[object Object]".
    expect(unreadableDatetimeMessage(endsAt, { seconds: 1 })).toBe(
      "Ends holds a value that is not a date and time this control can show. Clear it or set a new one.",
    );
  });
});

describe("unfinishedDatetimeDraftMessage", () => {
  it("names the field holding a date and time that has not converted", () => {
    // 0202-08-01T13:00 is a complete value as far as the browser is concerned, so the control
    // reports it while an editor is still typing the year. It converts to nothing.
    expect(unfinishedDatetimeDraftMessage(startsAt, "0202-08-01T13:00")).toBe(
      "Starts is not a complete date and time yet. Finish it or clear it before saving.",
    );
  });

  it("says nothing about an empty draft or one that converts", () => {
    expect(unfinishedDatetimeDraftMessage(startsAt, "")).toBeNull();
    expect(unfinishedDatetimeDraftMessage(startsAt, "2026-08-01T13:00")).toBeNull();
  });
});
