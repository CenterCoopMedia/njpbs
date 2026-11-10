import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueueTab } from "../src/components/QueueTab";
import type { PublishActivitySummary } from "../src/lib/publish-activity";

const authMocks = vi.hoisted(() => ({
  getIdToken: vi.fn(async () => "id-token"),
}));

const shellMocks = vi.hoisted(() => ({
  principal: { id: "admin", grants: [{ role: "admin" }] } as {
    id: string;
    grants: Array<{ role: string; sections?: string[] }>;
  },
}));

const publishMocks = vi.hoisted(() => ({
  loadPublishActivitySummary: vi.fn(async (): Promise<PublishActivitySummary> => ({ activeCount: 0, recoveryCount: 0,
    postProofRecoveryIds: [] as string[], postProofRecoveryTruncated: false })),
  retrySiteUpdate: vi.fn(),
  getDocs: vi.fn(async () => ({ docs: [] as Array<{ id: string; data: () => Record<string, unknown> }> })),
}));
vi.mock("../src/lib/publish-activity", () => ({ loadPublishActivitySummary: publishMocks.loadPublishActivitySummary }));
vi.mock("../src/lib/site-update-retry", () => ({ retrySiteUpdate: publishMocks.retrySiteUpdate }));

const reviewMocks = vi.hoisted(() => ({
  cmsListReviewQueue: vi.fn(),
}));

const firestoreMocks = vi.hoisted(() => {
  const testDb = { name: "test-db" };
  const collection = vi.fn((database: unknown, path: string) => ({
    database,
    path,
  }));
  const orderBy = vi.fn((field: string, direction: string) => ({
    field,
    direction,
  }));
  const query = vi.fn((...parts: unknown[]) => ({ parts }));
  const unsubscribe = vi.fn();
  const onSnapshot = vi.fn();

  return {
    collection,
    onSnapshot,
    orderBy,
    query,
    testDb,
    unsubscribe,
  };
});

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ getIdToken: authMocks.getIdToken }),
}));

vi.mock("../src/routes/ShellContext", () => ({
  useShell: () => ({ principal: shellMocks.principal }),
}));

vi.mock("../src/lib/review-queue", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../src/lib/review-queue")
  >();
  return { ...original, cmsListReviewQueue: reviewMocks.cmsListReviewQueue };
});

vi.mock("firebase/firestore", () => ({
  documentId: () => "__name__",
  getDocs: publishMocks.getDocs,
  limit: (count: number) => ({ limit: count }),
  where: (field: string, op: string, value: unknown) => ({ field, op, value }),
  collection: firestoreMocks.collection,
  onSnapshot: firestoreMocks.onSnapshot,
  orderBy: firestoreMocks.orderBy,
  query: firestoreMocks.query,
}));

vi.mock("../src/lib/firebase", () => ({
  db: firestoreMocks.testDb,
  firebaseConfig: { projectId: "demo-njpbs" },
}));

function timestamp(value: string) {
  const date = new Date(value);
  return {
    date,
    firestoreValue: {
      toDate: () => date,
    },
  };
}

function renderQueue() {
  return render(
    <MemoryRouter>
      <QueueTab />
    </MemoryRouter>,
  );
}

function emptyReviewQueue() {
  reviewMocks.cmsListReviewQueue.mockResolvedValue({
    success: true,
    requests: [],
  });
}

function emptyPublishQueue() {
  firestoreMocks.onSnapshot.mockImplementation((_queueQuery, next) => {
    next({ docs: [] });
    return firestoreMocks.unsubscribe;
  });
}

const transitRequest = {
  requestId: "review-1",
  collection: "cmsPosts" as const,
  recordId: "record-1",
  contentType: "post" as const,
  title: "Transit funding vote",
  state: "in_review" as const,
  sourceVersion: 7,
  requestedByLabel: "Avery Author",
  requestedAt: "2026-08-20T16:00:00.000Z",
  assigneeLabel: "You",
  recovered: false,
};

afterEach(() => {
  vi.clearAllMocks();
  reviewMocks.cmsListReviewQueue.mockReset();
  publishMocks.loadPublishActivitySummary.mockReset();
  publishMocks.loadPublishActivitySummary.mockResolvedValue({ activeCount: 0, recoveryCount: 0, postProofRecoveryIds: [], postProofRecoveryTruncated: false });
  publishMocks.getDocs.mockReset();
  publishMocks.getDocs.mockResolvedValue({ docs: [] });
  publishMocks.retrySiteUpdate.mockReset();
  authMocks.getIdToken.mockReset();
  authMocks.getIdToken.mockResolvedValue("id-token");
  firestoreMocks.onSnapshot.mockReset();
  shellMocks.principal = { id: "admin", grants: [{ role: "admin" }] };
});

describe("QueueTab", () => {
  it.each(["success", "failed"])("bounds large %s histories and keeps older pending and failed jobs visible", async status => {
    emptyReviewQueue();
    const rows = [
      ...Array.from({ length: 1000 }, (_, index) => ({ id: `done-${index}`,
        status, triggeredAt: new Date(100_000 + index * 1000) })),
      { id: "older-pending", status: "pending", triggeredAt: new Date(1000) },
      { id: "older-failed", status: "failed", triggeredAt: new Date(2000) },
    ];
    let documentsRead = 0;
    firestoreMocks.onSnapshot.mockImplementation((request, next) => {
      let selected = rows.slice();
      for (const part of request.parts.slice(1)) {
        if (part.op === "in") selected = selected.filter(row => part.value.includes(row.status));
        if (part.field === "triggeredAt") selected.sort((a, b) => b.triggeredAt.getTime() - a.triggeredAt.getTime());
        if (part.limit) selected = selected.slice(0, part.limit);
      }
      documentsRead += selected.length;
      next({ docs: selected.map(row => ({ id: row.id, data: () => row })) });
      return firestoreMocks.unsubscribe;
    });
    renderQueue();
    expect(await screen.findByText("1 active deployment")).toBeVisible();
    expect(screen.getByText(status === "success" ? "1 deployment needing recovery" : "100+ deployments needing recovery")).toBeVisible();
    expect(documentsRead).toBe(status === "success" ? 102 : 202);
    expect(screen.getAllByRole("row")).toHaveLength(status === "success" ? 103 : 102);
  });

  it("refuses an oversized attention list instead of hiding active jobs", async () => {
    emptyReviewQueue();
    firestoreMocks.onSnapshot.mockImplementation((_request, next) => {
      next({ docs: Array.from({ length: 501 }, (_, index) => ({ id: `active-${index}`,
        data: () => ({ status: "pending" }) })) });
      return firestoreMocks.unsubscribe;
    });
    renderQueue();
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many active publication requests");
  });


  it("shows editorial requests to a scoped editor without exposing deployment activity", async () => {
    shellMocks.principal = {
      id: "editor",
      grants: [{ role: "editor", sections: ["news"] }],
    };
    reviewMocks.cmsListReviewQueue.mockResolvedValue({
      success: true,
      requests: [transitRequest],
    });

    renderQueue();

    expect(
      await screen.findByRole("heading", { name: "Editorial queue" }),
    ).toBeVisible();
    expect(screen.getByText("Transit funding vote")).toBeVisible();
    expect(screen.getByText("Avery Author")).toBeVisible();
    expect(screen.getByText("You")).toBeVisible();
    expect(
      screen.getByRole("columnheader", { name: "Waiting" }),
    ).toBeVisible();
    expect(screen.queryByText("In review")).not.toBeInTheDocument();
    expect(screen.getByText("7")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Transit funding vote" }),
    ).toHaveAttribute("href", "/content/post/record-1/edit");
    expect(screen.getByRole("link", { name: "Open draft: Transit funding vote" }))
      .toHaveAttribute("href", "/content/post/record-1/edit");
    expect(reviewMocks.cmsListReviewQueue).toHaveBeenCalledWith("id-token");
    expect(firestoreMocks.onSnapshot).not.toHaveBeenCalled();
    expect(screen.queryByText("Publish activity")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Editorial approval and deployment are different"),
    ).not.toBeInTheDocument();
  });

  it("refreshes a successful review list on demand", async () => {
    shellMocks.principal = { id: "editor", grants: [{ role: "editor" }] };
    reviewMocks.cmsListReviewQueue
      .mockResolvedValueOnce({
        success: true,
        requests: [transitRequest],
      })
      .mockResolvedValueOnce({
        success: true,
        requests: [
          transitRequest,
          {
            ...transitRequest,
            requestId: "review-2",
            recordId: "record-2",
            title: "School funding update",
            sourceVersion: 3,
            requestedByLabel: "Another staff member",
            assigneeLabel: null,
          },
        ],
      });

    renderQueue();
    expect(await screen.findByText("Transit funding vote")).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh review requests" }),
    );

    expect(await screen.findByText("School funding update")).toBeVisible();
    expect(reviewMocks.cmsListReviewQueue).toHaveBeenCalledTimes(2);
    expect(
      screen.getByText("2 requests awaiting review"),
    ).toBeVisible();
  });

  it("announces a pending review refresh and guards repeated activation", async () => {
    shellMocks.principal = { id: "editor", grants: [{ role: "editor" }] };
    reviewMocks.cmsListReviewQueue.mockImplementation(() => new Promise(() => {}));
    renderQueue();
    const refresh = await screen.findByRole("button", { name: "Refresh review requests: Refreshing review requests" });
    await waitFor(() => expect(reviewMocks.cmsListReviewQueue).toHaveBeenCalledTimes(1));
    expect(refresh).toHaveAttribute("aria-busy", "true");
    expect(refresh).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("status", { name: "Loading editorial queue" })).toBeVisible();
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    expect(reviewMocks.cmsListReviewQueue).toHaveBeenCalledTimes(1);
    expect(firestoreMocks.onSnapshot).not.toHaveBeenCalled();
  });

  it("subscribes administrators to publish activity separately", async () => {
    const triggeredAt = timestamp("2026-07-07T16:00:00.000Z");
    emptyReviewQueue();
    firestoreMocks.onSnapshot.mockImplementation((_queueQuery, next) => {
      next({
        docs: [
          {
            id: "queue-1",
            data: () => ({
              status: "success",
              triggeredBy: "publisher-1",
              triggeredByEmail: "publisher@example.com",
              changes: "Published schedule update",
              triggeredAt: triggeredAt.firestoreValue,
              completedAt: timestamp("2026-07-07T16:02:00.000Z").firestoreValue,
              transport: "serializer",
            }),
          },
          {
            id: "queue-2",
            data: () => ({
              status: "public_unconfirmed",
              triggeredBy: "publisher@example.com",
              changes: "Published homepage update",
              triggeredAt: triggeredAt.firestoreValue,
            }),
          },
          {
            id: "queue-3",
            data: () => ({
              status: "reserved",
              triggeredBy: "scheduler",
              changes: "Scheduled newsroom update",
              triggeredAt: triggeredAt.firestoreValue,
            }),
          },
        ],
      });
      return firestoreMocks.unsubscribe;
    });

    renderQueue();

    await waitFor(() => {
      expect(firestoreMocks.collection).toHaveBeenCalledWith(
        firestoreMocks.testDb,
        "cmsPublishQueue",
      );
      expect(firestoreMocks.orderBy).toHaveBeenCalledWith(
        "triggeredAt",
        "desc",
      );
    });
    expect(screen.getByText("Publish activity")).toBeVisible();
    expect(
      screen.getAllByText(triggeredAt.date.toLocaleString()),
    ).toHaveLength(3);
    // A public receipt that still needs confirmation is counted above the table.
    expect(screen.getByText("1 active deployment")).toBeVisible();
    expect(screen.getByText("1 deployment needing recovery")).toHaveClass(
      "status-badge-failed",
    );
    expect(screen.getAllByText("publisher@example.com")).toHaveLength(2);
    expect(screen.getByText("publisher-1")).not.toBeVisible();
    fireEvent.click(screen.getAllByRole("button", { name: /^Details: Publication job / })[0]);
    expect(screen.getByText("publisher-1")).toBeVisible();
    expect(screen.getByText("2026-07-07T16:02:00.000Z")).toBeVisible();
    expect(screen.getByText("serializer")).toBeVisible();
    expect(
      screen.getByText("Editorial approval and deployment are different"),
    ).toBeVisible();
  });

  it("renders no deployment timestamp when triggeredAt is missing", async () => {
    const createdAt = timestamp("2026-07-06T16:00:00.000Z");
    emptyReviewQueue();
    firestoreMocks.onSnapshot.mockImplementation((_queueQuery, next) => {
      next({
        docs: [
          {
            id: "queue-1",
            data: () => ({
              status: "success",
              triggeredBy: "publisher@example.com",
              changes: "Published schedule update",
              createdAt: createdAt.firestoreValue,
            }),
          },
        ],
      });
      return firestoreMocks.unsubscribe;
    });

    renderQueue();

    expect(await screen.findByText("Time unavailable")).toBeInTheDocument();
    expect(
      screen.queryByText(createdAt.date.toLocaleString()),
    ).not.toBeInTheDocument();
  });

  it("retries a failed review request without changing content", async () => {
    emptyPublishQueue();
    reviewMocks.cmsListReviewQueue
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ success: true, requests: [] });

    renderQueue();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Editorial queue could not be loaded",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Try loading the editorial queue again",
      }),
    );

    await waitFor(() =>
      expect(reviewMocks.cmsListReviewQueue).toHaveBeenCalledTimes(2),
    );
    expect(
      await screen.findByText(/No content is waiting for review\. Submitted drafts appear here\./),
    ).toBeVisible();
    const browseDrafts = screen.getByRole("link", { name: "Browse drafts" });
    browseDrafts.focus();
    expect(browseDrafts).toHaveFocus();
    expect(browseDrafts).toHaveAttribute(
      "href",
      "/content/library?status=draft&v=1",
    );
  });

  it("restarts a failed publish subscription for an administrator", async () => {
    emptyReviewQueue();
    const failures: Array<(error: Error) => void> = [];
    firestoreMocks.onSnapshot.mockImplementation((_queueQuery, next, error) => {
      failures.push(error);
      if (firestoreMocks.onSnapshot.mock.calls.length >= 4) next({ docs: [] });
      return firestoreMocks.unsubscribe;
    });

    renderQueue();
    firestoreMocks.unsubscribe.mockClear();

    act(() => failures[0](new Error("offline")));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Publish activity could not be loaded",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Try loading publish activity again",
      }),
    );

    await waitFor(() =>
      expect(firestoreMocks.onSnapshot).toHaveBeenCalledTimes(6),
    );
    expect(firestoreMocks.unsubscribe).toHaveBeenCalledTimes(3);
    expect(await screen.findByText("No deployment requests yet.")).toBeVisible();
  });
});


it("loads activity with 151 historical superseded failed proofs and no current recovery, without rescanning on snapshots", async () => {
  emptyReviewQueue();
  const history = Array.from({ length: 151 }, (_, index) => ({
    id: `H${String(index).padStart(19, "0")}`, status: "success", transport: "post-no-build-v1",
    postProof: { status: "failed", attempts: 4, nextAttemptAt: null }, triggeredAt: new Date(1000 + index),
  }));
  let historyChanged!: (snapshot: { docs: Array<{ id: string; data: () => typeof history[number] }> }) => void;
  firestoreMocks.onSnapshot.mockImplementation((request, next) => {
    const historical = request.parts.some((part: { field?: string }) => part.field === "triggeredAt") &&
      !request.parts.some((part: { op?: string }) => part.op === "in");
    if (historical) { historyChanged = next; next({ docs: history.slice(-100).map(row => ({ id: row.id, data: () => row })) }); }
    else next({ docs: [] });
    return firestoreMocks.unsubscribe;
  });
  renderQueue();
  expect(await screen.findByRole("table", { name: "Publish activity" })).toBeVisible();
  expect(screen.queryByText(/deployment.*needing recovery/)).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getAllByTestId("queue-item")).toHaveLength(100);
  expect(publishMocks.loadPublishActivitySummary).toHaveBeenCalledTimes(1);
  act(() => historyChanged({ docs: history.slice(-100).map(row => ({ id: row.id, data: () => row })) }));
  expect(publishMocks.loadPublishActivitySummary).toHaveBeenCalledTimes(1);
  expect(publishMocks.getDocs).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh publish activity" }));
  await waitFor(() => expect(publishMocks.loadPublishActivitySummary).toHaveBeenCalledTimes(2));
});
it("loads an older current failed proof by the bounded server-selected identity", async () => {
  emptyReviewQueue(); emptyPublishQueue();
  const id = "P".repeat(20);
  publishMocks.loadPublishActivitySummary.mockResolvedValue({ activeCount: 0, recoveryCount: 1,
    postProofRecoveryIds: [id], postProofRecoveryTruncated: false });
  publishMocks.getDocs.mockResolvedValue({ docs: [{ id, data: () => ({ status: "success", transport: "post-no-build-v1",
    postProof: { status: "failed", attempts: 4, nextAttemptAt: null }, changes: [{ title: "Older current proof" }] }) }] });
  renderQueue();
  expect(await screen.findByText("1 deployment needing recovery")).toBeVisible();
  expect(screen.getByRole("cell", { name: "Older current proof" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Check again" })).toBeVisible();
  expect(publishMocks.loadPublishActivitySummary).toHaveBeenCalledTimes(1);
  expect(publishMocks.getDocs).toHaveBeenCalledTimes(1);
});

it.each(["summary", "documents"])("keeps live activity available when the additional proof %s read fails, with a working retry", async source => {
  emptyReviewQueue();
  firestoreMocks.onSnapshot.mockImplementation((_request, next) => {
    next({ docs: [{ id: "failed-page", data: () => ({ status: "failed", transport: "page-no-build-v1",
      changes: [{ collection: "cmsPages", id: "contact", title: "Failed page request" }] }) }] });
    return firestoreMocks.unsubscribe;
  });
  const id = "P".repeat(20);
  const summary = { activeCount: 0, recoveryCount: 2, postProofRecoveryIds: [id], postProofRecoveryTruncated: false };
  if (source === "summary") publishMocks.loadPublishActivitySummary.mockRejectedValueOnce(new Error("offline"));
  else publishMocks.getDocs.mockRejectedValueOnce(new Error("offline"));
  publishMocks.loadPublishActivitySummary.mockResolvedValue(summary);
  publishMocks.getDocs.mockResolvedValue({ docs: [{ id, data: () => ({ status: "success", transport: "post-no-build-v1",
    postProof: { status: "failed", attempts: 4, nextAttemptAt: null }, changes: [{ title: "Older current proof" }] }) }] });
  renderQueue();
  expect(await screen.findByText("Some recovery requests could not be loaded")).toBeVisible();
  expect(screen.getByRole("table", { name: "Publish activity" })).toBeVisible();
  expect(screen.getByRole("cell", { name: "Failed page request" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
  expect(screen.queryByText("Publish activity could not be loaded")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry recovery checks" }));
  expect(await screen.findByRole("cell", { name: "Older current proof" })).toBeVisible();
  expect(screen.getByRole("cell", { name: "Failed page request" })).toBeVisible();
  expect(screen.queryByText("Some recovery requests could not be loaded")).not.toBeInTheDocument();
  expect(publishMocks.loadPublishActivitySummary).toHaveBeenCalledTimes(2);
});

it("shows live requests while the additional proof summary never resolves", async () => {
  emptyReviewQueue();
  publishMocks.loadPublishActivitySummary.mockImplementation(() => new Promise(() => {}));
  firestoreMocks.onSnapshot.mockImplementation((_request, next) => {
    next({ docs: [{ id: "failed-page", data: () => ({ status: "failed", transport: "page-no-build-v1",
      changes: [{ collection: "cmsPages", id: "contact", title: "Failed page request" }] }) }] });
    return firestoreMocks.unsubscribe;
  });
  renderQueue();
  expect(await screen.findByRole("table", { name: "Publish activity" })).toBeVisible();
  expect(screen.getByRole("cell", { name: "Failed page request" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Refresh publish activity" })).toBeEnabled();
  expect(screen.getByText("Checking public confirmations and site updates…")).toBeVisible();
  expect(screen.queryByRole("status", { name: "Loading publish activity" })).not.toBeInTheDocument();
  expect(publishMocks.loadPublishActivitySummary).toHaveBeenCalledTimes(1);
});

it("retries the current generic update without extra reads and clears accepted feedback on explicit refresh", async () => {
  emptyReviewQueue();
  const callbacks: Array<(snapshot: { docs: [] }) => void> = [];
  firestoreMocks.onSnapshot.mockImplementation((_request, next) => {
    callbacks.push(next); next({ docs: [] }); return firestoreMocks.unsubscribe;
  });
  const id = "G".repeat(20), message = "Retrying the accepted site update.";
  publishMocks.loadPublishActivitySummary.mockResolvedValue({ activeCount: 0, recoveryCount: 1,
    postProofRecoveryIds: [], contextRetry: { queueId: id, createdAt: "2026-11-04T12:00:00Z" } });
  publishMocks.retrySiteUpdate.mockResolvedValue({ success: true, queueId: id, status: "pending", message });
  renderQueue();
  const retry = await screen.findByRole("button", { name: "Retry site update" });
  retry.focus(); fireEvent.click(retry);
  await waitFor(() => expect(publishMocks.retrySiteUpdate).toHaveBeenCalledWith("id-token", id));
  const result = await screen.findByText(message);
  await waitFor(() => expect(result.closest("div[tabindex='-1']")).toHaveFocus());
  expect(screen.queryByRole("button", { name: "Retry site update" })).not.toBeInTheDocument();
  act(() => callbacks.forEach(next => next({ docs: [] })));
  expect(screen.queryByText("Failed")).not.toBeInTheDocument();
  expect(screen.getByText(message)).toBeVisible();
  expect(publishMocks.loadPublishActivitySummary).toHaveBeenCalledTimes(1);
  expect(publishMocks.getDocs).not.toHaveBeenCalled();
  expect(firestoreMocks.onSnapshot).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByRole("button", { name: "Refresh publish activity" }));
  expect(await screen.findByRole("button", { name: "Retry site update" })).toBeEnabled();
  expect(screen.getByText("Failed")).toBeVisible();
  expect(screen.queryByText(message)).not.toBeInTheDocument();
  expect(publishMocks.loadPublishActivitySummary).toHaveBeenCalledTimes(2);
  expect(publishMocks.getDocs).not.toHaveBeenCalled();
});

it.each(["success", "failed"])("preserves newer live %s and moved focus when the retry response arrives later", async status => {
  emptyReviewQueue();
  const callbacks: Array<(snapshot: { docs: Array<{ id: string; data: () => Record<string, unknown> }> }) => void> = [];
  firestoreMocks.onSnapshot.mockImplementation((_request, next) => {
    callbacks.push(next); next({ docs: [] }); return firestoreMocks.unsubscribe;
  });
  const id = "G".repeat(20);
  publishMocks.loadPublishActivitySummary.mockResolvedValue({ activeCount: 0, recoveryCount: 1,
    postProofRecoveryIds: [], contextRetry: { queueId: id, createdAt: null } });
  let resolve!: (value: unknown) => void;
  publishMocks.retrySiteUpdate.mockImplementation(() => new Promise(done => { resolve = done; }));
  renderQueue();
  const button = await screen.findByRole("button", { name: "Retry site update" });
  button.focus(); fireEvent.click(button);
  await waitFor(() => expect(publishMocks.retrySiteUpdate).toHaveBeenCalledTimes(1));
  act(() => callbacks[0]({ docs: [{ id, data: () => ({ status, transport: "public-context-no-build-v1",
    triggeredAt: new Date(), changes: [{ title: "Live outcome" }] }) }] }));
  const refresh = screen.getByRole("button", { name: "Refresh review requests" });
  refresh.focus();
  await act(async () => resolve({ success: true, queueId: id, status: "pending", message: "Retrying the accepted site update." }));
  expect(await screen.findByText(status === "success" ? "Completed" : "Failed")).toBeVisible();
  expect(screen.queryByText("Queued")).not.toBeInTheDocument();
  expect(refresh).toHaveFocus();
});
