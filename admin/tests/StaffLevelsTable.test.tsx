import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UsersTable, type AdminUserRecord } from "../src/components/UsersTable";
import { accessStateFromUserDoc } from "../src/lib/principal";

const legacy: AdminUserRecord = { id: "target", displayName: "Target person", email: "target@example.test", role: null, grants: [{ role: "editor", sections: ["watch"] }] };
function setup(users = [legacy], overrides: Record<string, unknown> = {}) {
  const onSetLevel = vi.fn(async () => {});
  const props = { users, tiersActive: true, canManage: true, currentUserId: "actor", onSetLevel, onGrant: vi.fn(), onRevoke: vi.fn(), ...overrides };
  return { ...render(<UsersTable {...props} />), onSetLevel, props };
}
const edit = () => fireEvent.click(screen.getByRole("button", { name: "Edit access level for Target person" }));
const choose = (value = "publisher") => fireEvent.change(screen.getByRole("combobox", { name: "Access level for Target person" }), { target: { value } });

describe("activated staff levels in their existing table owner", () => {
  it.each([true, false])("shows only a known incomplete shutdown as retryable (tiers active: %s)", (tiersActive) => {
    const rows = [
      { ...legacy, id: "complete", displayName: "Complete person", active: false, offboarding: { id: "done", step: "complete" } },
      { ...legacy, id: "unknown", displayName: "Unknown person", email: "unknown@example.test", active: false },
      { ...legacy, id: "profile", displayName: "Profile person", email: "profile@example.test", active: false, offboarding: { id: "profile", step: "public_profile" } },
      { ...legacy, id: "sessions", displayName: "Sessions person", email: "sessions@example.test", active: false, offboarding: { id: "sessions", step: "sign_in_and_sessions" } },
    ];
    setup(rows, { tiersActive, onDeactivate: vi.fn(), onReactivate: vi.fn() });
    if (tiersActive) {
      expect(screen.queryByRole("button", { name: "Retry offboarding for Complete person" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Retry offboarding for Unknown person" })).not.toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: /Retry offboarding/ })).toHaveLength(2);
      expect(screen.getByText("Inactive, access removed.")).toBeVisible();
      expect(screen.getByText("Inactive. Boardwalk access is off; account shutdown has not been verified.")).toBeVisible();
      expect(screen.getByRole("button", { name: "Check offboarding for Unknown person" })).toBeVisible();
      expect(screen.getByText("Finish withdrawing the public profile, disabling sign-in and revoking sessions.")).toBeVisible();
      expect(screen.getByText("Finish disabling sign-in and revoking sessions.")).toBeVisible();
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Manage access for target@example.test" }));
      expect(screen.queryByRole("button", { name: "Retry offboarding" })).not.toBeInTheDocument();
      expect(screen.getByText(/Inactive, access removed/)).toBeVisible();
    }
  });
  it("returns focus to Reactivate when a successful retry disappears", async () => {
    const inactive = { ...legacy, active: false, offboarding: { id: "operation", step: "sign_in_and_sessions" } };
    const view = setup([inactive], { onDeactivate: vi.fn(), onReactivate: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "Retry offboarding for Target person" }));
    // Deliver the live snapshot as soon as success renders, before the queued
    // focus reset can settle. A later snapshot misses this race.
    const observer = new MutationObserver(() => {
      if (!screen.queryByText("Account deactivated and sessions revoked.")) return;
      observer.disconnect();
      view.rerender(<UsersTable {...view.props} users={[{ ...inactive, offboarding: { id: "operation", step: "complete" } }]} />);
    });
    observer.observe(view.container, { childList: true, subtree: true });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Confirm deactivation for Target person" }));
      await screen.findByText("Account deactivated and sessions revoked.");
      await waitFor(() => expect(screen.getByRole("button", { name: "Reactivate Target person" })).toHaveFocus());
      expect(screen.queryByRole("button", { name: /Retry offboarding/ })).not.toBeInTheDocument();
    } finally {
      observer.disconnect();
    }
  });
  it("does not move focus from another control when shutdown completes externally", () => {
    const inactive = { ...legacy, active: false, offboarding: { id: "operation", step: "sign_in_and_sessions" } };
    const view = setup([inactive], { onDeactivate: vi.fn(), onReactivate: vi.fn() });
    screen.getByRole("searchbox").focus();
    view.rerender(<UsersTable {...view.props} users={[{ ...inactive, offboarding: { id: "operation", step: "complete" } }]} />);
    expect(screen.getByRole("searchbox")).toHaveFocus();
  });
  it("confirms a neutral offboarding check for an unverified inactive account before staff levels are active", async () => {
    const onDeactivate = vi.fn();
    setup([{ ...legacy, active: false }], { tiersActive: false, onDeactivate });
    fireEvent.click(screen.getByRole("button", { name: "Manage access for target@example.test" }));
    fireEvent.click(screen.getByRole("button", { name: "Check offboarding" }));
    expect(onDeactivate).not.toHaveBeenCalled();
    expect(screen.getByText("Check offboarding for target@example.test")).toBeVisible();
    expect(screen.queryByText("Retry offboarding for target@example.test")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm offboarding" }));
    await waitFor(() => expect(onDeactivate).toHaveBeenCalledWith("target"));
  });
  it("keeps unmigrated access explicit and offers the six whole-site levels only after Edit", () => {
    setup();
    expect(screen.getByText("Legacy access: Editor")).toBeVisible();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText("Manage access")).not.toBeInTheDocument();
    edit();
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Choose a level", "Viewer", "Contributor", "Editor", "Publisher", "Admin", "Owner"]);
    expect(screen.getByRole("button", { name: "Confirm level for Target person" })).toBeDisabled();
  });
  it("confirms whole-site replacement and sends exactly the access reviewed when Edit opened", async () => {
    const view = setup();
    edit(); choose();
    expect(within(screen.getByRole("group", { name: "Change access for Target person" })).getByText(/publish, withdraw and delete content/)).toBeVisible();
    expect(screen.getByText(/and all current roles and area grants/)).toBeVisible();
    expect(screen.getByText(/Every ability in the new level applies across the whole site/)).toBeVisible();
    expect(view.onSetLevel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm level for Target person" }));
    await waitFor(() => expect(view.onSetLevel).toHaveBeenCalledWith({ targetUid: legacy.id, accessTier: "publisher", expectedAccess: accessStateFromUserDoc(legacy) }));
    expect(await screen.findByText("Access level saved.")).toBeVisible();
  });
  it("blocks confirmation when the live row changes", () => {
    const view = setup();
    edit(); choose();
    view.rerender(<UsersTable {...view.props} users={[{ ...legacy, grants: [{ role: "contributor" }] }]} />);
    expect(screen.getByText(/Cancel and review the current row/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Confirm level for Target person" })).toBeDisabled();
    expect(view.onSetLevel).not.toHaveBeenCalled();
  });
  it("keeps confirmation and progress visible when search no longer matches", async () => {
    let finish!: () => void;
    const onSetLevel = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    setup([legacy], { onSetLevel });
    edit(); choose();
    fireEvent.click(screen.getByRole("button", { name: "Confirm level for Target person" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "unrelated" } });
    expect(screen.getByRole("button", { name: "Saving access for Target person" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Saving access for Target person" })).toBeDisabled();
    finish();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Saving access for Target person" })).not.toBeInTheDocument());
    expect(screen.getByText("Access level saved.")).toBeVisible();
    expect(screen.getByText("1 of 1 shown")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss access message for Target person" }));
    expect(screen.getByRole("searchbox")).toHaveFocus();
  });
  it("keeps an actionable failure available for retry", async () => {
    const onSetLevel = vi.fn().mockRejectedValueOnce(new Error("Access changed; review the row")).mockResolvedValue(undefined);
    setup([legacy], { onSetLevel }); edit(); choose();
    fireEvent.click(screen.getByRole("button", { name: "Confirm level for Target person" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Access changed; review the row");
    expect(screen.getByRole("button", { name: "Confirm level for Target person" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm level for Target person" }));
    expect(await screen.findByText("Access level saved.")).toBeVisible();
  });
  it("disables self and inactive assignment and hides controls from read-only staff", () => {
    const view = setup([{ ...legacy, id: "actor" }, { ...legacy, id: "inactive", displayName: "Inactive person", active: false }]);
    expect(screen.getByRole("button", { name: "Edit access level for Target person" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit access level for Inactive person" })).toBeDisabled();
    view.rerender(<UsersTable {...view.props} canManage={false} />);
    expect(screen.queryByRole("button", { name: /^Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
  it("does not use stale roles to display a malformed or authoritative tier", () => {
    setup([{ ...legacy, accessTier: "viewer", role: "super_admin" }, { ...legacy, id: "invalid", accessTier: null, role: "super_admin" }]);
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("Viewer")).toBeVisible();
    expect(within(rows[1]).getByText("Invalid level — no access")).toBeVisible();
    expect(screen.queryByText(/Legacy access/)).not.toBeInTheDocument();
  });
  it("closes an open confirmation when current Owner permission is lost", () => {
    const view = setup(); edit(); choose();
    view.rerender(<UsersTable {...view.props} canManage={false} />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirm level/ })).not.toBeInTheDocument();
    expect(view.onSetLevel).not.toHaveBeenCalled();
  });
  it("preserves explicit offboarding confirmation and retry for tier accounts", async () => {
    const onDeactivate = vi.fn().mockRejectedValueOnce(new Error("Session revocation must be retried")).mockResolvedValue(undefined);
    const view = setup([{ ...legacy, accessTier: "publisher" }], { onDeactivate });
    fireEvent.click(screen.getByRole("button", { name: "Deactivate Target person" }));
    expect(onDeactivate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm deactivation for Target person" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Session revocation must be retried");
    view.rerender(<UsersTable {...view.props} users={[{ ...legacy, active: false }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm deactivation for Target person" }));
    await waitFor(() => expect(onDeactivate).toHaveBeenCalledTimes(2));
  });
  it("reactivates an inactive account at Viewer by default and keeps a failed attempt open for retry", async () => {
    const onReactivate = vi.fn().mockRejectedValueOnce(new Error("Sign-in is still off")).mockResolvedValue(undefined);
    const inactive = { ...legacy, role: null, grants: [], active: false };
    const view = setup([inactive, { ...legacy, id: "active", displayName: "Active person", accessTier: "viewer" }], { onReactivate, onDeactivate: vi.fn() });
    expect(screen.queryByRole("button", { name: "Reactivate Active person" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reactivate Target person" }));
    const group = screen.getByRole("group", { name: "Confirm reactivation for Target person" });
    expect(within(group).getByRole("combobox", { name: "Access level after reactivation for Target person" })).toHaveValue("viewer");
    expect(within(group).getByText(/Old roles and area grants do not come back/)).toBeVisible();
    expect(within(group).getByText(/public author profile and shared navigation stay off/)).toBeVisible();
    fireEvent.change(within(group).getByRole("combobox"), { target: { value: "contributor" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm reactivation for Target person" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign-in is still off");
    view.rerender(<UsersTable {...view.props} users={[{ ...inactive, active: true, accessTier: "contributor" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm reactivation for Target person" }));
    await waitFor(() => expect(onReactivate).toHaveBeenLastCalledWith({ targetUid: "target", accessTier: "contributor" }));
    expect(await screen.findByText("Account reactivated at Contributor. Sign-in is on.")).toBeVisible();
    expect(onReactivate).toHaveBeenCalledTimes(2);
  });
  it("moves focus into Edit and back to its visible row action on Cancel and success", async () => {
    setup(); edit();
    expect(screen.getByRole("combobox", { name: "Access level for Target person" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Edit access level for Target person" })).toHaveFocus();
    edit(); choose();
    fireEvent.click(screen.getByRole("button", { name: "Confirm level for Target person" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit access level for Target person" })).toHaveFocus());
  });
  it("shows the publishing loss when converting a legacy Editor to new Editor", () => {
    setup(); edit(); choose("editor");
    expect(screen.getByText(/including abilities previously limited to particular areas/)).toBeVisible();
    fireEvent.click(screen.getByText("Review abilities added and removed"));
    expect(screen.getByText("No longer able to:")).toBeVisible();
    expect(screen.getByText("publish content")).toBeVisible();
    expect(screen.getByText("unpublish content")).toBeVisible();
  });
});
