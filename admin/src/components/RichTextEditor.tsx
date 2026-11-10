import { useToolbarNavigation } from "./ui/useToolbarNavigation";
import { ControlSizingProvider } from "../context/ControlSizingContext";
import { EditorInlineWriting } from "../context/EditorInlineWriting";
import { useEditorWorkspaceView } from "../context/EditorWorkspaceView";
import { useEditorTextHistory } from "../context/EditorTextHistory";
import { useOverlayOwner } from "./ComponentEditorDialog";
import { InfoTooltip } from "./ui/InfoTooltip";
import { useCallback, useContext, useEffect, useLayoutEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import { createPopper } from "@popperjs/core";
import Placeholder from "@tiptap/extension-placeholder";
import {
  richTextExtensions,
  emptyRichTextDoc,
  isAllowedRichTextHref,
  RICH_TEXT_HEADING_CONTEXT_KEY,
  RICH_TEXT_HEADING_LEVELS,
} from "../lib/rich-text";
import {
  resolvedRichTextHeadingLevel,
  type RenderRichTextOptions,
  type RichTextDoc,
} from "../../../packages/content-core/src/content-model";
import { ActionControl } from "./ui/ActionControl";
import { Button, Select, TextInput } from "./ui/Primitives";
import type { IconControlId } from "../lib/icon-control-registry";

interface RichTextEditorProps {
  shortTextOnly?: boolean;
  value: RichTextDoc;
  onChange: (doc: RichTextDoc) => void;
  ariaLabel: string;
  /** The id the field's summary links and labels address; lands on the editable surface. */
  id?: string;
  ariaDescribedBy?: string;
  ariaInvalid?: boolean;
  ariaRequired?: boolean;
  headingLevelOffset?: number;
  minimumHeadingLevel?: number;
}

interface ToolbarButton {
  action: IconControlId;
  label: string;
  glyph?: string;
  isActive: (editor: Editor) => boolean;
  run: (editor: Editor) => void;
}

interface LinkError {
  kind: "address" | "selection";
  message: string;
}

// Only the marks and block types the site renderer emits. Strikethrough and images are
// deliberately absent (see rich-text.ts): a button whose result never renders is a trap.
const TOOLBAR_BEFORE_HEADINGS: ToolbarButton[] = [
  {
    action: "bold",
    label: "Bold",
    isActive: (e) => e.isActive("bold"),
    run: (e) => e.chain().focus().toggleBold().run(),
  },
  {
    action: "italic",
    label: "Italic",
    isActive: (e) => e.isActive("italic"),
    run: (e) => e.chain().focus().toggleItalic().run(),
  },
  {
    action: "inline-code",
    label: "Inline code",
    isActive: (e) => e.isActive("code"),
    run: (e) => e.chain().focus().toggleCode().run(),
  },
];

const TOOLBAR_AFTER_HEADINGS: ToolbarButton[] = [
  {
    action: "bulleted-list",
    label: "Bulleted list",
    isActive: (e) => e.isActive("bulletList"),
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    action: "numbered-list",
    label: "Numbered list",
    isActive: (e) => e.isActive("orderedList"),
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    action: "quote",
    label: "Quote",
    isActive: (e) => e.isActive("blockquote"),
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
];

function contextualToolbar(options: RenderRichTextOptions): ToolbarButton[] {
  const displayLevels = RICH_TEXT_HEADING_LEVELS.map((level) =>
    resolvedRichTextHeadingLevel(level, options),
  );
  const duplicateDisplayLevel = displayLevels[0] === displayLevels[1];
  const headingButtons = RICH_TEXT_HEADING_LEVELS.map((storedLevel, index) => {
    const displayLevel = displayLevels[index];
    return {
      action: "heading" as const,
      label: duplicateDisplayLevel
        ? `Heading level ${displayLevel}, depth ${index + 1}`
        : `Heading level ${displayLevel}`,
      glyph: duplicateDisplayLevel
        ? `H${displayLevel}.${index + 1}`
        : `H${displayLevel}`,
      isActive: (editor: Editor) =>
        editor.isActive("heading", { level: storedLevel }),
      run: (editor: Editor) =>
        editor.chain().focus().toggleHeading({ level: storedLevel }).run(),
    };
  });
  return [
    ...TOOLBAR_BEFORE_HEADINGS,
    ...headingButtons,
    ...TOOLBAR_AFTER_HEADINGS,
  ];
}

function protectedTextRect(editor: Editor): DOMRect {
  try {
    const { from, to } = editor.state.selection;
    const start = editor.view.coordsAtPos(from);
    const end = editor.view.coordsAtPos(to);
    const left = Math.min(start.left, end.left);
    const right = Math.max(start.right, end.right, left + 1);
    const lineHeight = Number.parseFloat(getComputedStyle(editor.view.dom).lineHeight)
      || start.bottom - start.top;
    const top = Math.min(start.top, end.top) - lineHeight;
    const bottom = Math.max(start.bottom, end.bottom, top + 1);
    return new DOMRect(left, top, right - left, bottom - top);
  } catch {
    // Detached editors and jsdom have no text geometry.
    return editor.view.dom.getBoundingClientRect();
  }
}

function safeToolbarTop(top: number, height: number, text: DOMRect): number | null {
  if (top + height <= text.top - 8 || top >= text.bottom + 8) return top;
  const above = text.top - height - 8;
  const below = text.bottom + 8;
  const candidates = [above, below].filter(value => value >= 8 && value + height <= window.innerHeight - 8);
  return candidates.sort((a, b) => Math.abs(a - top) - Math.abs(b - top))[0] ?? null;
}

export function RichTextEditor({
  value,
  shortTextOnly = false,
  onChange,
  ariaLabel,
  id,
  ariaDescribedBy,
  ariaInvalid = false,
  ariaRequired = false,
  headingLevelOffset = 0,
  minimumHeadingLevel = 1,
}: RichTextEditorProps) {
  const inlineWriting = useContext(EditorInlineWriting);
  const workspaceView = useEditorWorkspaceView();
  const textHistory = useEditorTextHistory();
  const workspaceFormatting = Boolean(inlineWriting.inline && workspaceView?.kind === "post");
  const overlayOwner = useOverlayOwner();
  const [expandedToolbar, setExpandedToolbar] = useState(false);
  const expandedToolbarId = useId();
  const [toolbarMode, setToolbarMode] = useState<"pinned" | "floating" | null>(null);
  const modeButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreModeFocus = useRef(false);
  const pinned = workspaceFormatting || (toolbarMode ? toolbarMode === "pinned" : Boolean(overlayOwner));
  useLayoutEffect(() => {
    if (!restoreModeFocus.current) return;
    restoreModeFocus.current = false;
    modeButtonRef.current?.focus({ preventScroll: true });
  }, [pinned]);
  const [manualPosition, setManualPosition] = useState<{ left: number; top: number } | null>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const [active, setActive] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkError, setLinkError] = useState<LinkError | null>(null);
  const [allowLegacyHost, setAllowLegacyHost] = useState(false);
  const linkBarId = useId();
  const linkHintId = useId();
  const linkErrorId = useId();
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [toolbarElement, setToolbarElement] = useState<HTMLDivElement | null>(null);
  const setToolbar = useCallback((element: HTMLDivElement | null) => { toolbarRef.current = element; setToolbarElement(element); }, []);
  useToolbarNavigation(toolbarElement);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const linkTriggerRef = useRef<HTMLButtonElement | null>(null);
  const headingOptions = useMemo(
    () => ({ headingLevelOffset, minimumHeadingLevel }),
    [headingLevelOffset, minimumHeadingLevel],
  );
  const headingContext = useRef(headingOptions);
  headingContext.current = headingOptions;
  const contextKey = `${headingLevelOffset}:${minimumHeadingLevel}`;
  const previousContextKey = useRef(contextKey);
  const toolbar = useMemo(
    () => shortTextOnly ? TOOLBAR_BEFORE_HEADINGS.filter(button => button.action !== "inline-code") : contextualToolbar(headingOptions),
    [headingOptions, shortTextOnly],
  );

  const editor = useEditor({
    // Placeholder is an editor-only affordance (a view decoration, not a schema node), so it
    // is composed here rather than in the shared richTextExtensions() that mirrors the
    // renderer's schema.
    extensions: [
      ...richTextExtensions(headingContext, shortTextOnly),
      Placeholder.configure({ placeholder: "Start writing…" }),
    ],
    content: value ?? emptyRichTextDoc(),
    onUpdate: ({ editor }) => onChange(editor.getJSON() as RichTextDoc),
    editorProps: {
      attributes: {
        ...(id ? { id } : {}),
        "aria-label": ariaLabel,
        "aria-multiline": "true",
        "aria-required": String(ariaRequired),
        class: "rich-text-surface",
        role: "textbox",
      },
      handleKeyDown: (_view, event) => {
        if (!(event.altKey && event.key === "F10")) return false;
        const firstControl = toolbarRef.current?.querySelector<HTMLButtonElement>(
          "button:not(:disabled)",
        );
        if (!firstControl) return false;
        event.preventDefault();
        firstControl.focus();
        return true;
      },
    },
  });

  // Use a virtual reference so Popper follows the current TipTap selection rather
  // than the top of the field. Popper schedules its own scroll and resize work.
  useEffect(() => {
    const bubble = bubbleRef.current;
    if (pinned || manualPosition || !active || !bubble || !editor) return;
    const currentEditor = editor;

    const selectionRect = () => {
      const rect = protectedTextRect(currentEditor);
      const availableHeight = Math.max(rect.top - 16, window.innerHeight - rect.bottom - 16);
      if (availableHeight < 44) setToolbarMode("pinned");
      bubble.style.maxHeight = `${Math.max(44, Math.min(window.innerHeight / 2, availableHeight))}px`;
      return rect;
    };
    const instance = createPopper(
      {
        contextElement: currentEditor.view.dom,
        getBoundingClientRect: selectionRect,
      },
      bubble,
      {
        strategy: "fixed",
        placement: "top-start",
        modifiers: [
          { name: "offset", options: { offset: [0, 8] } },
          {
            name: "flip",
            options: {
              fallbackPlacements: ["bottom-start", "top-end", "bottom-end"],
            },
          },
          {
            name: "preventOverflow",
            // Keep the toolbar for visible text inside both viewport edges.
            options: { altAxis: true, padding: 8, tether: false },
          },
        ],
      },
    );
    const update = () => void instance.update();
    currentEditor.on("selectionUpdate", update);
    currentEditor.on("transaction", update);

    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(update);
    observer?.observe(bubble);
    void instance.update();

    return () => {
      observer?.disconnect();
      currentEditor.off("selectionUpdate", update);
      currentEditor.off("transaction", update);
      instance.destroy();
    };
  }, [active, editor, pinned, manualPosition]);

  useEffect(() => {
    const bubble = bubbleRef.current;
    if (!bubble || !editor || pinned || !manualPosition) return;
    // Popper releases its styles on cleanup; apply the user's position afterward.
    const place = () => {
      Object.assign(bubble.style, { position: "fixed", transform: "none",
        maxHeight: "min(50dvh, calc(100dvh - 16px))" });
      const bounds = bubble.getBoundingClientRect();
      bubble.style.left = `${Math.max(8, Math.min(manualPosition.left, window.innerWidth - bounds.width - 8))}px`;
      const desiredTop = Math.max(8, Math.min(manualPosition.top, window.innerHeight - bounds.height - 8));
      const top = drag.current ? desiredTop : safeToolbarTop(desiredTop, bounds.height, protectedTextRect(editor));
      if (top === null) {
        setManualPosition(null);
        setToolbarMode("pinned");
        return;
      }
      bubble.style.top = `${top}px`;
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(bubble);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    editor.on("selectionUpdate", place);
    editor.on("transaction", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      editor.off("selectionUpdate", place);
      editor.off("transaction", place);
    };
  }, [active, editor, pinned, manualPosition]);

  // A block move or preceding heading edit can change only the displayed rank. Mark
  // that context change on a history-free transaction so the heading node views
  // redraw in place while the editor instance and its local undo/redo stack survive.
  // Skip the initial mount: the extension already rendered that initial context, and
  // avoiding a setup-time view mutation keeps route teardown race-free.
  useEffect(() => {
    if (
      !editor ||
      editor.isDestroyed ||
      previousContextKey.current === contextKey
    ) {
      return;
    }
    previousContextKey.current = contextKey;
    editor.view.dispatch(
      editor.state.tr
        .setMeta(RICH_TEXT_HEADING_CONTEXT_KEY, contextKey)
        .setMeta("addToHistory", false),
    );
  }, [contextKey, editor]);

  // TipTap reads editorProps at creation. Keep validation relationships current when a
  // save attempt marks or clears this already-mounted editing surface.
  useEffect(() => {
    if (!editor) return;
    const surface = editor.view.dom;
    surface.setAttribute("aria-required", String(ariaRequired));
    if (ariaInvalid) surface.setAttribute("aria-invalid", "true");
    else surface.removeAttribute("aria-invalid");
    if (ariaDescribedBy)
      surface.setAttribute("aria-describedby", ariaDescribedBy);
    else surface.removeAttribute("aria-describedby");
  }, [ariaDescribedBy, ariaInvalid, ariaRequired, editor]);

  // Reconcile an external value change into the editor. TipTap reads `content` only at
  // creation, so a controlled value that changes after mount is otherwise ignored. Repeatable
  // lists now key their rows by a stable id, so reordering moves this instance with its item
  // rather than reusing it for another item's body; this sync is the defensive fallback for
  // any remaining case where the same instance is handed a new value. The deep compare guards
  // against the editor's own edits, which round-trip back through `value`; re-setting content
  // there would fight the caret mid-typing. emitUpdate=false keeps this reconciliation from
  // looping back through onChange.
  useEffect(() => {
    if (!editor) return;
    const incoming = value ?? emptyRichTextDoc();
    if (JSON.stringify(editor.getJSON()) !== JSON.stringify(incoming)) {
      // Replace the content but keep it out of the undo history. This sync reacts to an
      // external value change (a reordered list item reusing this instance), not to an
      // edit made here. If it entered history, the toolbar Undo would replay it and
      // restore the previous item's body into the current slot. emitUpdate stays false so
      // the sync also does not loop back through onChange.
      editor
        .chain()
        .setContent(incoming, false)
        .command(({ tr }) => {
          tr.setMeta("addToHistory", false);
          return true;
        })
        .run();
    }
  }, [editor, value]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!inlineWriting.readOnly, false);
    textHistory?.update(editor);
  }, [editor, inlineWriting.readOnly, textHistory]);

  useEffect(() => {
    if (!editor || !workspaceView?.kind || !textHistory) return;
    const update = () => textHistory.update(editor);
    editor.on("transaction", update);
    return () => { editor.off("transaction", update); textHistory.release(editor); };
  }, [editor, workspaceView?.kind, textHistory]);

  if (!editor) {
    return <div className="rich-text" aria-busy="true" />;
  }

  function openLink() {
    if (!editor) return;
    const attributes = editor.getAttributes("link");
    setLinkUrl((attributes.href as string) ?? "");
    setLinkError(null);
    setAllowLegacyHost(attributes.allowLegacyHost === true);
    setLinkOpen(true);
  }

  function cancelLink() {
    setLinkOpen(false);
    linkTriggerRef.current?.focus();
  }

  function applyLink() {
    if (!editor) return;
    const href = linkUrl.trim();
    if (href) {
      if (!isAllowedRichTextHref(href)) {
        setLinkError({
          kind: "address",
          message:
            "Enter a link that starts with http://, https://, mailto:, tel:, or a relative NJ PBS path.",
        });
        return;
      }
      const applied = editor
        .chain()
        .extendMarkRange("link")
        .setLink({
          href,
          allowLegacyHost: allowLegacyHost ? true : null,
        } as { href: string; allowLegacyHost: true | null })
        .run();
      if (!applied) {
        setLinkError({
          kind: "selection",
          message: "This text cannot have a link. Select ordinary text and try again.",
        });
        return;
      }
      editor.commands.focus();
    } else {
      editor.chain().focus().unsetLink().run();
    }
    setLinkError(null);
    setLinkOpen(false);
  }


  function removeLink() {
    if (!editor) return;
    editor.chain().focus().unsetLink().run();
    setLinkOpen(false);
  }

  function moveToolbar(left: number, top: number) {
    const bounds = bubbleRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setManualPosition({
      left: Math.max(8, Math.min(left, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8)),
    });
  }

  const toolbarSurface = (
          <div
            className={`rich-text-context-menu${pinned ? " rich-text-context-menu-pinned" : ""}`}
            ref={bubbleRef}
            onKeyDownCapture={(event) => {
              if (event.key !== "Escape" || linkOpen) return;
              event.preventDefault();
              event.stopPropagation();
              editor.view.dom.focus({ preventScroll: true });
              editor.view.focus();
            }}
          >
            <div
              className="rich-text-toolbar"
              ref={setToolbar}
              role="toolbar"
              aria-label={`Formatting for ${ariaLabel}`}
            >
              {(workspaceFormatting ? toolbar.filter(button => ["bold", "italic", "quote", "bulleted-list"].includes(button.action)) : toolbar).map((button) => (
                <ActionControl
                  action={button.action}
                  key={button.label}
                  className="rich-text-button"
                  variant="ghost"
                  graphic={
                    button.glyph ? (
                      <span aria-hidden="true" className="action-control-glyph">
                        {button.glyph}
                      </span>
                    ) : undefined
                  }
                  graphicText={button.glyph}
                  label={button.label}
                  aria-pressed={button.isActive(editor)}
                  onClick={() => button.run(editor)}
                />
              ))}
              {!workspaceFormatting ? <ActionControl ref={modeButtonRef} action={pinned ? "float-toolbar" : "pin-toolbar"} className="rich-text-button" variant="ghost"
                onMouseDown={event => event.preventDefault()}
                onClick={event => {
                  restoreModeFocus.current = event.detail === 0 && event.currentTarget === event.currentTarget.ownerDocument.activeElement;
                  setManualPosition(null);
                  setToolbarMode(pinned ? "floating" : "pinned");
                }} /> : null}
              {!pinned ? <ActionControl action="move-toolbar" data-toolbar-local-arrows className="rich-text-button rich-text-toolbar-move" variant="ghost"
                tooltipLabel="Move toolbar: drag or use arrow keys"
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  const bounds = bubbleRef.current!.getBoundingClientRect();
                  drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
                    left: bounds.left, top: bounds.top };
                  event.currentTarget.setPointerCapture(event.pointerId);
                  moveToolbar(bounds.left, bounds.top);
                }}
                onPointerMove={(event) => {
                  const start = drag.current;
                  if (!start || start.pointerId !== event.pointerId) return;
                  moveToolbar(start.left + event.clientX - start.x, start.top + event.clientY - start.y);
                }}
                onPointerUp={() => {
                  drag.current = null;
                  const bounds = bubbleRef.current!.getBoundingClientRect();
                  moveToolbar(bounds.left, bounds.top);
                }}
                onPointerCancel={() => {
                  drag.current = null;
                  const bounds = bubbleRef.current!.getBoundingClientRect();
                  moveToolbar(bounds.left, bounds.top);
                }}
                onKeyDown={(event) => {
                  const delta = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[event.key];
                  if (!delta) return;
                  event.preventDefault();
                  const bounds = bubbleRef.current!.getBoundingClientRect();
                  moveToolbar(bounds.left + delta[0], bounds.top + delta[1]);
                }} /> : null}
              {workspaceFormatting ? <Select aria-label="Text style" controlSize="compact" value={toolbar.find(button => button.action === "heading" && button.isActive(editor))?.label ?? "Paragraph"} onChange={event => {
                if (event.target.value === "Paragraph") editor.chain().focus().setParagraph().run();
                else toolbar.find(button => button.label === event.target.value)?.run(editor);
              }}><option>Paragraph</option>{toolbar.filter(button => button.action === "heading").map(button => <option key={button.label}>{button.label}</option>)}</Select> : null}
              {!workspaceFormatting ? <ActionControl action="paragraph" className="rich-text-button" variant="ghost"
                aria-pressed={editor.isActive("paragraph")}
                onClick={() => editor.chain().focus().setParagraph().run()} /> : null}
              <ActionControl
                action="link"
                className="rich-text-button"
                variant="ghost"
                aria-pressed={editor.isActive("link")}
                aria-expanded={linkOpen}
                aria-controls={linkOpen ? linkBarId : undefined}
                onClick={(event) => {
                  linkTriggerRef.current = event.currentTarget;
                  openLink();
                }}
              />
              <ActionControl action={expandedToolbar ? "collapse" : "expand"}
                className="rich-text-button" variant="ghost"
                label={expandedToolbar ? "Collapse formatting" : "Expand formatting"}
                aria-expanded={expandedToolbar} aria-controls={expandedToolbarId}
                onClick={() => setExpandedToolbar((expanded) => !expanded)} />
              <div id={expandedToolbarId} className="rich-text-toolbar-more" hidden={!expandedToolbar}
                role="group" aria-label="More formatting">
                {workspaceFormatting ? toolbar.filter(button => ["inline-code", "numbered-list"].includes(button.action)).map(button => <ActionControl key={button.label} action={button.action} label={button.label} className="rich-text-button" variant="ghost" aria-pressed={button.isActive(editor)} onClick={() => button.run(editor)} />) : null}
                {!shortTextOnly ? <><ActionControl action="code-block" className="rich-text-button" variant="ghost"
                  aria-pressed={editor.isActive("codeBlock")}
                  onClick={() => editor.chain().focus().toggleCodeBlock().run()} />
                <ActionControl action="horizontal-rule" className="rich-text-button" variant="ghost"
                  onClick={() => editor.chain().focus().setHorizontalRule().run()} />
                </> : null}
                <ActionControl action="clear-formatting" className="rich-text-button" variant="ghost"
                  onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()} />
                {!shortTextOnly ? <><ActionControl action="indent-list" className="rich-text-button" variant="ghost"
                  disabled={!editor.can().sinkListItem("listItem")}
                  onClick={() => editor.chain().focus().sinkListItem("listItem").run()} />
                <ActionControl action="outdent-list" className="rich-text-button" variant="ghost"
                  disabled={!editor.can().liftListItem("listItem")}
                  onClick={() => editor.chain().focus().liftListItem("listItem").run()} />
                </> : null}
                <ActionControl action="select-all" className="rich-text-button" variant="ghost"
                  onClick={() => editor.chain().focus().selectAll().run()} />
              </div>
              {!workspaceFormatting ? <><span className="rich-text-divider" aria-hidden="true" />
              <ActionControl
                action="undo"
                className="rich-text-button"
                variant="ghost"
                disabled={!editor.can().undo()}
                onClick={() => editor.chain().focus().undo().run()}
              />
              <ActionControl
                action="redo"
                className="rich-text-button"
                variant="ghost"
                disabled={!editor.can().redo()}
                onClick={() => editor.chain().focus().redo().run()}
              /></> : null}
            </div>

            {linkOpen ? (
              <div
                className="rich-text-linkbar"
                id={linkBarId}
                role="group"
                aria-label="Link settings"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    cancelLink();
                  }
                }}
              >
                <InfoTooltip label="Link address" content="Use http://, https://, mailto:, tel:, or a relative NJ PBS path such as /about/." />
                <TextInput
                  aria-describedby={`${linkHintId}${linkError ? ` ${linkErrorId}` : ""}`}
                  aria-invalid={linkError?.kind === "address" ? "true" : undefined}
                  aria-label="Link address"
                  autoFocus
                  inputMode="url"
                  placeholder="https://example.org"
                  value={linkUrl}
                  onChange={(event) => {
                    setLinkUrl(event.target.value);
                    setLinkError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      applyLink();
                    }
                  }}
                />
                <Button onClick={applyLink}>Apply</Button>
                <Button variant="ghost" onClick={removeLink}>
                  Remove
                </Button>
                <Button variant="ghost" onClick={cancelLink}>
                  Cancel
                </Button>
                <p className="sr-only" id={linkHintId}>
                  Use http://, https://, mailto:, tel:, or a relative NJ PBS path such as /about/.
                </p>
                {linkError ? (
                  <p
                    className="field-error rich-text-link-help"
                    id={linkErrorId}
                    role="alert"
                  >
                    {linkError.message}
                  </p>
                ) : null}
                <label className="rich-text-legacy-host-opt-in">
                  <input
                    className="editor-toggle"
                    type="checkbox"
                    checked={allowLegacyHost}
                    onChange={(event) => setAllowLegacyHost(event.target.checked)}
                  />
                  <span>Allow this legacy host link</span>
                </label>
              </div>
            ) : null}
          </div>
  );

  return (
    <div
      className="rich-text"
      onFocusCapture={() => { setActive(true); if (workspaceView?.kind && editor) textHistory?.set(editor); }}
      onBlurCapture={(event) => {
        const next = event.relatedTarget;
        const staysInEditor = next instanceof Node && (
          event.currentTarget.contains(next) || bubbleRef.current?.contains(next) || workspaceFormatting && Boolean((next as HTMLElement).closest?.(".workspace-editing-bar"))
        );
        if (!staysInEditor) {
          setActive(false);
          setLinkOpen(false);
        }
      }}
    >
      {workspaceFormatting ? active && workspaceView?.formattingTarget ? createPortal(<ControlSizingProvider size="compact"><fieldset className="editor-contextual-formatting" disabled={inlineWriting.readOnly}>{toolbarSurface}</fieldset></ControlSizingProvider>, workspaceView.formattingTarget) : null : pinned ? toolbarSurface : active ? createPortal(toolbarSurface, overlayOwner ?? document.body) : null}

      <EditorContent editor={editor} />
    </div>
  );
}
