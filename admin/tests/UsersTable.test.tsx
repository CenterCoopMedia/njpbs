import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UsersTable, type AdminUserRecord } from "../src/components/UsersTable";

const users: AdminUserRecord[] = [
  {
    id: "target",
    email: "target@example.com",
    displayName: "Target user",
    role: null,
    grants: [{ role: "editor", sections: ["watch"] }],
  },
];

function openEditor(label = "Manage access for target@example.com") {
  fireEvent.click(screen.getByRole("button", { name: label }));
}

function chooseNamedSections() {
  fireEvent.click(screen.getByRole("radio", { name: "Named areas" }));
}

// The picker offers the registry desks as checkboxes, so a section is chosen by name
// rather than typed. Unknown names are no longer expressible in the form at all.
function chooseSection(label: string) {
  fireEvent.click(screen.getByRole("checkbox", { name: label }));
}

describe("UsersTable", () => {
  it("hides grant and revoke controls when management is denied", () => {
    render(
      <UsersTable
        canManage={false}
        users={users}
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /grant/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /revoke/i }),
    ).not.toBeInTheDocument();
  });

  it("shows grant and revoke controls when management is allowed", () => {
    render(
      <UsersTable
        canManage
        users={users}
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Grant Manager" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Manage access")).toBeVisible();
    openEditor();
    expect(
      screen.getByRole("button", { name: "Grant Manager" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke Manager" })).toHaveClass(
      "button-danger",
    );
    expect(
      screen.getByRole("button", { name: "Grant Viewer" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Revoke Viewer" }),
    ).toHaveClass("button-danger");
    expect(
      screen.getByRole("button", { name: "Grant role" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Revoke full role" }),
    ).toBeInTheDocument();
    chooseNamedSections();
    expect(
      screen.getByRole("button", { name: "Grant selected areas" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Revoke selected areas" }),
    ).toBeInTheDocument();
    // Both revokes take access away, so both wear the same danger treatment.
    expect(screen.getByRole("button", { name: "Revoke selected areas" })).toHaveClass(
      "button-danger",
    );
    expect(screen.getByRole("button", { name: "Revoke full role" })).toHaveClass(
      "button-danger",
    );
  });

  it("grants an explicit site-wide editorial role with the server intent", () => {
    const onGrant = vi.fn();

    render(
      <UsersTable
        canManage
        users={users}
        onGrant={onGrant}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    expect(screen.getByRole("radio", { name: "Entire site" })).toBeChecked();
    expect(
      screen.getByRole("radio", { name: "Named areas" }),
    ).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Grant role" }));

    expect(onGrant).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Grants the Editor role across the whole site, which can:",
      ),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Confirm grant" }));

    expect(onGrant).toHaveBeenCalledWith({
      targetUid: "target",
      role: "editor",
      siteWide: true,
    });
  });

  it("grants a site-wide contributor without section fields", () => {
    const onGrant = vi.fn();

    render(
      <UsersTable
        canManage
        users={users}
        onGrant={onGrant}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    fireEvent.change(
      screen.getByRole("combobox", {
        name: "Editorial role for target@example.com",
      }),
      { target: { value: "contributor" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Grant role" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm grant" }));

    expect(onGrant).toHaveBeenCalledWith({
      targetUid: "target",
      role: "contributor",
      siteWide: true,
    });
    expect(onGrant.mock.calls[0][0]).not.toHaveProperty("sections");
  });

  it("grants guide-only staff access with explicit site-wide intent", () => {
    const onGrant = vi.fn();

    render(
      <UsersTable
        canManage
        users={users}
        onGrant={onGrant}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    fireEvent.click(
      screen.getByRole("button", { name: "Grant Viewer" }),
    );

    expect(onGrant).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Grants the Viewer role across the whole site, which can:",
      ),
    ).toBeVisible();
    expect(
      screen.getByText("view the private Boardwalk guide"),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Confirm grant" }));

    expect(onGrant).toHaveBeenCalledWith({
      targetUid: "target",
      role: "staff",
      siteWide: true,
    });
  });

  it("revokes the full guide-only staff grant without grant intent", () => {
    const onRevoke = vi.fn();
    const staffUsers: AdminUserRecord[] = [
      {
        id: "guide-target",
        email: "guide-target@example.com",
        displayName: "Guide target",
        role: null,
        grants: [{ role: "staff" }],
      },
    ];

    render(
      <UsersTable
        canManage
        users={staffUsers}
        onGrant={vi.fn()}
        onRevoke={onRevoke}
      />,
    );

    openEditor("Manage access for guide-target@example.com");
    fireEvent.click(
      screen.getByRole("button", { name: "Revoke Viewer" }),
    );
    expect(onRevoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));

    expect(onRevoke).toHaveBeenCalledWith({
      targetUid: "guide-target",
      role: "staff",
    });
    expect(onRevoke.mock.calls[0][0]).not.toHaveProperty("siteWide");
    expect(onRevoke.mock.calls[0][0]).not.toHaveProperty("sections");
  });

  it("renders valid grants and site-wide grants while ignoring malformed grant entries", () => {
    render(
      <UsersTable
        canManage={false}
        users={[
          {
            id: "mixed",
            email: "mixed@example.com",
            displayName: "Mixed user",
            role: null,
            grants: [
              null,
              "bare grant",
              { role: "contributor", sections: ["news"] },
              { role: "editor" },
            ],
          },
        ]}
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );

    const grants = screen.getByRole("table").querySelector(".scoped-grants-cell");
    expect(grants).not.toBeNull();
    expect(within(grants as HTMLElement).getByText("Writer")).toBeVisible();
    expect(within(grants as HTMLElement).getByText("news")).toBeVisible();
    expect(within(grants as HTMLElement).getByText("Editor")).toBeVisible();
    expect(within(grants as HTMLElement).getByText("Entire site")).toBeVisible();
  });

  it("renders present empty grant sections as no sections", () => {
    render(
      <UsersTable
        canManage={false}
        users={[
          {
            id: "empty-sections",
            email: "empty-sections@example.com",
            displayName: "Empty sections user",
            role: null,
            grants: [{ role: "editor", sections: [] }],
          },
        ]}
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );

    const grants = screen.getByRole("table").querySelector(".scoped-grants-cell");
    expect(grants).not.toBeNull();
    expect(within(grants as HTMLElement).getByText("Editor")).toBeVisible();
    expect(within(grants as HTMLElement).getByText("No areas")).toBeVisible();
  });

  it("labels an empty editorial grant cell consistently", () => {
    render(
      <UsersTable
        canManage={false}
        users={[
          {
            id: "no-grants",
            email: "no-grants@example.com",
            displayName: "No grants user",
            role: null,
            grants: [],
          },
        ]}
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );

    expect(screen.getByText("No role grants")).toBeInTheDocument();
  });

  it("confirms before granting, and only then calls the grant callback", () => {
    const onGrant = vi.fn();

    render(
      <UsersTable
        canManage
        users={users}
        onGrant={onGrant}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Grant Manager" }));

    // The change is not applied on the first click; a confirmation is shown first.
    expect(onGrant).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Confirm grant" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm grant" }));

    expect(onGrant).toHaveBeenCalledWith({
      targetUid: "target",
      role: "admin",
    });
  });

  it("announces confirmation, locks the row during the request, and reports success in that row", async () => {
    let finishGrant: (() => void) | undefined;
    const onGrant = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishGrant = resolve;
        }),
    );

    render(
      <UsersTable
        canManage
        users={users}
        onGrant={onGrant}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Grant Manager" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Confirmation ready for Grant Manager access for target@example.com",
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm grant" }));
    expect(
      screen.getByRole("button", { name: "Applying the change" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Updating access for target@example.com", {
        selector: ".inline-message-title",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Close access editor" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Grant Site owner" }),
    ).toBeDisabled();

    finishGrant?.();
    expect(
      await screen.findByRole("status", {
        name: /Access updated for target@example\.com.*Role grant saved/,
      }),
    ).toHaveTextContent("Role grant saved");
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Confirm grant" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps a failed change staged for retry and reports the error in that row", async () => {
    const onGrant = vi
      .fn()
      .mockRejectedValue(new Error("Role service unavailable"));

    render(
      <UsersTable
        canManage
        users={users}
        onGrant={onGrant}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Grant Manager" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm grant" }));

    expect(
      await screen.findByRole("alert", {
        name: /Access for target@example\.com could not be updated.*Role service unavailable/,
      }),
    ).toHaveTextContent("Access for target@example.com could not be updated");
    expect(screen.getByRole("button", { name: "Confirm grant" })).toBeEnabled();
  });

  it("shows the capability impact of an admin grant, and admin never grants roles", () => {
    render(
      <UsersTable
        canManage
        users={users}
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Grant Manager" }));

    expect(
      screen.getByText("manage staff profiles"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("grant and revoke staff roles"),
    ).not.toBeInTheDocument();
  });

  it("cancels a pending change without calling any callback", () => {
    const onGrant = vi.fn();

    render(
      <UsersTable
        canManage
        users={users}
        onGrant={onGrant}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Grant Site owner" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onGrant).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Confirm grant" }),
    ).not.toBeInTheDocument();
  });

  it("confirms before granting super admin and sends no sections", () => {
    const onGrant = vi.fn();

    render(
      <UsersTable
        canManage
        users={users}
        onGrant={onGrant}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Grant Site owner" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm grant" }));

    const payload = onGrant.mock.calls[0][0];
    expect(payload).toEqual({ targetUid: "target", role: "super_admin" });
    expect(payload).not.toHaveProperty("sections");
  });

  it("confirms before revoking super admin and sends no sections", () => {
    const onRevoke = vi.fn();
    // The target has to actually hold super admin for this to be a revoke at all. The
    // server clears the top-level field only when the named role is the one on the
    // document and answers 409 otherwise, so a fixture with role: null would be asserting
    // that the dialog fires a request the server refuses.
    const superAdmins: AdminUserRecord[] = [
      { ...users[0], role: "super_admin" },
    ];

    render(
      <UsersTable
        canManage
        users={superAdmins}
        onGrant={vi.fn()}
        onRevoke={onRevoke}
      />,
    );

    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Revoke Site owner" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));

    const payload = onRevoke.mock.calls[0][0];
    expect(payload).toEqual({ targetUid: "target", role: "super_admin" });
    expect(payload).not.toHaveProperty("sections");
  });

  it("names a revoke of a top-level role the target does not hold as no change", () => {
    const onRevoke = vi.fn();
    // The row was rendered before another admin changed this account, so the open
    // confirmation is stale. The server would answer 409 "Target does not hold the
    // specified top-level role"; the dialog says so instead of offering to send it.
    render(
      <UsersTable
        canManage
        users={users}
        onGrant={vi.fn()}
        onRevoke={onRevoke}
      />,
    );

    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Revoke Site owner" }));

    expect(
      screen.queryByRole("button", { name: "Confirm revoke" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/does not hold this role/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onRevoke).not.toHaveBeenCalled();
  });

  it("describes a full-role revoke by the sections the target holds", () => {
    // The fixture holds editor only in watch, so the confirmation must not offer to remove
    // editor "across the whole site": the server removes that role's grants and no more.
    render(
      <UsersTable
        canManage
        users={users}
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Revoke full role" }));

    expect(
      screen.getByText("Removes the Editor role in watch, which can:"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/across the whole site/i),
    ).not.toBeInTheDocument();
    // The headline carries the scope too, so the confirm button cannot read wider than
    // the summary underneath it.
    expect(
      screen.getByRole("group", { name: /Revoke Editor in watch/ }),
    ).toBeInTheDocument();
  });

  it("does not revoke a scoped role with blank sections", () => {
    const onRevoke = vi.fn();

    render(
      <UsersTable
        canManage
        users={users}
        onGrant={vi.fn()}
        onRevoke={onRevoke}
      />,
    );

    openEditor();
    chooseNamedSections();
    fireEvent.click(
      screen.getByRole("button", { name: "Revoke selected areas" }),
    );

    expect(onRevoke).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Confirm revoke" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Select at least one area, or choose Entire site.",
    );
  });

  it("confirms before revoking the full role, without sections", () => {
    const onRevoke = vi.fn();

    render(
      <UsersTable
        canManage
        users={users}
        onGrant={vi.fn()}
        onRevoke={onRevoke}
      />,
    );

    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Revoke full role" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));

    const payload = onRevoke.mock.calls[0][0];
    expect(payload).toEqual({ targetUid: "target", role: "editor" });
    expect(payload).not.toHaveProperty("sections");
  });

  it("does not grant a scoped role with blank sections", () => {
    const onGrant = vi.fn();

    render(
      <UsersTable
        canManage
        users={users}
        onGrant={onGrant}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    chooseNamedSections();
    fireEvent.click(
      screen.getByRole("button", { name: "Grant selected areas" }),
    );

    expect(onGrant).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Confirm grant" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Select at least one area, or choose Entire site.",
    );
    expect(
      screen.getByLabelText("Areas for target@example.com"),
    ).toHaveAttribute("aria-invalid", "true");
  });

  it("grants only the selected areas when named scope is chosen", () => {
    const onGrant = vi.fn();

    render(
      <UsersTable
        canManage
        users={users}
        onGrant={onGrant}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    chooseNamedSections();
    chooseSection("Watch");
    chooseSection("Support");
    fireEvent.click(
      screen.getByRole("button", { name: "Grant selected areas" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm grant" }));

    expect(onGrant).toHaveBeenCalledWith({
      targetUid: "target",
      role: "editor",
      sections: ["watch", "support"],
    });
    expect(onGrant.mock.calls[0][0]).not.toHaveProperty("siteWide");
  });

  it("passes parsed sections when revoking a scoped role with listed sections", () => {
    const onRevoke = vi.fn();

    render(
      <UsersTable
        canManage
        users={users}
        onGrant={vi.fn()}
        onRevoke={onRevoke}
      />,
    );

    openEditor();
    chooseNamedSections();
    chooseSection("Watch");
    fireEvent.click(
      screen.getByRole("button", { name: "Revoke selected areas" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));

    expect(onRevoke).toHaveBeenCalledWith({
      targetUid: "target",
      role: "editor",
      sections: ["watch"],
    });
  });

  // A desk removed from the registry stays on the profile until somebody takes it back.
  // The picker has to keep offering it, or the only cleanup is revoking the whole role
  // and taking the person's still-valid desks with it.
  const staleGrantUsers: AdminUserRecord[] = [
    {
      id: "target",
      email: "target@example.com",
      displayName: "Target user",
      role: null,
      grants: [{ role: "editor", sections: ["watch", "retired-news"] }],
    },
  ];

  it("offers a retired section held by the target as a revoke-only option", () => {
    render(
      <UsersTable
        canManage
        users={staleGrantUsers}
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    chooseNamedSections();

    const offered = screen
      .getAllByRole("checkbox")
      .map((input) => (input as HTMLInputElement).value);
    // Registry desks first, then the retired one the person still holds.
    expect(offered).toEqual([
      "watch",
      "support",
      "station",
      "compliance",
      "news",
      "retired-news",
    ]);
    expect(
      screen.getByRole("checkbox", { name: "retired-news (no longer registered)" }),
    ).toBeInTheDocument();
  });

  it("revokes only the retired section, leaving the still-valid grant alone", () => {
    const onRevoke = vi.fn();

    render(
      <UsersTable
        canManage
        users={staleGrantUsers}
        onGrant={vi.fn()}
        onRevoke={onRevoke}
      />,
    );

    openEditor();
    chooseNamedSections();
    chooseSection("retired-news (no longer registered)");
    fireEvent.click(
      screen.getByRole("button", { name: "Revoke selected areas" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));

    expect(onRevoke).toHaveBeenCalledWith({
      targetUid: "target",
      role: "editor",
      sections: ["retired-news"],
    });
  });

  it("refuses to grant a retired section instead of sending one the server would reject", () => {
    const onGrant = vi.fn();

    render(
      <UsersTable
        canManage
        users={staleGrantUsers}
        onGrant={onGrant}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    chooseNamedSections();
    chooseSection("retired-news (no longer registered)");
    fireEvent.click(
      screen.getByRole("button", { name: "Grant selected areas" }),
    );

    expect(onGrant).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Confirm grant" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Areas that are no longer registered can only be revoked: retired-news.",
    );
  });

  it("keeps a mixed revoke in registry-then-retired order", () => {
    const onRevoke = vi.fn();

    render(
      <UsersTable
        canManage
        users={staleGrantUsers}
        onGrant={vi.fn()}
        onRevoke={onRevoke}
      />,
    );

    openEditor();
    chooseNamedSections();
    chooseSection("retired-news (no longer registered)");
    chooseSection("Watch");
    fireEvent.click(
      screen.getByRole("button", { name: "Revoke selected areas" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));

    expect(onRevoke).toHaveBeenCalledWith({
      targetUid: "target",
      role: "editor",
      sections: ["watch", "retired-news"],
    });
  });

  it("offers no retired option for a target whose grants are all registered", () => {
    render(
      <UsersTable
        canManage
        users={users}
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    chooseNamedSections();

    const offered = screen
      .getAllByRole("checkbox")
      .map((input) => (input as HTMLInputElement).value);
    expect(offered).toEqual(["watch", "support", "station", "compliance", "news"]);
  });

  it("blocks a super admin from revoking their own super admin and names the recovery path", () => {
    const onRevoke = vi.fn();
    const selfUsers: AdminUserRecord[] = [
      {
        id: "me",
        email: "me@example.com",
        displayName: "The only Site owner",
        role: "super_admin",
        grants: [],
      },
    ];

    render(
      <UsersTable
        canManage
        currentUserId="me"
        users={selfUsers}
        onGrant={vi.fn()}
        onRevoke={onRevoke}
      />,
    );

    openEditor("Manage access for me@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Revoke Site owner" }));

    expect(onRevoke).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Confirm revoke" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("only Site owner");
  });

  it("warns that granting admin to a super admin replaces the role and removes a capability", () => {
    const superAdminTarget: AdminUserRecord[] = [
      {
        id: "target",
        email: "target@example.com",
        displayName: "Target super admin",
        role: "super_admin",
        grants: [],
      },
    ];

    render(
      <UsersTable
        canManage
        currentUserId="operator"
        users={superAdminTarget}
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Grant Manager" }));

    expect(
      screen.getByText(/Replaces the Site owner role with Manager/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("grant and revoke staff roles"),
    ).toBeInTheDocument();
  });

  it("shows granting super admin to an admin as a pure gain without a removal notice", () => {
    const adminTarget: AdminUserRecord[] = [
      {
        id: "target",
        email: "target@example.com",
        displayName: "Target admin",
        role: "admin",
        grants: [],
      },
    ];

    render(
      <UsersTable
        canManage
        currentUserId="operator"
        users={adminTarget}
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Grant Site owner" }));

    expect(screen.queryByText(/Replaces/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No longer able to/)).not.toBeInTheDocument();
    // The full super admin list is still shown, including the capability it adds.
    expect(
      screen.getByText("grant and revoke staff roles"),
    ).toBeInTheDocument();
  });

  it("does not show replacement language for a scoped grant on a user with a top-level role", () => {
    const adminTarget: AdminUserRecord[] = [
      {
        id: "target",
        email: "target@example.com",
        displayName: "Target admin",
        role: "admin",
        grants: [],
      },
    ];

    render(
      <UsersTable
        canManage
        currentUserId="operator"
        users={adminTarget}
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    chooseNamedSections();
    chooseSection("Watch");
    fireEvent.click(
      screen.getByRole("button", { name: "Grant selected areas" }),
    );

    expect(screen.queryByText(/Replaces/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No longer able to/)).not.toBeInTheDocument();
    expect(screen.getByText("publish content")).toBeInTheDocument();
  });

  it("re-derives an open confirmation when the target's role changes live", () => {
    const before: AdminUserRecord[] = [
      {
        id: "target",
        email: "target@example.com",
        displayName: "Target user",
        role: null,
        grants: [],
      },
    ];
    const after: AdminUserRecord[] = [
      {
        id: "target",
        email: "target@example.com",
        displayName: "Target user",
        role: "super_admin",
        grants: [],
      },
    ];
    const onGrant = vi.fn();

    const { rerender } = render(
      <UsersTable
        canManage
        currentUserId="operator"
        users={before}
        onGrant={onGrant}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Grant Manager" }));

    // While the target has no top-level role, granting admin is a plain gain.
    expect(
      screen.queryByText(/Replaces the Site owner role with Manager/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("manage staff profiles"),
    ).toBeInTheDocument();

    // A live snapshot promotes the target to super admin while the dialog is open.
    rerender(
      <UsersTable
        canManage
        currentUserId="operator"
        users={after}
        onGrant={onGrant}
        onRevoke={vi.fn()}
      />,
    );

    // The open confirmation now reflects the demotion: replacement named, loss listed.
    expect(
      screen.getByText(/Replaces the Site owner role with Manager/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("grant and revoke staff roles"),
    ).toBeInTheDocument();
    expect(onGrant).not.toHaveBeenCalled();
  });

  it("reflects a no-op when a live update makes the target already hold the requested role", () => {
    const before: AdminUserRecord[] = [
      {
        id: "target",
        email: "target@example.com",
        displayName: "Target user",
        role: null,
        grants: [],
      },
    ];
    const after: AdminUserRecord[] = [
      {
        id: "target",
        email: "target@example.com",
        displayName: "Target user",
        role: "admin",
        grants: [],
      },
    ];
    const onGrant = vi.fn();

    const { rerender } = render(
      <UsersTable
        canManage
        currentUserId="operator"
        users={before}
        onGrant={onGrant}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Grant Manager" }));
    expect(
      screen.getByRole("button", { name: "Confirm grant" }),
    ).toBeInTheDocument();

    // A live snapshot grants the target admin from elsewhere; the pending grant is a no-op.
    rerender(
      <UsersTable
        canManage
        currentUserId="operator"
        users={after}
        onGrant={onGrant}
        onRevoke={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Confirm grant" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/already has this role/)).toBeInTheDocument();
    expect(onGrant).not.toHaveBeenCalled();
  });

  it("leaves an open confirmation undisturbed when an unrelated user updates", () => {
    const target: AdminUserRecord = {
      id: "target",
      email: "target@example.com",
      displayName: "Target user",
      role: null,
      grants: [],
    };
    const otherBefore: AdminUserRecord = {
      id: "other",
      email: "other@example.com",
      displayName: "Other user",
      role: "admin",
      grants: [],
    };
    const onGrant = vi.fn();

    const { rerender } = render(
      <UsersTable
        canManage
        currentUserId="operator"
        users={[target, otherBefore]}
        onGrant={onGrant}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Grant Manager" }));
    expect(
      screen.getByText("manage staff profiles"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Replaces/)).not.toBeInTheDocument();

    // An unrelated user is promoted; the target's open confirmation must not change.
    rerender(
      <UsersTable
        canManage
        currentUserId="operator"
        users={[target, { ...otherBefore, role: "super_admin" }]}
        onGrant={onGrant}
        onRevoke={vi.fn()}
      />,
    );

    expect(
      screen.getByText("manage staff profiles"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Replaces/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Confirm grant" }),
    ).toBeInTheDocument();
  });

  it("blocks a super admin from granting themselves a top-level role", () => {
    const onGrant = vi.fn();
    const selfUsers: AdminUserRecord[] = [
      {
        id: "me",
        email: "me@example.com",
        displayName: "Me",
        role: "super_admin",
        grants: [],
      },
      {
        id: "peer",
        email: "peer@example.com",
        displayName: "Peer super admin",
        role: "super_admin",
        grants: [],
      },
    ];

    render(
      <UsersTable
        canManage
        currentUserId="me"
        users={selfUsers}
        onGrant={onGrant}
        onRevoke={vi.fn()}
      />,
    );

    openEditor("Manage access for me@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Grant Manager" }));

    expect(onGrant).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Confirm grant" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "your own top-level role",
    );
  });

  it("shows legacy and explicit account states", () => {
    render(
      <UsersTable
        canManage={false}
        users={[
          users[0],
          {
            ...users[0],
            id: "inactive",
            email: "inactive@example.com",
            active: false,
            role: null,
            grants: [],
          },
        ]}
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );

    expect(screen.getByText("Active")).toBeVisible();
    expect(screen.getByText("Inactive")).toBeVisible();
  });

  it("requires explicit confirmation before deactivating another account", async () => {
    const onDeactivate = vi.fn().mockResolvedValue(undefined);

    render(
      <UsersTable
        canManage
        currentUserId="operator"
        users={users}
        onDeactivate={onDeactivate}
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Deactivate account" }));

    expect(onDeactivate).not.toHaveBeenCalled();
    expect(
      screen.getByRole("group", {
        name: "Confirm account deactivation for target@example.com",
      }),
    ).toBeVisible();
    expect(screen.getByText(/removes every CMS role and grant/i)).toBeVisible();
    expect(
      screen.getByText(/disables their sign-in and revokes active sessions/i),
    ).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "Deactivate staff account" }),
    );

    await waitFor(() => expect(onDeactivate).toHaveBeenCalledWith("target"));
    expect(
      await screen.findByRole("status", {
        name: /Account deactivated for target@example\.com/i,
      }),
    ).toHaveTextContent("CMS access and active sessions were disabled");
  });

  it("blocks self-deactivation before a request can be sent", () => {
    const onDeactivate = vi.fn();

    render(
      <UsersTable
        canManage
        currentUserId="target"
        users={users}
        onDeactivate={onDeactivate}
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Deactivate account" }));

    expect(onDeactivate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "You cannot deactivate your own staff account",
    );
    expect(
      screen.queryByRole("button", { name: "Deactivate staff account" }),
    ).not.toBeInTheDocument();
  });

  it("prevents role changes for inactive accounts and offers idempotent offboarding retry", async () => {
    const onDeactivate = vi.fn().mockResolvedValue(undefined);
    const inactiveUsers: AdminUserRecord[] = [
      {
        ...users[0],
        active: false,
        offboarding: { id: "incomplete", step: "sign_in_and_sessions" },
        role: null,
        grants: [],
      },
    ];

    render(
      <UsersTable
        canManage
        currentUserId="operator"
        users={inactiveUsers}
        onDeactivate={onDeactivate}
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    expect(
      screen.queryByRole("button", { name: "Grant Manager" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/This account is inactive/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry offboarding" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Retry session shutdown" }),
    );

    await waitFor(() => expect(onDeactivate).toHaveBeenCalledWith("target"));
  });

  it("keeps a failed deactivation confirmed and ready to retry", async () => {
    const onDeactivate = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "CMS access is disabled, but session revocation must be retried",
        ),
      );

    render(
      <UsersTable
        canManage
        currentUserId="operator"
        users={users}
        onDeactivate={onDeactivate}
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );

    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Deactivate account" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Deactivate staff account" }),
    );

    expect(
      await screen.findByRole("alert", {
        name: /Offboarding for target@example\.com needs attention/i,
      }),
    ).toHaveTextContent("session revocation must be retried");
    expect(
      screen.getByRole("button", { name: "Deactivate staff account" }),
    ).toBeEnabled();
  });
});

describe("UsersTable roster search", () => {
  it("narrows the roster by name or email and offers a way back from no matches", () => {
    render(
      <UsersTable
        users={users}
        canManage={false}
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
        onDeactivate={vi.fn()}
        currentUserId="me"
        sections={[]}
      />,
    );
    const search = screen.getByRole("searchbox", { name: "Find a staff member" });
    expect(screen.getByTestId("users-table-filter-count")).toHaveTextContent(
      `${users.length} staff member`,
    );

    fireEvent.change(search, { target: { value: "target" } });
    expect(screen.getByText("Target user")).toBeInTheDocument();
    expect(screen.getByTestId("users-table-filter-count")).toHaveTextContent(
      `1 of ${users.length} shown`,
    );

    fireEvent.change(search, { target: { value: "nobody-here" } });
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("No staff member matches")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear the search" }));
    expect(screen.getByRole("table", { name: "Staff access" })).toBeInTheDocument();
    expect(search).toHaveValue("");
  });

  it("keeps the row being edited on screen when the search would hide it", () => {
    render(
      <UsersTable
        users={users}
        canManage
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
        onDeactivate={vi.fn()}
        currentUserId="me"
        sections={[]}
      />,
    );
    openEditor();
    expect(screen.getByRole("button", { name: "Revoke full role" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Find a staff member" }), {
      target: { value: "nobody-here" },
    });

    // The open editor, with whatever confirmation or in-flight request it holds, survives.
    expect(screen.getByText("Target user")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke full role" })).toBeInTheDocument();
    expect(screen.queryByText("No staff member matches")).toBeNull();
  });
});
