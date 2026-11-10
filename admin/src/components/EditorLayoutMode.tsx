import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { EDITOR_BENTO_RESET_LAYOUT_EVENT } from "../lib/editor-bento-events";
import "../editor-layout-mode.css";

const MOVEMENT_CONTROL_SELECTOR =
  ".editor-bento-grip, .editor-bento-card-controls";

function findPageEditorLayout(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '.content-studio .editor-bento[aria-label="Page editor sections"]',
  );
}

function setMovementControlsAvailable(
  editor: HTMLElement,
  available: boolean,
): void {
  const controls = editor.querySelectorAll<HTMLElement>(
    MOVEMENT_CONTROL_SELECTOR,
  );
  for (const control of controls) {
    control.inert = !available;
    control.setAttribute("aria-hidden", available ? "false" : "true");
    if (control.classList.contains("editor-bento-grip")) {
      control.draggable = available;
    }
  }
}

// Keep section movement out of the normal editing path. The editor owns the panels and their state;
// this small shell only changes when its existing movement controls are available. It never edits
// content, changes a panel body, or creates a second layout model.
export function EditorLayoutMode() {
  const [editor, setEditor] = useState<HTMLElement | null>(null);
  const [customizing, setCustomizing] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const readEditor = () => {
      const next = findPageEditorLayout();
      setEditor((current) => (current === next ? current : next));
    };

    readEditor();
    const observer = new MutationObserver(readEditor);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setCustomizing(false);
    setAnnouncement("");
  }, [editor]);

  useEffect(() => {
    if (!editor) return;

    editor.dataset.layoutMode = customizing ? "customize" : "edit";
    setMovementControlsAvailable(editor, customizing);

    const refreshControls = new MutationObserver(() => {
      setMovementControlsAvailable(editor, customizing);
    });
    refreshControls.observe(editor, { childList: true, subtree: true });

    const blockUnexpectedDrag = (event: DragEvent) => {
      if (customizing) return;
      const target = event.target;
      if (
        !(target instanceof Element) ||
        !target.closest(MOVEMENT_CONTROL_SELECTOR)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    editor.addEventListener("dragstart", blockUnexpectedDrag, true);

    return () => {
      refreshControls.disconnect();
      editor.removeEventListener("dragstart", blockUnexpectedDrag, true);
      delete editor.dataset.layoutMode;
      setMovementControlsAvailable(editor, true);
    };
  }, [customizing, editor]);

  if (!editor) return null;
  const layoutTools = editor.querySelector<HTMLElement>(
    ":scope > .editor-bento-layout-tools",
  );
  if (!layoutTools) return null;

  const toggleLabel = customizing
    ? "Finish arranging sections"
    : "Customize section layout";

  return createPortal(
    <div
      className="editor-layout-mode"
      role="group"
      aria-label="Page section layout"
    >
      <p className="editor-layout-mode-copy">
        {customizing
          ? "Move or reorder sections, then finish arranging to return to editing."
          : "Page sections stay in a stable task order during normal editing."}
      </p>
      <div className="editor-layout-mode-actions">
        <button
          type="button"
          className={`button ${customizing ? "button-secondary" : "button-ghost"}`}
          aria-pressed={customizing}
          onClick={() => {
            setCustomizing((current) => !current);
            setAnnouncement(
              customizing
                ? "Section layout controls are hidden."
                : "Section layout controls are available.",
            );
          }}
        >
          {toggleLabel}
        </button>
        {customizing ? (
          <button
            type="button"
            className="button button-ghost"
            onClick={() => {
              editor.dispatchEvent(
                new Event(EDITOR_BENTO_RESET_LAYOUT_EVENT),
              );
              setAnnouncement(
                "The default section order was restored.",
              );
            }}
          >
            Restore default order
          </button>
        ) : null}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>,
    layoutTools,
  );
}
