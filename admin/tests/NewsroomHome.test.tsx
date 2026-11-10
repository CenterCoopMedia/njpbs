import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { NewsroomHome, type NewsroomRecord } from "../src/components/NewsroomHome";
import type { AdminStatusManifest } from "../src/lib/admin-status";
import { selectLibraryRecords, type LibrarySelection } from "../src/lib/content-library";
import { DEFAULT_CONTENT_QUERY } from "../src/lib/content-query";

const records: NewsroomRecord[] = [
  {
    id: "story-17",
    kind: "post",
    status: "in_review",
    title: "Transit funding explained",
    thumbnailUrl: "https://media.example.org/transit.jpg",
    updatedAt: "2026-07-20T14:00:00.000Z",
    updatedBy: "user-1",
    assignee: "user-1",
  },
  {
    id: "event-4",
    kind: "event",
    status: "scheduled",
    title: "Community screening",
    updatedAt: "2026-07-20T13:00:00.000Z",
  },
  {
    id: "draft-2",
    kind: "program",
    status: "draft",
    title: "Garden State Stories",
    updatedAt: "2026-07-19T12:00:00.000Z",
  },
];

function selectionFor(values: NewsroomRecord[]): LibrarySelection {
  return selectLibraryRecords(values, DEFAULT_CONTENT_QUERY, "user-1");
}

const cmsMilestone = {
  number: 6,
  title: "M4: CMS + editorial workflow",
  state: "open" as const,
  openIssues: 8,
  closedIssues: 87,
  updatedAt: "2026-08-24T15:15:06.000Z",
  url: "https://github.com/CenterCoopMedia/njpbs/milestone/6",
};
const adminMilestone = {
  number: 16,
  title: "M14: Admin interface + UX",
  state: "open" as const,
  openIssues: 7,
  closedIssues: 30,
  updatedAt: "2026-08-17T17:30:00.000Z",
  url: "https://github.com/CenterCoopMedia/njpbs/milestone/16",
};

const statusManifest = (refreshAfter: string): AdminStatusManifest => ({
  schemaVersion: 2,
  status: "current",
  environment: "Production",
  generatedAt: "2026-08-17T18:00:00.000Z",
  refreshAfter,
  build: {
    revision: "d805028221a24448055bf0adcce344d1921547b7",
    builtAt: "2026-08-17T18:00:00.000Z",
  },
  milestone: adminMilestone,
  milestones: [cmsMilestone, adminMilestone],
});

describe("NewsroomHome", () => {
  it("retries recent work without rereading the successful review count", async () => {
    const loadRecords = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(selectionFor(records));
    const loadReviewRequestCount = vi.fn().mockResolvedValue(3);
    render(<MemoryRouter><NewsroomHome currentUserId="user-1" canBrowsePages canBrowseRecords canCreate
      canViewEditorialQueue canViewPublishActivity={false}
      loadRecords={loadRecords} loadReviewRequestCount={loadReviewRequestCount} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Try loading newsroom work again" }));
    await waitFor(() => expect(loadRecords).toHaveBeenCalledTimes(2));
    expect(loadReviewRequestCount).toHaveBeenCalledTimes(1);
  });

  it("splits build and milestone facts without loading the shared status twice", async () => {
    const loadAdminStatus = vi.fn().mockResolvedValue(
      statusManifest(new Date(Date.now() + 60_000).toISOString()),
    );
    render(
      <MemoryRouter>
        <NewsroomHome
          canBrowsePages
          canBrowseRecords
          canCreate
          canViewEditorialQueue={false}
          canViewPublishActivity={false}
          currentUserId="user-1"
          loadAdminStatus={loadAdminStatus}
          loadHomeSettings={vi.fn().mockResolvedValue({
            heading: "Preparing the newsroom publishing workflow",
            milestoneNumber: 6,
          })}
          loadRecords={vi.fn().mockResolvedValue(selectionFor(records))}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText("Build and publication details", { selector: "summary span" }));
    expect(
      screen.getByText("Build and milestone", { selector: ".eyebrow" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("heading", {
        name: "Preparing the newsroom publishing workflow",
      }),
    ).toBeVisible();
    const buildStatus = await screen.findByRole("region", { name: "Build status" });
    const milestoneStatus = screen.getByRole("region", { name: "Milestone status" });
    expect(within(buildStatus).getByText("Current")).toBeVisible();
    expect(within(buildStatus).getByText("Production")).toBeVisible();
    expect(within(buildStatus).getByText("d805028")).toBeVisible();
    expect(within(milestoneStatus).getByText("87 of 95 closed")).toBeVisible();
    expect(within(milestoneStatus).getByRole("link", {
      name: "M4: CMS + editorial workflow milestone details",
    }))
      .toHaveAttribute("href", "https://github.com/CenterCoopMedia/njpbs/milestone/6");
    expect(buildStatus).toHaveAttribute("data-status", "current");
    expect(milestoneStatus).toHaveAttribute("data-status", "current");
    expect(loadAdminStatus).toHaveBeenCalledTimes(1);
  });


  it("reports loading, stale, unavailable, and failed status without a false healthy state", async () => {
    const pending = new Promise<AdminStatusManifest>(() => {});
    const loadingView = render(
      <MemoryRouter>
        <NewsroomHome
          canBrowsePages={false}
          canBrowseRecords={false}
          canCreate={false}
          canViewEditorialQueue={false}
          canViewPublishActivity={false}
          currentUserId="user-1"
          loadAdminStatus={() => pending}
          loadRecords={vi.fn().mockResolvedValue(selectionFor([]))}
        />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole("status").some((status) =>
      status.textContent?.includes("Loading build status"),
    )).toBe(true);
    loadingView.unmount();

    const staleView = render(
      <MemoryRouter>
        <NewsroomHome
          canBrowsePages={false}
          canBrowseRecords={false}
          canCreate={false}
          canViewEditorialQueue={false}
          canViewPublishActivity={false}
          currentUserId="user-1"
          loadAdminStatus={vi.fn().mockResolvedValue(
            statusManifest(new Date(Date.now() - 60_000).toISOString()),
          )}
          loadRecords={vi.fn().mockResolvedValue(selectionFor([]))}
        />
      </MemoryRouter>,
    );
    expect(await screen.findAllByText("Stale")).toHaveLength(2);
    expect(screen.getByRole("region", { name: "Build status" }))
      .toHaveAttribute("data-status", "stale");
    staleView.unmount();

    const unavailableView = render(
      <MemoryRouter>
        <NewsroomHome
          canBrowsePages={false}
          canBrowseRecords={false}
          canCreate={false}
          canViewEditorialQueue={false}
          canViewPublishActivity={false}
          currentUserId="user-1"
          loadAdminStatus={vi.fn().mockResolvedValue({
            schemaVersion: 2,
            status: "unavailable",
            environment: "Local",
            generatedAt: new Date().toISOString(),
            refreshAfter: new Date().toISOString(),
            build: null,
            milestone: null,
            milestones: null,
          })}
          loadRecords={vi.fn().mockResolvedValue(selectionFor([]))}
        />
      </MemoryRouter>,
    );
    expect(await screen.findAllByText("Unavailable")).toHaveLength(2);
    expect(screen.getAllByText("Status is not available in this environment.")).toHaveLength(2);
    expect(screen.getByRole("region", { name: "Build status" }))
      .toHaveAttribute("data-status", "unavailable");
    expect(screen.getByRole("region", { name: "Milestone status" }))
      .toHaveAttribute("data-status", "unavailable");
    unavailableView.unmount();

    render(
      <MemoryRouter>
        <NewsroomHome
          canBrowsePages={false}
          canBrowseRecords={false}
          canCreate={false}
          canViewEditorialQueue={false}
          canViewPublishActivity={false}
          currentUserId="user-1"
          loadAdminStatus={vi.fn().mockRejectedValue(new Error("private failure"))}
          loadRecords={vi.fn().mockResolvedValue(selectionFor([]))}
        />
      </MemoryRouter>,
    );
    expect(await screen.findAllByText("Failed")).toHaveLength(2);
    expect(screen.getAllByText("Status could not be loaded.")).toHaveLength(2);
    expect(screen.queryByText("private failure")).not.toBeInTheDocument();
  });

  it("retries a failed status request from a keyboard-operable button", async () => {
    const loadAdminStatus = vi
      .fn<() => Promise<AdminStatusManifest>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(statusManifest(new Date(Date.now() + 60_000).toISOString()));

    render(
      <MemoryRouter>
        <NewsroomHome
          canBrowsePages={false}
          canBrowseRecords={false}
          canCreate={false}
          canViewEditorialQueue={false}
          canViewPublishActivity={false}
          currentUserId="user-1"
          loadAdminStatus={loadAdminStatus}
          loadRecords={vi.fn().mockResolvedValue(selectionFor([]))}
        />
      </MemoryRouter>,
    );

    const retry = await screen.findByRole("button", { name: "Retry build status" });
    retry.focus();
    fireEvent.keyDown(retry, { key: "Enter" });
    fireEvent.click(retry);
    await waitFor(() => expect(loadAdminStatus).toHaveBeenCalledTimes(2));
    expect(await screen.findAllByText("Current")).toHaveLength(2);
  });

  it("names a stored record of a retired kind and refuses to link it to an editor", async () => {
    // Article was retired (#1039), so no editor route resolves for one. A record
    // stored before that decision still has to appear in recent work -- hiding it
    // would make it unfindable rather than retired -- but it must read as retired
    // and must not offer a link into a form that no longer exists.
    render(
      <MemoryRouter>
        <NewsroomHome
          canBrowsePages
          canBrowseRecords
          canCreate
          canViewEditorialQueue={false}
          canViewPublishActivity={false}
          currentUserId="user-1"
          loadRecords={vi.fn().mockResolvedValue(selectionFor([
            {
              id: "legacy-1",
              kind: "article",
              status: "draft",
              title: "A story saved before the retirement",
              updatedAt: "2026-07-20T14:00:00.000Z",
            },
          ]))}
        />
      </MemoryRouter>,
    );

    const activity = await screen.findByRole("region", { name: "Recent work" });
    expect(
      within(activity).getByText("A story saved before the retirement"),
    ).toBeVisible();
    expect(
      within(activity).queryByRole("link", {
        name: "A story saved before the retirement",
      }),
    ).not.toBeInTheDocument();
    expect(within(activity).getByText(/Article \(retired\)/)).toBeVisible();
  });

  it("turns stored editorial records into a resume-work landing page", async () => {
    render(
      <MemoryRouter>
        <NewsroomHome
          canBrowsePages
          canEditHomepage
          canBrowseRecords
          canCreate
          canUseMediaLibrary
          canViewActivity
          canViewEditorialQueue
          canViewPublishActivity
          currentUserId="user-1"
          loadRecords={vi.fn().mockResolvedValue(selectionFor(records))}
          loadPublishActivity={vi.fn().mockResolvedValue({ activeCount: 1, recoveryCount: 2 })}
          loadReviewRequestCount={vi.fn().mockResolvedValue(1)}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "New post" })).toBeVisible();
    fireEvent.click(screen.getByText("Build and publication details", { selector: "summary span" }));
    expect(await screen.findByRole("region", { name: "Build status" })).toBeVisible();
    expect(
      await screen.findByRole("heading", {
        name: "Admin interface and user experience",
      }),
    ).toBeVisible();
    const activity = screen.getByRole("region", { name: "Recent work" });
    expect(activity.querySelector("img")).toHaveAttribute(
      "src",
      "https://media.example.org/transit.jpg",
    );
    expect(activity.querySelector("img")).toHaveAttribute("alt", "");
    expect(within(activity).getByRole("link", { name: "Transit funding explained" }))
      .toHaveAttribute("href", "/content/post/story-17/edit");
    expect(within(activity).getByText(/Updated by you/)).toBeVisible();
    expect(screen.getByTestId("draft-count")).toHaveTextContent("1");
    expect(screen.getByTestId("review-count")).toHaveTextContent("1");
    expect(screen.getByTestId("scheduled-count")).toHaveTextContent("1");
    expect(screen.getByTestId("failed-publish-count")).toHaveTextContent("2");
    expect(screen.getByTestId("failed-publish-count").closest(".newsroom-status-card"))
      .toHaveClass("newsroom-status-card-danger");
    expect(screen.getByRole("link", { name: "My recent edits (1)" })).toHaveAttribute(
      "href",
      "/content/library?owner=me&v=1",
    );
    expect(screen.getByRole("link", { name: "Assigned to me (1)" })).toHaveAttribute(
      "href",
      "/content/library?assigned=me&v=1",
    );
    expect(screen.getByRole("link", { name: "Drafts, 1. Open drafts" })).toHaveAttribute(
      "href",
      "/content/library?status=draft&v=1",
    );
    expect(
      screen.getByRole("link", {
        name: "In review, 1. Open review queue",
      }),
    ).toHaveAttribute("href", "/publish-queue");
    expect(screen.getByRole("link", { name: "Scheduled, 1. View scheduled work" })).toHaveAttribute(
      "href",
      "/content/library?status=scheduled&sort=publishAt&dir=asc&v=1",
    );
    expect(screen.getByRole("link", { name: "Publish recovery, 2. Check publish activity" })).toHaveAttribute(
      "href",
      "/publish-queue",
    );
    expect(screen.getByRole("link", { name: "New post" })).toHaveAttribute(
      "href",
      "/content/post/+",
    );
    expect(screen.getByRole("link", { name: "Edit homepage" })).toHaveAttribute(
      "href",
      "/content/pages/home/edit",
    );
    // The queue is the In review card and Browse all heads the Recent work panel, so the
    // secondary panels do not repeat either.
    expect(screen.queryByRole("link", { name: "Open editorial queue" })).toBeNull();
    expect(screen.getByRole("link", { name: "Browse all" })).toHaveAttribute(
      "href",
      "/content/library",
    );
    expect(screen.getByRole("link", { name: "Update your profile" })).toHaveAttribute(
      "href",
      "/account/profile",
    );
    expect(screen.getByRole("link", { name: "Find an image" })).toHaveAttribute(
      "href",
      "/media",
    );
    expect(screen.getByRole("link", { name: "Recent activity" })).toHaveAttribute(
      "href",
      "/activity",
    );
    expect(screen.getByText("Save is not publish")).toBeVisible();
    expect(screen.queryByText(/assigned permissions/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/billing safeguard/i)).not.toBeInTheDocument();
  });

  // The card links reviewers to the editorial queue, which projects requests from both cmsPages
  // and cmsPosts. The record list behind every other count reads cmsPosts only, so counting it
  // here would report zero beside a queue holding page requests.
  it("counts in-review work from the editorial queue the card opens", async () => {
    const loadReviewRequestCount = vi.fn().mockResolvedValue(3);
    render(
      <MemoryRouter>
        <NewsroomHome
          canBrowsePages
          canBrowseRecords
          canCreate
          canViewEditorialQueue
          canViewPublishActivity={false}
          currentUserId="user-1"
          loadRecords={vi.fn().mockResolvedValue(selectionFor(records))}
          loadReviewRequestCount={loadReviewRequestCount}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("link", {
        name: "In review, 3. Open review queue",
      }),
    ).toHaveAttribute("href", "/publish-queue");
    expect(screen.getByTestId("review-count")).toHaveTextContent("3");
    // The record-derived counts beside it are unaffected.
    expect(screen.getByTestId("draft-count")).toHaveTextContent("1");
    expect(loadReviewRequestCount).toHaveBeenCalledTimes(1);
  });

  it("reports the review count as unavailable when the editorial queue cannot be read", async () => {
    render(
      <MemoryRouter>
        <NewsroomHome
          canBrowsePages
          canBrowseRecords
          canCreate
          canViewEditorialQueue
          canViewPublishActivity={false}
          currentUserId="user-1"
          loadRecords={vi.fn().mockResolvedValue(selectionFor(records))}
          loadReviewRequestCount={vi.fn().mockRejectedValue(new Error("offline"))}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("link", {
        name: "In review, unavailable. Open review queue",
      }),
    ).toBeVisible();
    // A stale record-only number beside the queue link would be worse than an honest dash.
    expect(screen.getByTestId("review-count")).toHaveTextContent("—");
  });

  it("counts records, and reads no queue, for staff who cannot open the editorial queue", async () => {
    const loadReviewRequestCount = vi.fn().mockResolvedValue(3);
    render(
      <MemoryRouter>
        <NewsroomHome
          canBrowsePages
          canBrowseRecords
          canCreate
          canViewEditorialQueue={false}
          canViewPublishActivity={false}
          currentUserId="user-1"
          loadRecords={vi.fn().mockResolvedValue(selectionFor(records))}
          loadReviewRequestCount={loadReviewRequestCount}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("link", {
        name: "In review, 1. Open the review filter",
      }),
    ).toHaveAttribute("href", "/content/library?status=in_review&v=1");
    expect(loadReviewRequestCount).not.toHaveBeenCalled();
  });

  it("keeps record work usable when publish recovery status cannot load", async () => {
    const loadPublishActivity = vi
      .fn()
      .mockRejectedValueOnce(new Error("queue offline"))
      .mockResolvedValueOnce({ activeCount: 0, recoveryCount: 1 });
    render(
      <MemoryRouter>
        <NewsroomHome
          canBrowsePages
          canBrowseRecords
          canCreate
          canViewEditorialQueue
          canViewPublishActivity
          currentUserId="user-1"
          loadRecords={vi.fn().mockResolvedValue(selectionFor(records))}
          loadPublishActivity={loadPublishActivity}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("link", { name: "Transit funding explained" })).toBeVisible();
    expect(await screen.findByText("Publish recovery status is unavailable.")).toBeVisible();
    expect(screen.getByTestId("failed-publish-count")).toHaveTextContent("—");
    expect(screen.getByRole("link", {
      name: "Publish recovery, unavailable. Publish recovery status is unavailable.",
    })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry publish status" }));
    await waitFor(() => expect(loadPublishActivity).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("failed-publish-count")).toHaveTextContent("1");
  });

  it("distinguishes an empty newsroom from a failed load and retries the failure", async () => {
    const loadRecords = vi
      .fn<() => Promise<LibrarySelection>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(selectionFor([]));

    render(
      <MemoryRouter>
        <NewsroomHome
          canBrowsePages
          canBrowseRecords
          canCreate
          canViewEditorialQueue={false}
          canViewPublishActivity={false}
          currentUserId="user-1"
          loadRecords={loadRecords}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Newsroom work could not be loaded",
    );
    expect(screen.getByTestId("draft-count")).toHaveTextContent("—");
    expect(screen.getByRole("link", { name: "Drafts, unavailable. Open drafts" }))
      .toHaveTextContent("—");
    expect(screen.getByRole("link", { name: "My recent edits (unavailable)" })).toHaveTextContent(
      "My recent edits—",
    );
    expect(screen.getByRole("link", { name: "Assigned to me (unavailable)" })).toHaveTextContent(
      "Assigned to me—",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try loading newsroom work again" }));
    await waitFor(() => expect(loadRecords).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No editorial records yet")).toBeVisible();
  });

  it("does not request unsectioned records for an account with only scoped access", async () => {
    const loadRecords = vi.fn<() => Promise<LibrarySelection>>().mockResolvedValue(selectionFor(records));
    const loadAdminStatus = vi.fn().mockResolvedValue(
      statusManifest(new Date(Date.now() + 60_000).toISOString()),
    );

    render(
      <MemoryRouter>
        <NewsroomHome
          canBrowsePages={false}
          canBrowseRecords={false}
          canCreate={false}
          canViewEditorialQueue={false}
          canViewPublishActivity={false}
          currentUserId="contributor-1"
          loadAdminStatus={loadAdminStatus}
          loadRecords={loadRecords}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Newsroom work is outside your current scope")).toBeVisible();
    expect(screen.getByText(/requires a site-wide content grant/i)).toBeVisible();
    expect(loadRecords).not.toHaveBeenCalled();
    expect(loadAdminStatus).toHaveBeenCalledTimes(1);
    expect(await screen.findAllByText("Current")).toHaveLength(2);
    expect(screen.queryByRole("region", { name: "Recent work" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "New post" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit homepage" })).not.toBeInTheDocument();
  });
});

describe("NewsroomHome progress and recovery", () => {
  it("shows motion while counts load and a dash only once they cannot be read", async () => {
    let resolveRecords: (selection: LibrarySelection) => void = () => {};
    const loadRecords = vi.fn(
      () => new Promise<LibrarySelection>((resolve) => { resolveRecords = resolve; }),
    );
    render(
      <MemoryRouter>
        <NewsroomHome
          canBrowsePages
          canBrowseRecords
          canCreate
          canViewEditorialQueue={false}
          canViewPublishActivity={false}
          currentUserId="user-1"
          loadRecords={loadRecords}
        />
      </MemoryRouter>,
    );

    const draftCount = screen.getByTestId("draft-count");
    expect(draftCount.querySelector(".activity-indicator")).not.toBeNull();
    expect(draftCount).not.toHaveTextContent("—");
    expect(screen.getByRole("link", { name: "Drafts, loading. Open drafts" })).toBeVisible();

    await act(async () => resolveRecords(selectionFor(records)));
    expect(screen.getByTestId("draft-count")).toHaveTextContent("1");
    expect(draftCount.querySelector(".activity-indicator")).toBeNull();
  });

  it("lets the review card ask for its count again when the queue could not be read", async () => {
    const loadReviewRequestCount = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(3);
    const loadRecords = vi.fn().mockResolvedValue(selectionFor(records));
    render(
      <MemoryRouter>
        <NewsroomHome
          canBrowsePages
          canBrowseRecords
          canCreate
          canViewEditorialQueue
          canViewPublishActivity={false}
          currentUserId="user-1"
          loadRecords={loadRecords}
          loadReviewRequestCount={loadReviewRequestCount}
        />
      </MemoryRouter>,
    );

    await screen.findByRole("link", { name: "Transit funding explained" });
    fireEvent.click(await screen.findByRole("button", { name: "Retry review count" }));
    await waitFor(() => expect(loadReviewRequestCount).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("review-count")).toHaveTextContent("3");
    expect(screen.queryByRole("button", { name: "Retry review count" })).toBeNull();
    // The retry is scoped to the count that failed: the newsroom selection that loaded fine is
    // neither requested again nor put back into loading.
    expect(loadRecords).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Transit funding explained" })).toBeVisible();
  });

  it("offers the first post from the empty state when the account can create", async () => {
    render(
      <MemoryRouter>
        <NewsroomHome
          canBrowsePages
          canBrowseRecords
          canCreate
          canViewEditorialQueue={false}
          canViewPublishActivity={false}
          currentUserId="user-1"
          loadRecords={vi.fn().mockResolvedValue(selectionFor([]))}
        />
      </MemoryRouter>,
    );

    const empty = (await screen.findByText("No editorial records yet")).closest(".empty-state");
    if (!(empty instanceof HTMLElement)) throw new Error("Missing empty state");
    expect(within(empty).getByRole("link", { name: "New post" })).toHaveAttribute(
      "href",
      "/content/post/+",
    );
  });

  it("keeps the empty state a plain statement for accounts that cannot create", async () => {
    render(
      <MemoryRouter>
        <NewsroomHome
          canBrowsePages={false}
          canBrowseRecords
          canCreate={false}
          canViewEditorialQueue={false}
          canViewPublishActivity={false}
          currentUserId="user-1"
          loadRecords={vi.fn().mockResolvedValue(selectionFor([]))}
        />
      </MemoryRouter>,
    );

    const empty = (await screen.findByText("No editorial records yet")).closest(".empty-state");
    if (!(empty instanceof HTMLElement)) throw new Error("Missing empty state");
    expect(within(empty).queryByRole("link")).toBeNull();
  });
});


it.each([true, false])("retains settled record proof in recent work with visible=%s", async visible => {
  const { PublicContentStatusProvider } = await import("../src/context/PublicContentStatusContext");
  const functions = await import("../src/lib/functions");
  const metadata = vi.spyOn(functions, "cmsGetPublicationStatus");
  render(<MemoryRouter><PublicContentStatusProvider getIdToken={async () => "test-token"}>
    <NewsroomHome currentUserId="user-1" canBrowsePages canBrowseRecords canCreate canViewEditorialQueue={false}
      canViewPublishActivity={false} loadRecords={async () => selectionFor([{ ...records[2], status: "published",
        version: 10, contentVersion: 10, publishedSourceVersion: 10, publishedContentVersion: 10,
        liveSourceVersion: visible ? 10 : undefined, publicUpdatePending: false, publicBuildQueueId: null,
        recordPublication: { queueId: "A".repeat(20), sourceVersion: 10, withdrawal: !visible, status: "success", missingConsumers: [] } }])} />
  </PublicContentStatusProvider></MemoryRouter>);
  expect(await screen.findByText(visible ? "Version 10 live" : "Not live")).toBeVisible();
  expect(metadata).not.toHaveBeenCalled();
  metadata.mockRestore();
});
