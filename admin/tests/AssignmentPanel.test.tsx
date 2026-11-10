import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AssignmentPanel } from "../src/components/AssignmentPanel";
import { HttpError } from "../src/lib/functions";

const staff = [
  { id: "editor-1", label: "Alex Editor (alex@example.com)" },
  { id: "editor-2", label: "Bailey Producer (bailey@example.com)" },
];

describe("AssignmentPanel", () => {
  it("announces a pending assignment and prevents duplicate submission", async () => {
    let resolveAssignment: (record: Record<string, unknown>) => void = () => {};
    const assignRecord = vi.fn(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveAssignment = resolve;
        }),
    );
    render(
      <AssignmentPanel
        assignee="editor-1"
        baseVersion={3}
        canAssign
        loadAssignableUsers={async () => staff}
        onAssign={assignRecord}
        recordId="a-1"
      />,
    );

    fireEvent.change(await screen.findByRole("combobox", {
      name: "Assigned staff member",
    }), { target: { value: "editor-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Update assignment" }));

    const pending = screen.getByRole("button", { name: /^.+: Updating assignment…$/ });
    expect(pending).not.toBeDisabled();
    expect(pending).toHaveAttribute("aria-disabled", "true");
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(pending.querySelector(".activity-indicator")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Updating assignment.");
    fireEvent.click(pending);
    expect(assignRecord).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveAssignment({ id: "a-1", assignee: "editor-2", version: 4 });
    });
    expect((await screen.findByText("Assignment updated")).closest('[role="status"]'))
      .toHaveTextContent("Assignment updated");
  });

  it("stages and explicitly commits a versioned assignment", async () => {
    const assignRecord = vi.fn(async () => ({
      id: "a-1",
      assignee: "editor-2",
      version: 4,
    }));
    const onAssigned = vi.fn();
    render(
      <AssignmentPanel
        assignee="editor-1"
        baseVersion={3}
        canAssign
        loadAssignableUsers={async () => staff}
        onAssign={assignRecord}
        onAssigned={onAssigned}
        recordId="a-1"
      />,
    );

    const select = await screen.findByRole("combobox", {
      name: "Assigned staff member",
    });
    expect(select).toHaveValue("editor-1");
    fireEvent.change(select, { target: { value: "editor-2" } });
    expect(assignRecord).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Update assignment" }));

    expect((await screen.findByText("Assignment updated")).closest('[role="status"]'))
      .toHaveTextContent("Assignment updated");
    expect(assignRecord).toHaveBeenCalledWith({
      id: "a-1",
      baseVersion: 3,
      assignee: "editor-2",
    });
    expect(onAssigned).toHaveBeenCalledWith({
      id: "a-1",
      assignee: "editor-2",
      version: 4,
    });
  });

  it("supports a deliberate unassigned queue state", async () => {
    const assignRecord = vi.fn(async () => ({
      id: "a-1",
      assignee: null,
      version: 4,
    }));
    render(
      <AssignmentPanel
        assignee="editor-1"
        baseVersion={3}
        canAssign
        loadAssignableUsers={async () => staff}
        onAssign={assignRecord}
        recordId="a-1"
      />,
    );

    const select = await screen.findByRole("combobox", {
      name: "Assigned staff member",
    });
    fireEvent.change(select, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Update assignment" }));

    await waitFor(() => expect(assignRecord).toHaveBeenCalledWith({
      id: "a-1",
      baseVersion: 3,
      assignee: null,
    }));
  });

  it("does not carry a staged assignee into another record or refreshed baseline", async () => {
    const assignRecord = vi.fn();
    const loadAssignableUsers = async () => staff;
    const { rerender } = render(
      <AssignmentPanel
        assignee="editor-1"
        baseVersion={3}
        canAssign
        loadAssignableUsers={loadAssignableUsers}
        onAssign={assignRecord}
        recordId="a-1"
      />,
    );

    const select = await screen.findByRole("combobox", {
      name: "Assigned staff member",
    });
    fireEvent.change(select, { target: { value: "editor-2" } });
    expect(select).toHaveValue("editor-2");

    rerender(
      <AssignmentPanel
        assignee="editor-1"
        baseVersion={7}
        canAssign
        loadAssignableUsers={loadAssignableUsers}
        onAssign={assignRecord}
        recordId="a-2"
      />,
    );

    expect(select).toHaveValue("editor-1");
    expect(screen.getByRole("button", { name: "Update assignment" })).toBeDisabled();

    rerender(
      <AssignmentPanel
        assignee="editor-2"
        baseVersion={8}
        canAssign
        loadAssignableUsers={loadAssignableUsers}
        onAssign={assignRecord}
        recordId="a-2"
      />,
    );

    expect(select).toHaveValue("editor-2");
    expect(screen.getByRole("button", { name: "Update assignment" })).toBeDisabled();
    expect(assignRecord).not.toHaveBeenCalled();
  });

  it("protects unsaved form work from an assignment-triggered remount", async () => {
    const assignRecord = vi.fn();
    render(
      <AssignmentPanel
        assignee={null}
        baseVersion={3}
        canAssign
        disabledReason="Save or revert your content edits before changing assignment."
        loadAssignableUsers={async () => staff}
        onAssign={assignRecord}
        recordId="a-1"
      />,
    );

    expect(await screen.findByRole("combobox", {
      name: "Assigned staff member",
    })).toBeDisabled();
    expect(screen.getByText(
      "Save or revert your content edits before changing assignment.",
    )).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update assignment" })).toBeDisabled();
    expect(assignRecord).not.toHaveBeenCalled();
  });

  it("keeps a stale assignment unchanged and offers a record reload", async () => {
    const reload = vi.fn();
    render(
      <AssignmentPanel
        assignee="editor-1"
        baseVersion={3}
        canAssign
        loadAssignableUsers={async () => staff}
        onAssign={async () => {
          throw new HttpError(409, "This record changed since you opened it.");
        }}
        onReload={reload}
        recordId="a-1"
      />,
    );

    fireEvent.change(await screen.findByRole("combobox", {
      name: "Assigned staff member",
    }), { target: { value: "editor-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Update assignment" }));

    expect(await screen.findByText("Assignment was not changed")).toBeInTheDocument();
    expect(screen.getByText("This record changed since you opened it.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload record" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("recovers when the staff directory cannot be loaded", async () => {
    const loadAssignableUsers = vi
      .fn()
      .mockRejectedValueOnce(new Error("directory unavailable"))
      .mockResolvedValueOnce(staff);
    render(
      <AssignmentPanel
        assignee={null}
        baseVersion={3}
        canAssign
        loadAssignableUsers={loadAssignableUsers}
        onAssign={vi.fn()}
        recordId="a-1"
      />,
    );

    expect(await screen.findByText("Staff choices could not be loaded")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try loading staff again" }));
    expect(await screen.findByRole("combobox", {
      name: "Assigned staff member",
    })).toBeEnabled();
    expect(loadAssignableUsers).toHaveBeenCalledTimes(2);
  });
});
