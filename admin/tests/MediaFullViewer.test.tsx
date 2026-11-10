import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  MediaFullViewer,
  mediaFullViewerKey,
  restoreMediaFullViewerFocus,
  type MediaFullViewerBodyContext,
  type MediaFullViewerItem,
} from "../src/components/media/MediaFullViewer";
import type { MediaAssetRef } from "../src/lib/media-identity";

const items: readonly MediaFullViewerItem[] = [
  {
    ref: { backend: "r2", id: "shared" },
    kind: "image",
    name: "Opening still",
  },
  {
    ref: { backend: "r2", id: "packet" },
    kind: "document",
    name: "Board packet",
  },
  {
    ref: { backend: "s3", sourceId: "video-library", id: "shared" },
    kind: "video",
    name: "Evening update",
  },
];

function StatefulTool({ kind }: { kind: MediaFullViewerItem["kind"] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open {kind} options</button>
      {open ? <span>{kind} options open</span> : null}
    </>
  );
}

const itemsWithStatefulTools: readonly MediaFullViewerItem[] = items.map(item => ({
  ...item,
  actions: <StatefulTool kind={item.kind} />,
}));

function LocalBody({
  context,
  onMount,
  onUnmount,
  onVideoPreview,
}: {
  context: MediaFullViewerBodyContext;
  onMount: (key: string) => void;
  onUnmount: (key: string) => void;
  onVideoPreview: (key: string) => void;
}) {
  const { item, headerActionsTarget, headerFactsTarget, onDirtyChange, onSavingChange } = context;
  const key = mediaFullViewerKey(item.ref);
  useEffect(() => {
    onMount(key);
    onDirtyChange(false);
    onSavingChange(false);
    if (item.kind === "video") onVideoPreview(key);
    return () => {
      onUnmount(key);
      onDirtyChange(false);
      onSavingChange(false);
    };
  }, [item.kind, key, onDirtyChange, onMount, onSavingChange, onUnmount, onVideoPreview]);

  return (
    <>
      {headerActionsTarget
        ? createPortal(<button type="button">{item.kind} tool</button>, headerActionsTarget)
        : null}
      {headerFactsTarget ? createPortal(`${item.kind} facts`, headerFactsTarget) : null}
      <div className="component-editor-dialog-content">
        {context.dirtyPrompt}
        <p>{item.kind} body</p>
        <label>
          Body field
          <input onChange={() => onDirtyChange(true)} />
        </label>
        <div role="dialog" aria-label="Nested body dialog">
          <button type="button">Nested action</button>
        </div>
      </div>
      <aside className="component-editor-dialog-settings">{item.kind} settings</aside>
    </>
  );
}

function ViewerHarness({
  initial,
  viewerItems = items,
  onMount = vi.fn(),
  onUnmount = vi.fn(),
  onVideoPreview = vi.fn(),
  onStep,
  restoreOnClose = false,
}: {
  initial?: MediaAssetRef;
  viewerItems?: readonly MediaFullViewerItem[];
  onMount?: (key: string) => void;
  onUnmount?: (key: string) => void;
  onVideoPreview?: (key: string) => void;
  onStep?: (item: MediaFullViewerItem) => void;
  restoreOnClose?: boolean;
}) {
  const [activeRef, setActiveRef] = useState(initial ?? viewerItems[0].ref);
  const [open, setOpen] = useState(true);
  const [removed, setRemoved] = useState<string>();
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const fallback = useRef<HTMLHeadingElement>(null);
  const focusReturn = restoreOnClose ? {
    focusItem: (ref: MediaAssetRef) => {
      const card = cardRefs.current.get(mediaFullViewerKey(ref));
      card?.focus();
      return Boolean(card);
    },
    focusFallback: () => fallback.current?.focus(),
  } : {};
  return (
    <>
      <h2 ref={fallback} tabIndex={-1}>Results</h2>
      {viewerItems.map(item => {
        const key = mediaFullViewerKey(item.ref);
        return key === removed ? null : (
          <button key={key} ref={node => {
            if (node) cardRefs.current.set(key, node);
            else cardRefs.current.delete(key);
          }} type="button">
            Open {item.name}
          </button>
        );
      })}
      {open ? (
        <MediaFullViewer
          activeRef={activeRef}
          items={viewerItems}
          onClose={item => {
            if (restoreOnClose) setRemoved(mediaFullViewerKey(item.ref));
            setOpen(false);
          }}
          onStep={item => onStep ? onStep(item) : setActiveRef(item.ref)}
          {...focusReturn}
          renderBody={context => (
            <LocalBody
              context={context}
              onMount={onMount}
              onUnmount={onUnmount}
              onVideoPreview={onVideoPreview}
            />
          )}
        />
      ) : null}
    </>
  );
}

describe("MediaFullViewer", () => {
  it("keeps one shell while switching mixed full refs, labeled bodies and tools", async () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    const preview = vi.fn();
    render(<ViewerHarness onMount={mounted} onUnmount={unmounted} onVideoPreview={preview} />);

    const dialog = screen.getByRole("dialog", { name: "Opening still" });
    expect(screen.getByRole("region", { name: "Image viewer" })).toHaveTextContent("image body");
    expect(screen.getByRole("group", { name: "Image viewer tools" })).toHaveTextContent("image tool");
    expect(dialog).toHaveTextContent("image facts");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("1 of 3");
    expect(preview).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    expect(screen.getByRole("dialog", { name: "Board packet" })).toBe(dialog);
    expect(screen.getByRole("region", { name: "Document viewer" })).toHaveTextContent("document body");
    expect(screen.getByRole("group", { name: "Document viewer tools" })).toHaveTextContent("document tool");
    await waitFor(() => expect(screen.getByRole("button", { name: "Next file" })).toHaveFocus());
    expect(unmounted).toHaveBeenCalledWith("r2:shared");
    expect(preview).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    expect(screen.getByRole("dialog", { name: "Evening update" })).toBe(dialog);
    expect(screen.getByRole("region", { name: "Video viewer" })).toHaveTextContent("video body");
    expect(screen.getByRole("group", { name: "Video viewer tools" })).toHaveTextContent("video tool");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("3 of 3");
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    expect(preview).toHaveBeenCalledWith("s3:video-library:shared");
    expect(unmounted).toHaveBeenCalledWith("r2:packet");
    expect(mounted).toHaveBeenCalledTimes(3);
  });

  it("uses the active body's dirty prompt and returns focus to the initiating control", async () => {
    render(<ViewerHarness />);
    fireEvent.change(screen.getByRole("textbox", { name: "Body field" }), { target: { value: "Changed" } });
    const next = screen.getByRole("button", { name: "Next file" });
    fireEvent.click(next);

    expect(screen.getByText("Unsaved image changes")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Opening still" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(next).toHaveFocus());

    fireEvent.click(next);
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByRole("dialog", { name: "Board packet" })).toBeInTheDocument();
  });

  it("remounts stateful header tools when the active full ref changes", () => {
    render(<ViewerHarness viewerItems={itemsWithStatefulTools} />);
    fireEvent.click(screen.getByRole("button", { name: "Open image options" }));
    expect(screen.getByText("image options open")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    expect(screen.queryByText("image options open")).not.toBeInTheDocument();
    expect(screen.queryByText("document options open")).not.toBeInTheDocument();
  });

  it("keeps body focus after a declined step and a later list refresh", async () => {
    const onStep = vi.fn();
    const { rerender } = render(<ViewerHarness onStep={onStep} />);
    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    expect(onStep).toHaveBeenCalledWith(items[1]);
    const field = screen.getByRole("textbox", { name: "Body field" });
    field.focus();
    rerender(<ViewerHarness onStep={onStep} viewerItems={[items[0], items[2]]} />);
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(field).toHaveFocus();
  });

  it("leaves arrows and Escape with body controls and nested dialogs", () => {
    render(<ViewerHarness />);
    const field = screen.getByRole("textbox", { name: "Body field" });
    fireEvent.keyDown(field, { key: "ArrowRight" });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Opening still" })).toBeInTheDocument();

    const nested = screen.getByRole("dialog", { name: "Nested body dialog" });
    fireEvent.keyDown(within(nested).getByRole("button", { name: "Nested action" }), { key: "ArrowRight" });
    expect(screen.getByRole("dialog", { name: "Opening still" })).toBeInTheDocument();
  });

  it("returns focus from the final full ref to the next visible item", async () => {
    render(<ViewerHarness initial={items[1].ref} restoreOnClose />);
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Open Evening update" })).toHaveFocus());
  });

  it("closes and returns focus when the active item leaves the result set", async () => {
    const { rerender } = render(<ViewerHarness initial={items[1].ref} restoreOnClose />);
    rerender(<ViewerHarness initial={items[1].ref} viewerItems={[items[0], items[2]]} restoreOnClose />);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Board packet" })).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Open Evening update" })).toHaveFocus());
  });
});

it("uses the results fallback when none of the opening-order items remain", () => {
  const focusItem = vi.fn<(ref: MediaAssetRef) => boolean>(() => false);
  const fallback = vi.fn();
  restoreMediaFullViewerFocus(items, items[1].ref, focusItem, fallback);
  expect(focusItem.mock.calls.map(([ref]) => mediaFullViewerKey(ref))).toEqual([
    "r2:packet",
    "s3:video-library:shared",
    "r2:shared",
  ]);
  expect(fallback).toHaveBeenCalledOnce();
});
