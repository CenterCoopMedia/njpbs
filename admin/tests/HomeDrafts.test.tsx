import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { HomeDrafts, MY_DRAFTS_QUERY } from "../src/components/HomeDrafts";
import { selectLibraryRecords, type LibrarySelection } from "../src/lib/content-library";
import type { ContentRecordSummary } from "../src/lib/content-records";
import { contentLibraryPath, editRecordPath } from "../src/lib/routes";

const NOW = Date.parse("2026-11-27T15:00:00.000Z");

const drafts: ContentRecordSummary[] = [
  { id: "old", kind: "post", status: "draft", title: "School budget vote", version: 4,
    updatedAt: "2026-10-12T15:00:00.000Z", updatedBy: "user-1" },
  { id: "edge", kind: "post", status: "draft", title: "Shore erosion", version: 2,
    updatedAt: "2026-10-28T15:00:00.000Z", updatedBy: "user-1" },
  { id: "recent", kind: "post", status: "draft", title: "Transit fares", version: 7,
    updatedAt: "2026-11-26T14:00:00.000Z", updatedBy: "user-1" },
];
const revisedLivePost: ContentRecordSummary = { id: "live", kind: "post", status: "draft", title: "Election night results",
  version: 9, publishedSourceVersion: 6, liveSourceVersion: 6, updatedAt: "2026-09-01T15:00:00.000Z", updatedBy: "user-1" };
const withdrawnPost: ContentRecordSummary = { id: "withdrawn", kind: "post", status: "draft", title: "Storm recovery fund",
  version: 5, publishedSourceVersion: 3, updatedAt: "2026-09-02T15:00:00.000Z", updatedBy: "user-1" };

function selection(records: ContentRecordSummary[]): LibrarySelection {
  return selectLibraryRecords(records, MY_DRAFTS_QUERY, "user-1");
}

function renderDrafts(props: Partial<Parameters<typeof HomeDrafts>[0]> = {}) {
  return render(
    <MemoryRouter>
      <HomeDrafts loadDrafts={vi.fn(async () => selection(drafts))} now={() => NOW} {...props} />
    </MemoryRouter>,
  );
}

describe("My drafts on Home", () => {
  it("lists the person's drafts oldest first with their edit age and opens each one", async () => {
    renderDrafts();
    const rows = await screen.findAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "School budget vote" + "Edited 46 days ago",
      "Shore erosion" + "Edited 30 days ago",
      "Transit fares" + "Edited yesterday",
    ]);
    expect(within(rows[0]).getByRole("link", { name: "School budget vote" })).toHaveAttribute("href", editRecordPath("post", "old"));
    expect(screen.getByRole("link", { name: "View all 3" })).toHaveAttribute("href", contentLibraryPath(MY_DRAFTS_QUERY));
    expect(screen.queryByRole("button", { name: /Archive/ })).not.toBeInTheDocument();
  });

  it("offers Archive for drafts edited 30 or more days ago and reloads after archiving", async () => {
    const archiveDraft = vi.fn(async () => ({ id: "old", status: "archived" as const, version: 5 }));
    const loadDrafts = vi.fn()
      .mockResolvedValueOnce(selection(drafts))
      .mockResolvedValueOnce(selection(drafts.slice(1)));
    const onArchived = vi.fn();
    renderDrafts({ archiveDraft, loadDrafts, onArchived });

    await screen.findByRole("button", { name: "Archive School budget vote" });
    expect(screen.getByRole("button", { name: "Archive Shore erosion" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive Transit fares" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Archive School budget vote" }));
    await waitFor(() => expect(screen.queryByText("School budget vote")).not.toBeInTheDocument());
    expect(archiveDraft).toHaveBeenCalledWith(expect.objectContaining({ id: "old", version: 4 }));
    expect(loadDrafts).toHaveBeenCalledTimes(2);
    expect(onArchived).toHaveBeenCalledTimes(1);
  });

  it("leaves Archive to Posts for an old draft whose earlier version is still live", async () => {
    renderDrafts({ archiveDraft: vi.fn(), loadDrafts: vi.fn(async () => selection([revisedLivePost, withdrawnPost, ...drafts])) });
    expect(await screen.findByRole("link", { name: "Election night results" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive Election night results" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive Storm recovery fund" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive School budget vote" })).toBeInTheDocument();
  });

  it("reports a withdrawal that failed after the archive", async () => {
    const archiveDraft = vi.fn(async () => ({ id: "old", status: "archived" as const, version: 5,
      publication: { status: "failed" as const, queueId: null } }));
    const onArchived = vi.fn();
    renderDrafts({ archiveDraft, onArchived });
    fireEvent.click(await screen.findByRole("button", { name: "Archive School budget vote" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The draft was archived, but its public copy was not withdrawn. Open the record in Recycle bin and retry removal.");
    expect(onArchived).toHaveBeenCalledTimes(1);
  });

  it("says when the public copy is still being removed", async () => {
    const archiveDraft = vi.fn(async () => ({ id: "old", status: "archived" as const, version: 5,
      publication: { status: "queued" as const, queueId: "queue-1", warnings: ["The homepage updates after the next build."] } }));
    renderDrafts({ archiveDraft });
    fireEvent.click(await screen.findByRole("button", { name: "Archive School budget vote" }));
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("Its public copy stays on the site until the removal finishes.");
    expect(notice).toHaveTextContent("The homepage updates after the next build.");
    expect(screen.getByText('"School budget vote" was archived')).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reloads when the archive response is lost", async () => {
    const archiveDraft = vi.fn(async () => { throw new Error("network down"); });
    const loadDrafts = vi.fn()
      .mockResolvedValueOnce(selection(drafts))
      .mockResolvedValueOnce(selection(drafts.slice(1)));
    const onArchived = vi.fn();
    renderDrafts({ archiveDraft, loadDrafts, onArchived });
    fireEvent.click(await screen.findByRole("button", { name: "Archive School budget vote" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Boardwalk could not confirm the archive.");
    await waitFor(() => expect(screen.queryByRole("link", { name: "School budget vote" })).not.toBeInTheDocument());
    expect(loadDrafts).toHaveBeenCalledTimes(2);
    expect(onArchived).toHaveBeenCalledTimes(1);
  });

  it("keeps a draft that changed since Home loaded and says why", async () => {
    const archiveDraft = vi.fn(async () => ({ id: "old", status: "conflict" as const }));
    const onArchived = vi.fn();
    renderDrafts({ archiveDraft, onArchived });

    fireEvent.click(await screen.findByRole("button", { name: "Archive School budget vote" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent('Archiving "School budget vote" needs attention');
    expect(alert).toHaveTextContent("This draft changed since Home loaded. Open it to see the latest version.");
    expect(screen.getByRole("link", { name: "School budget vote" })).toBeInTheDocument();
    expect(onArchived).not.toHaveBeenCalled();
  });

  it("says when there are no open drafts", async () => {
    renderDrafts({ loadDrafts: vi.fn(async () => selection([])) });
    expect(await screen.findByText("You have no open post drafts.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /View all/ })).not.toBeInTheDocument();
  });
});
