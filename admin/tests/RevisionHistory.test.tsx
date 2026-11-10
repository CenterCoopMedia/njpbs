import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RevisionHistory } from "../src/components/RevisionHistory";
import type {
  GetRevisionResponse,
  ListRevisionsResponse,
  RestoreRevisionResponse,
  RevisionSummary,
} from "../src/lib/functions";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

const summary: RevisionSummary = {
  id: "revision-1",
  action: "update",
  actorUid: "editor-1",
  actorEmail: "account-8@example.org",
  at: "2026-08-12T20:15:00.000Z",
  beforeVersion: 1,
  version: 2,
  beforeStatus: "draft",
  status: "in_review",
  beforeBlockCount: 2,
  blockCount: 2,
  mediaReferenceCount: 1,
  mediaReferencesAdded: 1,
  mediaReferencesRemoved: 0,
  beforeTruncated: false,
  diffAvailable: true,
  changedFields: ["blocks", "status", "title", "version"],
  changedFieldCount: 4,
  changedFieldsTruncated: false,
};

const detail: GetRevisionResponse = {
  success: true,
  revision: {
    id: "revision-1",
    collection: "cmsPages",
    documentId: "home",
    action: "update",
    actorUid: "editor-1",
    actorEmail: "account-8@example.org",
    at: "2026-08-12T20:15:00.000Z",
    beforeTruncated: false,
    before: {
      title: "Before",
      status: "draft",
      version: 1,
      blocks: [
        {
          id: "a",
          type: "image",
          visible: true,
          data: { assetId: "old-image", alt: "Before" },
        },
        {
          id: "prose",
          type: "prose",
          visible: true,
          data: {
            content: {
              type: "doc",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Original paragraph" }] }],
            },
          },
        },
      ],
    },
    after: {
      title: "After",
      status: "in_review",
      version: 2,
      blocks: [
        {
          id: "a",
          type: "image",
          visible: false,
          data: { assetId: "new-image", alt: "After" },
        },
        {
          id: "prose",
          type: "prose",
          visible: true,
          data: {
            content: {
              type: "doc",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Updated paragraph" }] }],
            },
          },
        },
      ],
    },
  },
};

function response(entries: RevisionSummary[], nextCursor: string | null = null): ListRevisionsResponse {
  return { success: true, entries, nextCursor };
}

describe("RevisionHistory", () => {
  it.each([
    ["America/New_York", "2026-10-14T18:42:49.565Z", "Oct 14, 2026, 2:42 PM EDT"],
    ["America/Los_Angeles", "2026-10-14T18:42:49.565Z", "Oct 14, 2026, 11:42 AM PDT"],
    ["America/New_York", "2026-03-08T06:59:00.000Z", "Mar 8, 2026, 1:59 AM EST"],
    ["America/New_York", "2026-03-08T07:00:00.000Z", "Mar 8, 2026, 3:00 AM EDT"],
    ["America/Los_Angeles", "2026-03-08T09:59:00.000Z", "Mar 8, 2026, 1:59 AM PST"],
    ["America/Los_Angeles", "2026-03-08T10:00:00.000Z", "Mar 8, 2026, 3:00 AM PDT"],
    ["America/New_York", "2026-11-01T05:30:00.000Z", "Nov 1, 2026, 1:30 AM EDT"],
    ["America/New_York", "2026-11-01T06:30:00.000Z", "Nov 1, 2026, 1:30 AM EST"],
    ["America/Los_Angeles", "2026-11-01T08:30:00.000Z", "Nov 1, 2026, 1:30 AM PDT"],
    ["America/Los_Angeles", "2026-11-01T09:30:00.000Z", "Nov 1, 2026, 1:30 AM PST"],
  ])("labels revision timezones in list and detail: %s %s", async (zone, instant, label) => {
    const previous = process.env.TZ;
    process.env.TZ = zone;
    try {
      render(
        <RevisionHistory
          collection="cmsPages"
          documentId="home"
          loadRevisions={async () => response([{ ...summary, at: instant }])}
          loadRevision={async () => ({ ...detail, revision: { ...detail.revision, at: instant } })}
        />,
      );
      const version = await screen.findByText("Version 2");
      const timestamp = version.closest("li")!.querySelector("time")!;
      expect(timestamp.textContent?.replace(/\s+/g, " ")).toBe(label);
      expect(timestamp).toHaveAttribute("dateTime", instant);
      fireEvent.click(screen.getByRole("button", { name: "Inspect version 2" }));
      await screen.findByRole("heading", { name: "Changes in version 2" });
      const saved = screen.getByRole("region", { name: "Changes in version 2" }).querySelector("time")!;
      expect(saved.textContent?.replace(/\s+/g, " ")).toBe(label);
      expect(saved).toHaveAttribute("dateTime", instant);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("shows a compact summary and loads the selected full diff on demand", async () => {
    const loadRevisions = vi.fn(async () => response([summary]));
    const loadRevision = vi.fn(async () => detail);

    render(
      <RevisionHistory
        collection="cmsPages"
        documentId="home"
        loadRevision={loadRevision}
        loadRevisions={loadRevisions}
      />,
    );

    expect(await screen.findByText("Version 2")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("In review")).toBeInTheDocument();
    expect(screen.getByText("4 fields changed")).toBeInTheDocument();
    expect(screen.queryByText("Before")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Inspect version 2" }));

    expect(await screen.findByRole("heading", { name: "Changes in version 2" })).toBeInTheDocument();
    expect(loadRevision).toHaveBeenCalledWith("cmsPages", "home", "revision-1");
    expect(screen.getAllByText("Before", { selector: "dd" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("After", { selector: "dd" }).length).toBeGreaterThan(0);
    expect(screen.getByText(/Visibility changed/)).toBeInTheDocument();
    expect(screen.getByText("Original paragraph")).toBeInTheDocument();
    expect(screen.getByText("Updated paragraph")).toBeInTheDocument();
    expect(screen.getAllByText("Before:", { selector: ".revision-value-label" }).length)
      .toBeGreaterThan(0);
    expect(screen.getAllByText("After:", { selector: ".revision-value-label" }).length)
      .toBeGreaterThan(0);
    expect(screen.getByText("new-image", { selector: ".revision-token-list code" })).toBeInTheDocument();
    expect(screen.getByText("old-image", { selector: ".revision-token-list code" })).toBeInTheDocument();
  });

  it("appends an older page without replacing the visible timeline", async () => {
    const older = { ...summary, id: "revision-0", version: 1, beforeVersion: null };
    const loadRevisions = vi
      .fn()
      .mockResolvedValueOnce(response([summary], "next-page"))
      .mockResolvedValueOnce(response([older]));

    render(
      <RevisionHistory
        collection="cmsPages"
        documentId="home"
        loadRevision={vi.fn(async () => detail)}
        loadRevisions={loadRevisions}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Load older revisions" }));

    expect(await screen.findByText("Version 1")).toBeInTheDocument();
    expect(screen.getByText("Version 2")).toBeInTheDocument();
    expect(loadRevisions).toHaveBeenNthCalledWith(2, "cmsPages", "home", "next-page");
  });

  it("keeps the visible timeline when an older page fails", async () => {
    const loadRevisions = vi
      .fn()
      .mockResolvedValueOnce(response([summary], "next-page"))
      .mockRejectedValueOnce(new Error("offline"));

    render(
      <RevisionHistory
        collection="cmsPages"
        documentId="home"
        loadRevision={vi.fn(async () => detail)}
        loadRevisions={loadRevisions}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Load older revisions" }));

    expect(await screen.findByText("Older revisions could not be loaded.")).toBeInTheDocument();
    expect(screen.getByText("Version 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry older revisions" })).toBeInTheDocument();
  });

  it("does not present a bounded legacy receipt as an exact comparison", async () => {
    const partialSummary: RevisionSummary = {
      ...summary,
      beforeTruncated: true,
      diffAvailable: false,
      changedFields: [],
      changedFieldCount: null,
      changedFieldsTruncated: false,
      mediaReferencesAdded: null,
      mediaReferencesRemoved: null,
    };
    const partialDetail: GetRevisionResponse = {
      ...detail,
      revision: {
        ...detail.revision,
        beforeTruncated: true,
        before: {
          id: "home",
          status: "draft",
          version: 1,
          beforeTruncated: true,
          beforeEstimatedBytes: 990_000,
        },
      },
    };

    render(
      <RevisionHistory
        collection="cmsPages"
        documentId="home"
        loadRevision={vi.fn(async () => partialDetail)}
        loadRevisions={vi.fn(async () => response([partialSummary]))}
      />,
    );

    expect(await screen.findByText("Earlier comparison unavailable")).toBeInTheDocument();
    expect(screen.queryByText("4 fields changed")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Inspect version 2" }));
    expect(await screen.findByText("Exact comparison is unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Fields" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Blocks" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Media references" })).not.toBeInTheDocument();
  });

  it("discards an older-page response after the active record changes", async () => {
    const olderPage = deferred<ListRevisionsResponse>();
    const contactSummary = {
      ...summary,
      id: "contact-revision",
      version: 9,
      beforeVersion: 8,
    };
    const loadRevisions = vi.fn(
      async (_collection: string, documentId: string, cursor?: string) => {
        if (documentId === "home" && cursor) return olderPage.promise;
        if (documentId === "home") return response([summary], "home-next");
        return response([contactSummary], "contact-next");
      },
    );
    const props = {
      collection: "cmsPages" as const,
      loadRevision: vi.fn(async () => detail),
      loadRevisions,
    };
    const { rerender } = render(<RevisionHistory {...props} documentId="home" />);

    fireEvent.click(await screen.findByRole("button", { name: "Load older revisions" }));
    rerender(<RevisionHistory {...props} documentId="contact" />);

    expect(await screen.findByText("Version 9")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load older revisions" })).toBeEnabled();

    olderPage.resolve(response([{ ...summary, id: "home-older", version: 1 }]));
    await waitFor(() => expect(screen.queryByText("Version 1")).not.toBeInTheDocument());
    expect(screen.getByText("Version 9")).toBeInTheDocument();
  });

  it("keeps the latest inspection when an earlier request finishes last", async () => {
    const firstDetail = deferred<GetRevisionResponse>();
    const secondDetail = deferred<GetRevisionResponse>();
    const older = { ...summary, id: "revision-0", version: 1, beforeVersion: null };
    const loadRevision = vi.fn((_collection: string, _documentId: string, revisionId: string) =>
      revisionId === "revision-1" ? firstDetail.promise : secondDetail.promise,
    );

    render(
      <RevisionHistory
        collection="cmsPages"
        documentId="home"
        loadRevision={loadRevision}
        loadRevisions={vi.fn(async () => response([summary, older]))}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Inspect version 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Inspect version 1" }));

    secondDetail.resolve({
      ...detail,
      revision: {
        ...detail.revision,
        id: "revision-0",
        before: { title: "Before selected revision", version: 0 },
        after: { title: "After selected revision", version: 1 },
      },
    });
    expect(await screen.findByText("After selected revision")).toBeInTheDocument();

    firstDetail.resolve(detail);
    await waitFor(() =>
      expect(screen.queryByText("After", { selector: "dd" })).not.toBeInTheDocument(),
    );
    expect(screen.getByText("After selected revision")).toBeInTheDocument();
  });

  it("names a load failure and lets the person retry", async () => {
    const loadRevisions = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response([]));

    render(
      <RevisionHistory
        collection="cmsPosts"
        documentId="post-1"
        loadRevision={vi.fn(async () => detail)}
        loadRevisions={loadRevisions}
      />,
    );

    expect(await screen.findByText("Revision history could not be loaded.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry revision history" }));
    expect(await screen.findByText("No revisions yet")).toBeInTheDocument();
    expect(loadRevisions).toHaveBeenCalledTimes(2);
  });

  it("reloads the first page when the saved revision changes", async () => {
    const loadRevisions = vi.fn(async () => response([summary]));
    const props = {
      collection: "cmsPages" as const,
      documentId: "home",
      loadRevision: vi.fn(async () => detail),
      loadRevisions,
    };
    const { rerender } = render(<RevisionHistory {...props} refreshKey={0} />);
    await screen.findByText("Version 2");

    rerender(<RevisionHistory {...props} refreshKey={1} />);
    await waitFor(() => expect(loadRevisions).toHaveBeenCalledTimes(2));
  });

  it("confirms and restores an older version with the exact current version", async () => {
    const restoredDocument = {
      id: "home",
      title: "After",
      status: "scheduled",
      version: 5,
    };
    const restoreResponse: RestoreRevisionResponse = {
      success: true,
      collection: "cmsPages",
      id: "home",
      revisionId: "revision-5",
      sourceRevisionId: "revision-1",
      sourceVersion: 2,
      version: 5,
      document: restoredDocument,
    };
    const restoreRevision = vi.fn(async () => restoreResponse);
    const onRestored = vi.fn();

    render(
      <RevisionHistory
        collection="cmsPages"
        currentVersion={4}
        documentId="home"
        loadRevision={vi.fn(async () => detail)}
        loadRevisions={vi.fn(async () => response([summary]))}
        onRestored={onRestored}
        restoreRevision={restoreRevision}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Inspect version 2" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore version 2" }));

    expect(screen.getByText("Restore version 2?")).toBeInTheDocument();
    expect(screen.getByText(/keeps the current workflow status, schedule, approval, routes/i))
      .toBeInTheDocument();
    expect(restoreRevision).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm restore of version 2" }));

    await waitFor(() => expect(restoreRevision).toHaveBeenCalledWith(
      "cmsPages",
      "home",
      "revision-1",
      4,
    ));
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith(restoredDocument));
    // The destructive action ends with a receipt that takes focus, not with a panel that
    // empties itself.
    const receipt = await screen.findByText("Version 2 restored.");
    expect(receipt.closest(".inline-message")).toHaveAttribute("role", "status");
    expect(receipt.closest(".revision-restore-receipt")).toHaveFocus();
  });

  it("keeps restore unavailable while the editor has unsaved work", async () => {
    render(
      <RevisionHistory
        collection="cmsPages"
        currentVersion={4}
        documentId="home"
        loadRevision={vi.fn(async () => detail)}
        loadRevisions={vi.fn(async () => response([summary]))}
        onRestored={vi.fn()}
        restoreDisabledReason="Save or revert your unsaved work before restoring a version."
        restoreRevision={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Inspect version 2" }));

    expect(await screen.findByRole("button", { name: "Restore version 2" })).toBeDisabled();
    expect(screen.getByText("Save or revert your unsaved work before restoring a version."))
      .toBeInTheDocument();
  });

  it("shows the pre-migration refusal in the restore error panel", async () => {
    const message = "That revision was saved before this page's layout was migrated. Restore a revision saved after the layout migration.";
    const onRestored = vi.fn();
    render(
      <RevisionHistory
        collection="cmsPages"
        currentVersion={8}
        documentId="support"
        loadRevision={vi.fn(async () => ({ ...detail, revision: { ...detail.revision, documentId: "support" } }))}
        loadRevisions={vi.fn(async () => response([summary]))}
        onRestored={onRestored}
        restoreRevision={vi.fn(async () => { throw new Error(message); })}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Inspect version 2" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore version 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm restore of version 2" }));

    expect(await screen.findByText("Version 2 could not be restored.")).toBeInTheDocument();
    expect(screen.getByText(message).closest(".inline-message")).toHaveAttribute("role", "alert");
    expect(screen.queryByText("Version 2 restored.")).not.toBeInTheDocument();
    expect(onRestored).not.toHaveBeenCalled();
  });

  it("shows a version conflict without claiming that the restore succeeded", async () => {
    const restoreRevision = vi.fn(async () => {
      throw new Error("This document changed since you opened it. Reload it before restoring.");
    });
    const onRestored = vi.fn();

    render(
      <RevisionHistory
        collection="cmsPages"
        currentVersion={4}
        documentId="home"
        loadRevision={vi.fn(async () => detail)}
        loadRevisions={vi.fn(async () => response([summary]))}
        onRestored={onRestored}
        restoreRevision={restoreRevision}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Inspect version 2" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore version 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm restore of version 2" }));

    expect(await screen.findByText("Version 2 could not be restored.")).toBeInTheDocument();
    expect(screen.getByText(/changed since you opened/i)).toBeInTheDocument();
    expect(onRestored).not.toHaveBeenCalled();
  });
});
