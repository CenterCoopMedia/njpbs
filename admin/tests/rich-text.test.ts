import { describe, it, expect } from "vitest";
import { Editor, getSchema, type JSONContent } from "@tiptap/core";
import {
  DOMParser as ProseMirrorDOMParser,
  DOMSerializer,
  Slice,
  Fragment,
} from "@tiptap/pm/model";
import {
  EMPTY_RICH_TEXT_DOC,
  emptyRichTextDoc,
  richTextIsEmpty,
  richTextExtensions,
  RICH_TEXT_HEADING_LEVELS,
} from "../src/lib/rich-text";
import { isRichTextDoc, type RichTextDoc } from "../../packages/content-core/src/content-model";

describe("rich-text helpers", () => {
  it("emptyRichTextDoc is a structurally valid rich-text document", () => {
    expect(isRichTextDoc(emptyRichTextDoc())).toBe(true);
  });

  // The shared default a render-time `?? empty` reaches for. It has to be the same object every
  // time: a fresh one per render gives a controlled RichTextEditor a new `value` identity on every
  // parent render, which re-runs its value-sync deep compare for every empty body on the page
  // (#511). Frozen so a caller that means to store a body has to mint its own document rather than
  // edit the one every empty editor is reading.
  it("EMPTY_RICH_TEXT_DOC is one stable frozen document equal to a fresh empty one", () => {
    expect(isRichTextDoc(EMPTY_RICH_TEXT_DOC)).toBe(true);
    expect(EMPTY_RICH_TEXT_DOC).toEqual(emptyRichTextDoc());
    expect(richTextIsEmpty(EMPTY_RICH_TEXT_DOC)).toBe(true);
    expect(Object.isFrozen(EMPTY_RICH_TEXT_DOC)).toBe(true);
    expect(Object.isFrozen(EMPTY_RICH_TEXT_DOC.content)).toBe(true);
    expect(Object.isFrozen(EMPTY_RICH_TEXT_DOC.content?.[0])).toBe(true);
  });

  // The minting helper stays a factory: a stored value has to be the caller's own document.
  it("emptyRichTextDoc keeps returning a fresh document callers may edit", () => {
    const first = emptyRichTextDoc();
    expect(first).not.toBe(emptyRichTextDoc());
    expect(first).not.toBe(EMPTY_RICH_TEXT_DOC);
    expect(Object.isFrozen(first)).toBe(false);
  });

  it("richTextIsEmpty is true for an untouched doc and false once it has text", () => {
    expect(richTextIsEmpty(emptyRichTextDoc())).toBe(true);
    const filled: RichTextDoc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
    };
    expect(richTextIsEmpty(filled)).toBe(false);
  });

  it("treats whitespace-only text as empty", () => {
    const whitespace: RichTextDoc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "   " }] }],
    };
    expect(richTextIsEmpty(whitespace)).toBe(true);
  });
});

describe("rich-text schema is narrowed to what the renderer supports", () => {
  // getSchema builds the ProseMirror schema from the extensions with no editor view,
  // so this asserts the contract without mounting anything in jsdom.
  const schema = getSchema(richTextExtensions());

  it("includes only the renderer's marks", () => {
    const marks = Object.keys(schema.marks);
    expect(marks.sort()).toEqual(["bold", "code", "italic", "link"]);
  });

  it("includes every block node the renderer emits", () => {
    const nodes = Object.keys(schema.nodes);
    expect(nodes).toEqual(
      expect.arrayContaining([
        "doc",
        "paragraph",
        "text",
        "heading",
        "bulletList",
        "orderedList",
        "listItem",
        "blockquote",
        "codeBlock",
        "hardBreak",
        "horizontalRule",
      ]),
    );
  });

  it("has no image node (inline images are a render gap)", () => {
    expect(Object.keys(schema.nodes)).not.toContain("image");
  });

  it("configures body headings to start at H2", () => {
    expect([...RICH_TEXT_HEADING_LEVELS]).toEqual([2, 3]);
  });

  it("round-trips contextual heading tags without changing stored ranks", () => {
    const contextualSchema = getSchema(
      richTextExtensions({
        headingLevelOffset: 2,
        minimumHeadingLevel: 4,
      }),
    );
    const original = contextualSchema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Section" }],
        },
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Detail" }],
        },
      ],
    });
    const clipboard = document.createElement("div");
    clipboard.appendChild(
      DOMSerializer.fromSchema(contextualSchema).serializeFragment(original.content),
    );

    expect(clipboard.querySelector("h4")?.textContent).toBe("Section");
    expect(clipboard.querySelector("h5")?.textContent).toBe("Detail");
    expect(
      ProseMirrorDOMParser.fromSchema(contextualSchema).parse(clipboard).toJSON(),
    ).toEqual(original.toJSON());
  });
});

describe("JSON attributes cannot add inherited DOM attributes (#814)", () => {
  const inheritedAttributes = {
    "data-inherited-canary": "untrusted-prototype",
    onerror: "unexpectedErrorHandler()",
    onclick: "unexpectedClickHandler()",
  };
  // JSON.parse gives attrs a real own __proto__ key, unlike an object literal's
  // prototype setter. Poison every node and mark, including nodes with no attrs.
  const poisonedDocument = (content: JSONContent): JSONContent => JSON.parse(
    JSON.stringify(content, (_key, value) => {
      if (value && typeof value === "object" && typeof value.type === "string") {
        return {
          ...value,
          attrs: { ...value.attrs, ["__proto__"]: inheritedAttributes },
        };
      }
      return value;
    }),
  );

  it("drops prototype attributes through the real schema, editor view and HTML export", () => {
    const text = (value: string): JSONContent => ({ type: "text", text: value });
    const paragraph = (value: string): JSONContent => ({ type: "paragraph", content: [text(value)] });
    const content = poisonedDocument({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [text("Section heading")] },
        {
          type: "paragraph",
          content: [
            ...["bold", "italic", "code"].map((type) => ({ ...text(`${type} text `), marks: [{ type }] })),
            {
              ...text("Link text"),
              marks: [{
                type: "link",
                attrs: { href: "https://www.wnet.org/", target: "_blank", allowLegacyHost: true },
              }],
            },
            { type: "hardBreak" },
            text("After the break"),
          ],
        },
        { type: "bulletList", content: [{ type: "listItem", content: [paragraph("Bullet item")] }] },
        { type: "orderedList", attrs: { start: 4 }, content: [{ type: "listItem", content: [paragraph("Numbered item")] }] },
        { type: "blockquote", content: [paragraph("Quoted text")] },
        { type: "codeBlock", attrs: { language: "javascript" }, content: [text("const answer = 42;")] },
        { type: "horizontalRule" },
      ],
    });
    const coveredTypes = new Set<string>();
    const assertPoisoned = (node: JSONContent) => {
      coveredTypes.add(node.type!);
      expect(Object.hasOwn(node.attrs ?? {}, "__proto__")).toBe(true);
      expect(node.attrs?.["__proto__"]).toEqual(inheritedAttributes);
      node.content?.forEach(assertPoisoned);
      node.marks?.forEach(assertPoisoned);
    };
    assertPoisoned(content);

    const editor = new Editor({ extensions: richTextExtensions(), content });
    try {
      expect(coveredTypes).toEqual(new Set([
        ...Object.keys(editor.schema.nodes),
        ...Object.keys(editor.schema.marks),
      ]));
      editor.state.doc.check();
      const assertClean = (node: JSONContent) => {
        for (const name of ["__proto__", ...Object.keys(inheritedAttributes)]) {
          expect(Object.hasOwn(node.attrs ?? {}, name)).toBe(false);
        }
        expect(node.attrs?.["data-inherited-canary"]).toBeUndefined();
        expect(node.attrs?.onerror).toBeUndefined();
        expect(node.attrs?.onclick).toBeUndefined();
        node.content?.forEach(assertClean);
        node.marks?.forEach(assertClean);
      };
      assertClean(editor.getJSON());

      const exported = document.createElement("div");
      exported.innerHTML = editor.getHTML();
      for (const root of [editor.view.dom, exported]) {
        for (const element of [root, ...root.querySelectorAll("*")]) {
          expect(element.getAttributeNames().filter((name) =>
            name === "__proto__" || name === "data-inherited-canary" || /^on/i.test(name),
          )).toEqual([]);
        }
        expect(root.querySelector("h2")?.textContent).toBe("Section heading");
        expect(root.querySelector("h2")?.getAttribute("data-rich-text-stored-heading-level")).toBe("2");
        expect(root.querySelector("a")?.getAttribute("href")).toBe("https://www.wnet.org/");
        expect(root.querySelector("a")?.getAttribute("target")).toBe("_blank");
        expect(root.querySelector("a")?.getAttribute("data-allow-legacy-host")).toBe("true");
        expect(root.querySelector("ol")?.getAttribute("start")).toBe("4");
        expect(root.querySelector("pre code")?.classList.contains("language-javascript")).toBe(true);
      }
    } finally {
      editor.destroy();
    }
  });

  it("rejects an image node carrying prototype attributes", () => {
    const schema = getSchema(richTextExtensions());
    expect(() => schema.nodeFromJSON(poisonedDocument({
      type: "doc",
      content: [{ type: "image", attrs: { src: "https://example.org/image.png" } }],
    }))).toThrow(/Unknown node type: image/);
  });
});

describe("the editor's link tool matches the renderer's scheme allowlist (#514)", () => {
  // The renderer (safeHref in content-model) strips any link whose scheme it will not
  // emit, so a scheme the editor accepts but the renderer drops publishes as an empty
  // href. The Link extension must reject exactly what the renderer strips. isAllowedUri
  // layers the shared isSafeHref predicate over TipTap's own validation; stubbing
  // defaultValidate to true here isolates the isSafeHref narrowing, which alone must
  // enforce the whole matrix -- so the editor allowlist can never widen past the renderer
  // without this test failing.
  type AllowedUriCtx = {
    defaultValidate: (uri: string) => boolean;
    protocols: unknown[];
    defaultProtocol: string;
  };
  const link = richTextExtensions().find((ext) => ext.name === "link");
  const isAllowedUri = link?.options.isAllowedUri as
    | ((uri: string, ctx: AllowedUriCtx) => boolean)
    | undefined;
  const allow = (uri: string) =>
    isAllowedUri?.(uri, { defaultValidate: () => true, protocols: [], defaultProtocol: "https" });

  it("configures the Link extension with an isAllowedUri check", () => {
    expect(typeof isAllowedUri).toBe("function");
  });

  it.each([
    "https://example.org",
    "http://example.org",
    "mailto:member@example.org",
    "tel:+15551234567",
    "about",
    "../donate",
    "#section",
    "?campaign=passport",
  ])("accepts %s (a scheme or relative shape the renderer keeps)", (uri) => {
    expect(allow(uri)).toBe(true);
  });

  it.each([
    "ftp://host/file",
    "ftps://host/file",
    "sms:+15551234567",
    "xmpp:user@host",
    "cid:abc",
    "callto:15551234567",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "//evil.example.org/phish",
  ])("rejects %s (a scheme or shape the renderer strips to an empty href)", (uri) => {
    expect(allow(uri)).toBe(false);
  });
});

describe("the link command enforces the allowlist on manual entry (#514)", () => {
  // The link dialog applies a link with setLink({ href }) and does not inspect the
  // command's return, so the allowlist only holds if TipTap runs isAllowedUri inside
  // that command. This mounts a real editor to prove the manual-entry path is covered,
  // not just paste and autolink: a rejected scheme must leave the text unlinked.
  const seed = () =>
    new Editor({
      extensions: richTextExtensions(),
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "click" }] }],
      },
    });
  const linkMarks = (editor: Editor) =>
    (editor.getJSON().content?.[0]?.content?.[0]?.marks ?? []).filter((m) => m.type === "link");

  it("refuses to apply a link with a scheme the renderer strips", () => {
    const editor = seed();
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const applied = editor.chain().focus().setLink({ href: "ftp://host/file" }).run();
    expect(applied).toBe(false);
    expect(linkMarks(editor)).toHaveLength(0);
    editor.destroy();
  });

  it("applies a link with a safe scheme", () => {
    const editor = seed();
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const applied = editor.chain().focus().setLink({ href: "https://pbs.org" }).run();
    expect(applied).toBe(true);
    expect(linkMarks(editor)[0]?.attrs?.href).toBe("https://pbs.org");
    editor.destroy();
  });

  it("persists the per-link legacy host opt-in in the link mark", () => {
    const editor = seed();
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const applied = editor
      .chain()
      .focus()
      .setLink({
        href: "https://www.wnet.org/",
        allowLegacyHost: true,
      } as { href: string; allowLegacyHost: true })
      .run();

    expect(applied).toBe(true);
    expect(linkMarks(editor)[0]?.attrs?.allowLegacyHost).toBe(true);
    expect(editor.getHTML()).toContain(
      'data-allow-legacy-host="true"',
    );
    editor.destroy();
  });
});

describe("pasting a URL over a selection cannot bypass the allowlist (#514)", () => {
  // The other #514 tests cover setLink and autolink, both of which run isAllowedUri.
  // The linkOnPaste handler applies the pasted
  // href with a bare setMark and never consults isAllowedUri, so a pasted ftp URL over
  // a selection would persist a link mark the renderer strips. rich-text.ts disables
  // linkOnPaste for exactly that reason; these prove the ungated path is gone.
  const seed = () =>
    new Editor({
      extensions: richTextExtensions(),
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "click" }] }],
      },
    });
  const linkMarks = (editor: Editor) =>
    (editor.getJSON().content?.[0]?.content ?? [])
      .flatMap((node) => node.marks ?? [])
      .filter((m) => m.type === "link");

  it("configures the Link extension with linkOnPaste off", () => {
    const editor = seed();
    const link = editor.extensionManager.extensions.find((ext) => ext.name === "link");
    expect(link?.options.linkOnPaste).toBe(false);
    editor.destroy();
  });

  it("does not link a selection when an unsafe URL is pasted over it", () => {
    const editor = seed();
    editor.commands.setTextSelection({ from: 1, to: 6 });
    // Drive the real paste path: a slice holding the URL, run through every plugin's
    // handlePaste the way the view does. With linkOnPaste on, the link handler would
    // linkify ftp://host/file and setMark it here; with it off, nothing claims the paste
    // as a link, so the selection stays plain text.
    const slice = new Slice(Fragment.from(editor.schema.text("ftp://host/file")), 0, 0);
    editor.view.someProp("handlePaste", (fn) =>
      fn(editor.view, new Event("paste") as unknown as ClipboardEvent, slice),
    );
    expect(linkMarks(editor)).toHaveLength(0);
    editor.destroy();
  });
});
