// TipTap configuration and rich-text helpers for the editor UI. Admin-only glue,
// not part of the mirrored core: the stored shape is TipTap JSON (a `RichTextDoc`),
// so the editor's `getJSON()` output is already the persisted value with no
// translation layer.
//
// The schema is deliberately narrowed to the nodes and marks the site renderer
// (`renderRichText` in content-model.ts) actually emits. StarterKit's `strike` mark
// is disabled because the renderer has no case for it: offering a strikethrough
// button whose formatting silently disappears on publish is worse than not offering
// it. There is no image node on purpose either -- inline images are a known render
// gap, so the body editor cannot insert one.

import StarterKit from "@tiptap/starter-kit";
import Heading from "@tiptap/extension-heading";
import Link, { isAllowedUri as tiptapIsAllowedUri } from "@tiptap/extension-link";
import { mergeAttributes, type Extensions } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  isSafeHref,
  LEGACY_HOST_LINK_OPT_IN_ATTRIBUTE,
  resolvedRichTextHeadingLevel,
  type RenderRichTextOptions,
  type RichTextDoc,
} from "../../../packages/content-core/src/content-model";

// The emptiness predicate lives in the mirrored core (content-model.ts) so the site
// block renderer can share it without importing this admin-only TipTap glue. Re-exported
// here so existing editor call sites keep their `../lib/rich-text` import.
export { richTextIsEmpty } from "../../../packages/content-core/src/content-model";

// Body headings start at H2: H1 is the page or record title, set in its own field.
export const RICH_TEXT_HEADING_LEVELS = [2, 3] as const;

/** The exact URL gate shared by every editor path that creates a link. */
export function isAllowedRichTextHref(uri: string): boolean {
  return Boolean(tiptapIsAllowedUri(uri)) && isSafeHref(uri);
}

export interface RichTextHeadingContextRef {
  current: RenderRichTextOptions;
}

export const RICH_TEXT_HEADING_CONTEXT_KEY = new PluginKey<string>(
  "richTextHeadingContext",
);

const EditorialLink = Link.extend({
  addAttributes() {
    return {
      ...(this.parent?.() ?? {}),
      allowLegacyHost: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute(LEGACY_HOST_LINK_OPT_IN_ATTRIBUTE) === "true"
            ? true
            : null,
        renderHTML: (attributes) =>
          attributes.allowLegacyHost === true
            ? { [LEGACY_HOST_LINK_OPT_IN_ATTRIBUTE]: "true" }
            : {},
      },
    };
  },
});

function currentHeadingOptions(
  source: RenderRichTextOptions | RichTextHeadingContextRef,
): RenderRichTextOptions {
  return "current" in source ? source.current : source;
}

function headingContextKey(options: RenderRichTextOptions): string {
  return `${options.headingLevelOffset ?? 0}:${options.minimumHeadingLevel ?? 1}`;
}

// The extension set the editor and any headless schema check share, so the toolbar
// can only produce marks and nodes the renderer supports.
export function richTextExtensions(
  headingContext: RenderRichTextOptions | RichTextHeadingContextRef = {},
  shortTextOnly = false,
): Extensions {
  return [
    StarterKit.configure({
      strike: false,
      heading: false,
      ...(shortTextOnly ? { blockquote: false, bulletList: false, orderedList: false, listItem: false,
        code: false, codeBlock: false, hardBreak: false, horizontalRule: false } as const : {}),
    }),
    ...(shortTextOnly ? [] : [Heading.extend({
      parseHTML() {
        const annotated = [2, 3, 4, 5, 6].map((displayLevel) => ({
          tag: `h${displayLevel}[data-rich-text-stored-heading-level]`,
          priority: 100,
          getAttrs: (element: HTMLElement) => {
            const storedLevel = Number(
              element.dataset.richTextStoredHeadingLevel,
            );
            return RICH_TEXT_HEADING_LEVELS.includes(storedLevel as 2 | 3)
              ? { level: storedLevel }
              : false;
          },
        }));
        const portable = RICH_TEXT_HEADING_LEVELS.map((level) => ({
          tag: `h${level}`,
          attrs: { level },
        }));
        return [...annotated, ...portable];
      },

      // Keep portable h2/h3 levels in the document while rendering the editable
      // surface and clipboard HTML at their page-context levels. The stored-level
      // marker lets an H4–H6 round-trip through TipTap's intentionally narrow schema.
      renderHTML({ node, HTMLAttributes }) {
        const headingOptions = currentHeadingOptions(headingContext);
        const level = resolvedRichTextHeadingLevel(
          node.attrs.level,
          headingOptions,
        );
        return [
          `h${level}`,
          mergeAttributes(
            this.options.HTMLAttributes,
            HTMLAttributes,
            {
              "data-rich-text-stored-heading-level": String(
                node.attrs.level,
              ),
            },
          ),
          0,
        ];
      },

      addNodeView() {
        const headingName = this.name;
        return ({ node }) => {
          const displayLevel = resolvedRichTextHeadingLevel(
            node.attrs.level,
            currentHeadingOptions(headingContext),
          );
          const dom = document.createElement(`h${displayLevel}`);
          dom.dataset.richTextStoredHeadingLevel = String(node.attrs.level);
          return {
            dom,
            contentDOM: dom,
            update(nextNode) {
              if (nextNode.type.name !== headingName) return false;
              const nextDisplayLevel = resolvedRichTextHeadingLevel(
                nextNode.attrs.level,
                currentHeadingOptions(headingContext),
              );
              if (nextDisplayLevel !== displayLevel) return false;
              dom.dataset.richTextStoredHeadingLevel = String(
                nextNode.attrs.level,
              );
              return true;
            },
          };
        };
      },

      addProseMirrorPlugins() {
        const initialContext = headingContextKey(
          currentHeadingOptions(headingContext),
        );
        return [
          new Plugin<string>({
            key: RICH_TEXT_HEADING_CONTEXT_KEY,
            state: {
              init: () => initialContext,
              apply: (transaction, current) =>
                transaction.getMeta(RICH_TEXT_HEADING_CONTEXT_KEY) ?? current,
            },
            props: {
              decorations(state) {
                const context =
                  RICH_TEXT_HEADING_CONTEXT_KEY.getState(state) ?? initialContext;
                const decorations: Decoration[] = [];
                state.doc.descendants((node, position) => {
                  if (node.type.name === "heading") {
                    decorations.push(
                      Decoration.node(
                        position,
                        position + node.nodeSize,
                        { "data-rich-text-heading-context": context },
                      ),
                    );
                  }
                });
                return decorations.length
                  ? DecorationSet.create(state.doc, decorations)
                  : DecorationSet.empty;
              },
            },
          }),
        ];
      },
    }).configure({ levels: [...RICH_TEXT_HEADING_LEVELS] })]),
    EditorialLink.configure({
      openOnClick: false,
      autolink: true,
      // Paste-over-selection is the one link path TipTap 2.27 does not route through
      // isAllowedUri: its paste handler calls the generic setMark with the pasted href
      // directly, so pasting an ftp://host over selected text (linkify recognizes it)
      // would persist a link mark the renderer strips to an empty href -- the exact
      // drift isAllowedUri closes on the setLink and autolink paths. Turn it off so the
      // editor makes links only through those two gated paths; the toolbar link dialog
      // still covers "link this selection".
      linkOnPaste: false,
      HTMLAttributes: { rel: "noopener noreferrer" },
      // Offer only links the renderer will keep. TipTap's default validation admits
      // schemes safeHref strips (ftp, sms, xmpp, cid, callto) and protocol-relative
      // //host links, which then publish as an empty href. Narrow it with the shared
      // isSafeHref predicate so the editor allowlist cannot widen past the renderer,
      // while still deferring to TipTap's own checks for everything else.
      isAllowedUri: (uri) => isAllowedRichTextHref(uri),
    }),
  ];
}

export { emptyRichTextDoc } from "./empty-rich-text";

// The same empty document, shared and frozen, for the render-time default a controlled editor
// falls back to when a body field holds nothing yet.
//
// RichTextEditor's value-sync effect is keyed on `value`, so a default minted fresh in render gave
// every empty body a new identity on every pass of the block list: one keystroke anywhere on a
// page of empty prose blocks re-ran that effect, and its serialize-and-compare, once per block
// (#511). One object means one identity and no compare. Frozen because it is read by every empty
// editor at once: a caller that means to persist a body mints its own with emptyRichTextDoc().
export const EMPTY_RICH_TEXT_DOC: RichTextDoc = Object.freeze({
  type: "doc",
  content: Object.freeze([Object.freeze({ type: "paragraph" })]),
}) as RichTextDoc;
