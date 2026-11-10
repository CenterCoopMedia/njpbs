import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { EditorActionsProvider, EditorActionSlot } from "../src/components/EditorActions";
import { LifecycleActionsPanel } from "../src/components/LifecycleActionsPanel";
import { WorkspaceActionsProvider } from "../src/components/WorkspaceActions";

function Editor({ label = "Post", canPublish = true, disabledReason }: { label?: string; canPublish?: boolean; disabledReason?: string }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [feedback, setFeedback] = useState<HTMLDivElement | null>(null);
  return <>
    <div ref={setTarget} />
    <div ref={setFeedback} />
    <WorkspaceActionsProvider target={target} feedbackTarget={feedback}>
      <EditorActionsProvider label={label}>
        <EditorActionSlot group="save"><button>Save draft</button></EditorActionSlot>
        <EditorActionSlot group="preview"><button>Preview</button></EditorActionSlot>
        <EditorActionSlot group="routine"><button>Duplicate post</button></EditorActionSlot>
        <LifecycleActionsPanel collection="cmsPosts" documentId="fixture" status="draft" baseVersion={3}
          canEdit canPublish={canPublish} canArchive canUnpublish canRestore publicationSupported
          disabledReason={disabledReason} workspaceActions
          onTransition={async request => ({ success: true, ...request, fromStatus: "draft", toStatus: "archived", version: 4, document: { status: "archived", version: 4 } })}
          onPublish={async () => ({ document: { status: "published", version: 4 } })}
          onSchedule={async () => ({ document: { status: "scheduled", version: 4 } })} />
      </EditorActionsProvider>
    </WorkspaceActionsProvider>
  </>;
}

describe("Editor actions", () => {
  it.each(["Post", "Page", "Program", "Event"])("groups editing, publishing and destructive %s actions", async label => {
    render(<Editor label={label} />);
    const editing = screen.getByRole("group", { name: "Editing" });
    expect(within(editing).getAllByRole("button").map(button => button.textContent)).toEqual(["Save draft", "Preview"]);
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    const publishing = screen.getByText("Publishing", { selector: "summary" });
    await waitFor(() => expect(publishing).toBeVisible());
    fireEvent.click(publishing);
    expect(screen.getByRole("button", { name: "Publish" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Schedule publish" })).toBeEnabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(publishing).toHaveFocus();
    const actions = screen.getByText(`${label} actions`, { selector: "summary" });
    fireEvent.click(actions);
    expect(screen.getByRole("button", { name: "Duplicate post" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByRole("button", { name: "Move to recycle bin" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(actions).toHaveFocus();
  });

  it("keeps review available without offering publication to a writer", async () => {
    render(<Editor canPublish={false} />);
    expect(screen.getByRole("button", { name: "Submit for review" })).toBeEnabled();
    await waitFor(() => expect(screen.getByText("Publishing", { selector: "summary" })).not.toBeVisible());
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
  });

  it("keeps disabled actions explained without removing their labels", async () => {
    render(<Editor disabledReason="Save or revert your content edits before changing lifecycle." />);
    const publishing = screen.getByText("Publishing", { selector: "summary" });
    await waitFor(() => expect(publishing).toBeVisible());
    fireEvent.click(publishing);
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Schedule publish" })).toBeDisabled();
    const reason = "Save or revert your content edits before changing lifecycle.";
    for (const name of ["Publish", "Schedule publish", "Submit for review"]) {
      expect(screen.getByRole("button", { name })).toHaveAccessibleDescription(reason);
    }
    const explanations = within(screen.getByRole("group", { name: "Publishing" })).getAllByText(reason);
    expect(explanations).toHaveLength(3);
    for (const explanation of explanations) expect(explanation).toBeVisible();
  });
});

it("returns keyboard navigation from portaled actions to the toolbar", async () => {
  render(<Editor />);
  const trigger = screen.getByRole("button", { name: "Post actions" });
  await waitFor(() => expect(trigger).toBeVisible());
  fireEvent.click(trigger);
  const first = screen.getByRole("button", { name: "Duplicate post" });
  expect(first).toHaveFocus();
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(trigger);
  const last = screen.getByRole("button", { name: "Delete" });
  last.focus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
});
