import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityRoute } from "../src/routes/ActivityRoute";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";

const mocks = vi.hoisted(() => ({
  cmsListAudit: vi.fn(),
  getIdToken: vi.fn(),
}));

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ getIdToken: mocks.getIdToken }),
}));

vi.mock("../src/lib/functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/functions")>()),
  cmsListAudit: mocks.cmsListAudit,
}));

const shell: ShellData = {
  principal: { id: "admin-1", grants: [{ role: "admin" }] },
  user: {
    uid: "admin-1",
    email: "account-1@example.org",
    displayName: "Admin User",
  } as ShellData["user"],
  userDoc: { role: "admin" },
  signOut: vi.fn(),
};

const entries = [
  {
    id: "log-3",
    actorUid: "system:scheduler",
    actorEmail: null,
    action: "cms.schedule-publish-failed",
    target: "cmsPages/watch",
    before: { status: "scheduled", version: 3 },
    after: {
      status: "approved",
      version: 4,
      reason: "The page is too large to publish.",
    },
    source: "scheduler",
    at: "2026-08-13T18:30:00.000Z",
  },
  {
    id: "log-2",
    actorUid: "editor-1",
    actorEmail: "account-8@example.org",
    action: "cms.save",
    target: "cmsPages/home",
    before: { status: "draft" },
    after: { status: "in_review" },
    source: "203.0.113.9",
    at: "2026-08-12T20:15:00.000Z",
  },
  {
    id: "log-1",
    actorUid: "super-1",
    actorEmail: "account-28@example.org",
    action: "roles.grant",
    target: "users/editor-1",
    before: null,
    after: { role: "editor" },
    source: null,
    at: "2026-08-12T19:00:00.000Z",
  },
];

function renderRoute() {
  return render(
    <MemoryRouter>
      <ShellProvider value={shell}>
        <ActivityRoute />
      </ShellProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getIdToken.mockResolvedValue("id-token");
  mocks.cmsListAudit.mockResolvedValue({
    success: true,
    entries,
    nextCursor: null,
  });
});

describe("ActivityRoute", () => {
  it("loads the admin activity stream and exposes before-and-after evidence", async () => {
    renderRoute();

    expect(screen.getByRole("status")).toHaveTextContent("Loading administrative activity");
    expect(await screen.findByRole("heading", { name: "Administrative activity" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Scheduled publication failed" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Content saved" })).toBeVisible();
    // Without a resolved block the surface falls back to the stored fields: the
    // address labels the row and also appears in its support rows.
    expect(screen.getAllByText("account-8@example.org")[0]).toBeVisible();
    expect(screen.getAllByText("cmsPages/home")[0]).toBeVisible();

    const savedCard = screen.getByRole("heading", { name: "Content saved" })
      .closest<HTMLElement>(".activity-card");
    if (!savedCard) throw new Error("Expected the content-saved activity card");
    const detailsToggle = within(savedCard).getByText("View event details");
    detailsToggle.focus();
    expect(detailsToggle).toHaveFocus();
    fireEvent.click(detailsToggle);
    expect(within(savedCard).getByRole("heading", { name: "Changed fields" }))
      .toBeVisible();
    expect(within(savedCard).getByText("status")).toBeVisible();
    expect(within(savedCard).getByText("Changed")).toBeVisible();
    expect(within(savedCard).getByRole("heading", { name: "Before" })).toBeVisible();
    expect(within(savedCard).getByText(/"status": "draft"/)).toBeVisible();
    expect(within(savedCard).getByRole("heading", { name: "After" })).toBeVisible();
    expect(within(savedCard).getByText("2026-08-12T20:15:00.000Z")).toBeVisible();
    expect(within(savedCard).getByText("4:15 PM")).toHaveAttribute(
      "title",
      "2026-08-12T20:15:00.000Z",
    );
    expect(
      screen.getByRole("heading", { name: "August 13, 2026" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "August 12, 2026" }),
    ).toBeVisible();
    expect(mocks.cmsListAudit).toHaveBeenCalledWith("id-token");
  });

  it("filters loaded activity by text and action without changing the server cursor", async () => {
    renderRoute();
    await screen.findByRole("heading", { name: "Content saved" });

    fireEvent.change(screen.getByLabelText("Search activity"), {
      target: { value: "users/editor" },
    });
    expect(screen.queryByRole("heading", { name: "Content saved" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Role granted" })).toBeVisible();

    fireEvent.change(screen.getByLabelText("Action"), {
      target: { value: "cms.save" },
    });
    expect(screen.getByText("No activity matches these filters.")).toBeVisible();
    expect(mocks.cmsListAudit).toHaveBeenCalledTimes(1);
  });

  it("loads the next page and keeps existing entries", async () => {
    let resolveOlder: (value: {
      success: true;
      entries: typeof entries;
      nextCursor: null;
    }) => void = () => {};
    mocks.cmsListAudit
      .mockResolvedValueOnce({ success: true, entries: [entries[1]], nextCursor: "next-1" })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOlder = resolve;
        }),
      );

    renderRoute();
    await screen.findByRole("heading", { name: "Content saved" });
    fireEvent.click(screen.getByRole("button", { name: "Load older activity" }));

    const loading = screen.getByRole("button", { name: /^.+: Loading older activity…$/ });
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(loading.querySelector(".activity-indicator")).toBeInTheDocument();
    expect(screen.getByText("Loading older administrative activity.")).toHaveAttribute(
      "role",
      "status",
    );
    await act(async () => {
      resolveOlder({ success: true, entries: [entries[2]], nextCursor: null });
    });

    expect(await screen.findByRole("heading", { name: "Role granted" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Content saved" })).toBeVisible();
    expect(mocks.cmsListAudit).toHaveBeenNthCalledWith(2, "id-token", "next-1");
    expect(
      screen.getByRole("button", { name: "No older activity available" }),
    ).toBeDisabled();
  });

  it("discards stale pages on refresh and restores detail when reloaded", async () => {
    const freshEntry = {
      ...entries[1],
      id: "log-4",
      action: "cms.preview.request",
      at: "2026-08-14T14:00:00.000Z",
    };
    mocks.cmsListAudit
      .mockResolvedValueOnce({
        success: true,
        entries: [entries[1]],
        nextCursor: "next-1",
      })
      .mockResolvedValueOnce({
        success: true,
        entries: [entries[2]],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        success: true,
        entries: [freshEntry],
        nextCursor: "next-from-refreshed-page",
      })
      .mockResolvedValueOnce({
        success: true,
        entries: [entries[0], entries[1]],
        nextCursor: null,
      });

    renderRoute();
    const savedHeading = await screen.findByRole("heading", {
      name: "Content saved",
    });
    fireEvent.click(screen.getByRole("button", { name: "Load older activity" }));
    await screen.findByRole("heading", { name: "Role granted" });

    const savedCard = savedHeading.closest<HTMLElement>(".activity-card");
    if (!savedCard) throw new Error("Expected the content-saved activity card");
    const detail = within(savedCard).getByText("View event details").closest("details");
    if (!detail) throw new Error("Expected the event detail disclosure");
    fireEvent.click(within(savedCard).getByText("View event details"));
    fireEvent(detail, new Event("toggle"));

    const search = screen.getByLabelText("Search activity");
    fireEvent.change(search, { target: { value: "cms" } });
    search.focus();
    fireEvent.click(screen.getByRole("button", { name: "Refresh activity" }));

    expect(
      await screen.findByRole("heading", { name: "Preview requested" }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Role granted" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Content saved" })).not.toBeInTheDocument();
    expect(search).toHaveValue("cms");
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.queryByRole("heading", { name: "Role granted" })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "cms" } });

    fireEvent.click(screen.getByRole("button", { name: "Load older activity" }));
    expect(
      await screen.findByRole("heading", { name: "Scheduled publication failed" }),
    ).toBeVisible();
    expect(mocks.cmsListAudit).toHaveBeenNthCalledWith(
      4,
      "id-token",
      "next-from-refreshed-page",
    );
    expect(search).toHaveValue("cms");
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getAllByTestId("activity-event").map((event) =>
      within(event).getByRole("heading", { level: 4 }).textContent,
    )).toEqual([
      "Preview requested",
      "Scheduled publication failed",
      "Content saved",
    ]);
    const reloadedHeading = screen.getByRole("heading", { name: "Content saved" });
    const reloadedCard = reloadedHeading.closest<HTMLElement>(".activity-card");
    if (!reloadedCard) throw new Error("Expected reloaded content-saved card");
    expect(within(reloadedCard).getByText("View event details").closest("details")).toHaveAttribute("open");
    expect(
      screen.getByRole("button", { name: "No older activity available" }),
    ).toBeDisabled();
  });

  // Readable people and content names (#1038).
  const resolvedEntries = [
    {
      ...entries[1],
      resolved: {
        action: { code: "cms.save", label: "Content saved", known: true },
        actor: {
          label: "Blake Sutton",
          status: "active",
          email: "account-5@example.org",
          uid: "editor-1",
        },
        target: {
          label: "Watch",
          type: "Page",
          status: "found",
          id: "cmsPages/home",
        },
        source: { label: "Admin app", detail: "203.0.113.9" },
      },
    },
    {
      ...entries[2],
      resolved: {
        action: { code: "roles.grant", label: "Role granted", known: true },
        actor: {
          label: "Deleted account",
          status: "deleted",
          email: null,
          uid: "super-1",
        },
        target: {
          label: "Marta Ruiz",
          type: "Staff account",
          status: "deactivated",
          id: "users/editor-1",
        },
        source: { label: "Not recorded", detail: null },
      },
    },
  ];

  it("shows people and records by name, with the immutable ids kept as support detail", async () => {
    mocks.cmsListAudit.mockResolvedValue({
      success: true,
      entries: resolvedEntries,
      nextCursor: null,
    });
    renderRoute();

    const savedCard = (
      await screen.findByRole("heading", { name: "Content saved" })
    ).closest<HTMLElement>(".activity-card");
    if (!savedCard) throw new Error("Expected the content-saved activity card");

    expect(within(savedCard).getByText("Blake Sutton")).toBeVisible();
    expect(within(savedCard).getByText("Watch")).toBeVisible();
    expect(within(savedCard).getByText("Page")).toBeVisible();
    expect(within(savedCard).getByText("Admin app")).toBeVisible();
    // The raw identifiers stay reachable for support, but not as the label.
    expect(within(savedCard).getByText("cmsPages/home")).not.toBeVisible();
    fireEvent.click(within(savedCard).getByText("View event details"));
    expect(within(savedCard).getByText("cmsPages/home")).toBeVisible();
    expect(within(savedCard).getByText("editor-1")).toBeVisible();
    expect(within(savedCard).getByText("cms.save")).toBeVisible();
    expect(within(savedCard).getByText("203.0.113.9")).toBeVisible();
    // The address recorded at the time, which is what an auditor traces a
    // since-renamed or since-deleted account by.
    expect(within(savedCard).getByText("account-8@example.org")).toBeVisible();
  });

  it.each(["editor-1", "users/editor-1", "cmsStaffRecords/editor-1"])("shows an account once when its target ID is %s", async (targetId) => {
    mocks.cmsListAudit.mockResolvedValue({
      success: true,
      entries: [{
        ...resolvedEntries[1],
        target: targetId,
        resolved: {
          ...resolvedEntries[1].resolved,
          target: { ...resolvedEntries[1].resolved.target, id: targetId },
          actor: { label: "Marta Ruiz", status: "active", email: null, uid: "editor-1" },
        },
      }],
      nextCursor: null,
    });
    renderRoute();

    const card = (await screen.findByRole("heading", { name: "Role granted" }))
      .closest<HTMLElement>(".activity-card");
    if (!card) throw new Error("Expected the role-granted activity card");
    expect(within(card).getAllByText("Marta Ruiz")).toHaveLength(1);
    expect(within(card).getByText("Staff account")).toBeVisible();
    fireEvent.click(within(card).getByText("View event details"));
    for (const recordedId of within(card).getAllByText(targetId)) {
      expect(recordedId).toBeVisible();
    }
  });

  it("keeps both names when different accounts share a display name", async () => {
    mocks.cmsListAudit.mockResolvedValue({
      success: true,
      entries: [{
        ...resolvedEntries[1],
        resolved: {
          ...resolvedEntries[1].resolved,
          actor: { label: "Marta Ruiz", status: "active", email: null, uid: "super-1" },
        },
      }],
      nextCursor: null,
    });
    renderRoute();
    const card = (await screen.findByRole("heading", { name: "Role granted" })).closest<HTMLElement>(".activity-card");
    if (!card) throw new Error("Expected the role-granted activity card");
    expect(within(card).getAllByText("Marta Ruiz")).toHaveLength(2);
  });

  it("shows the staff request and plan digest of a content API change", async () => {
    const digest = "a".repeat(64);
    mocks.cmsListAudit.mockResolvedValue({
      success: true,
      entries: [{ ...entries[1], automation: { requestReference: "Slack thread from Emery", planDigest: digest } }],
      nextCursor: null,
    });
    renderRoute();

    const card = (await screen.findByText("View event details")).closest<HTMLElement>(".activity-card");
    if (!card) throw new Error("Expected the saved activity card");
    fireEvent.click(within(card).getByText("View event details"));
    expect(within(card).getByText("Staff request")).toBeVisible();
    expect(within(card).getByText("Slack thread from Emery")).toBeVisible();
    expect(within(card).getByText(digest)).toBeVisible();
  });

  it("keeps the recorded address reachable for an account that no longer exists", async () => {
    mocks.cmsListAudit.mockResolvedValue({
      success: true,
      entries: resolvedEntries,
      nextCursor: null,
    });
    renderRoute();

    const grantCard = (
      await screen.findByRole("heading", { name: "Role granted" })
    ).closest<HTMLElement>(".activity-card");
    if (!grantCard) throw new Error("Expected the role-granted activity card");
    fireEvent.click(within(grantCard).getByText("View event details"));
    expect(within(grantCard).getByText("account-28@example.org")).toBeVisible();
  });

  it("marks a deleted account and a deactivated staff target in plain language", async () => {
    mocks.cmsListAudit.mockResolvedValue({
      success: true,
      entries: resolvedEntries,
      nextCursor: null,
    });
    renderRoute();

    const grantCard = (
      await screen.findByRole("heading", { name: "Role granted" })
    ).closest<HTMLElement>(".activity-card");
    if (!grantCard) throw new Error("Expected the role-granted activity card");

    expect(within(grantCard).getByText("Deleted account")).toBeVisible();
    expect(within(grantCard).getByText("Marta Ruiz")).toBeVisible();
    expect(within(grantCard).getByText("Deactivated")).toBeVisible();
    expect(within(grantCard).getByText("Not recorded")).toBeVisible();
  });

  it("finds a record by its readable name as well as its id", async () => {
    mocks.cmsListAudit.mockResolvedValue({
      success: true,
      entries: resolvedEntries,
      nextCursor: null,
    });
    renderRoute();
    await screen.findByRole("heading", { name: "Content saved" });

    fireEvent.change(screen.getByLabelText("Search activity"), {
      target: { value: "blake sutton" },
    });
    expect(screen.getByRole("heading", { name: "Content saved" })).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Role granted" }),
    ).not.toBeInTheDocument();
  });

  it("still reads correctly against a server that does not send resolved names", async () => {
    renderRoute();
    await screen.findByRole("heading", { name: "Content saved" });
    expect(screen.getAllByText("account-8@example.org")[0]).toBeVisible();
    expect(screen.getAllByText("cmsPages/home")[0]).toBeVisible();
  });

  it("keeps a failed load recoverable", async () => {
    mocks.cmsListAudit
      .mockRejectedValueOnce(new Error("Audit service unavailable"))
      .mockResolvedValueOnce({ success: true, entries, nextCursor: null });

    renderRoute();
    expect(await screen.findByRole("alert")).toHaveTextContent("Audit service unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try loading activity again" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Content saved" })).toBeVisible();
    });
    expect(mocks.cmsListAudit).toHaveBeenCalledTimes(2);
  });
});
