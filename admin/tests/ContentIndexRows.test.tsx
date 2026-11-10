import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import {
  RecordList,
  type RecordListPage,
} from "../src/components/RecordList";
import {
  ContentQuickActionsBoundary,
  type ContentQuickActionsApi,
} from "../src/context/ContentQuickActionsContext";

const principal = {
  id: "sa",
  grants: [{ role: "super_admin" as const }],
};

function postPage(): RecordListPage {
  return {
    records: [
      {
        id: "post-station-update",
        title: "Station update",
        status: "draft",
        updatedAt: "2026-08-26T21:46:00.000Z",
      },
    ],
    page: 1,
    pageCount: 1,
    total: 1,
  };
}

describe("expandable Pages and Posts rows", () => {
  it.each([
    ["draft", "Draft"],
    ["in_review", "In review"],
    ["approved", "Approved"],
  ])(
    "separates a %s working revision from its older live Post snapshot",
    async (status, statusLabel) => {
      const loadRecords = vi.fn(async () => ({
        ...postPage(),
        records: [
          {
            id: `post-${status}`,
            title: "Station appointments",
            status,
            version: 12,
            liveSourceVersion: 8,
          },
        ],
      }));
      render(
        <MemoryRouter initialEntries={["/content/post"]}>
          <RecordList
            canCreate
            kind="post"
            label="Post"
            loadRecords={loadRecords}
          />
        </MemoryRouter>,
      );

      const title = await screen.findByRole("link", {
        name: "Station appointments",
      });
      const row = title.closest("tr");
      if (!row) throw new Error("Expected the Station appointments row.");
      expect(within(row).getByText(statusLabel)).toBeInTheDocument();
      expect(within(row).getByText("A published copy was last recorded")).toBeInTheDocument();
      expect(
        within(row).getByText("Working version 12"),
      ).toBeInTheDocument();
    },
  );

  it("refetches the server-sorted Post page after a quick save", async () => {
    const refreshed = {
      ...postPage(),
      records: [
        {
          id: "post-newest",
          title: "Newer server-selected post",
          status: "draft",
          updatedAt: "2026-09-01T17:30:00.000Z",
        },
      ],
    };
    const loadRecords = vi
      .fn()
      .mockResolvedValueOnce(postPage())
      .mockResolvedValueOnce(refreshed);
    const api: ContentQuickActionsApi = {
      principal,
      loadPage: vi.fn(async () => null),
      savePageMetadata: vi.fn(async () => ({})),
      loadRecord: vi.fn(async () => ({
        id: "post-station-update",
        type: "post",
        title: "Station update",
        summary: "Original summary.",
        status: "draft",
        section: "station",
        createdBy: "sa",
        version: 4,
      })),
      saveRecordMetadata: vi.fn(async (_kind, id, values, baseVersion) => ({
        id,
        type: "post",
        ...values,
        status: "draft",
        section: "station",
        createdBy: "sa",
        version: baseVersion + 1,
      })),
      transition: vi.fn(async () => ({})),
    };

    render(
      <MemoryRouter initialEntries={["/content/post"]}>
        <ContentQuickActionsBoundary value={api}>
          <RecordList
            canCreate
            kind="post"
            label="Post"
            loadRecords={loadRecords}
          />
        </ContentQuickActionsBoundary>
      </MemoryRouter>,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Show details for Station update",
      }),
    );
    fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), {
      target: { value: "Updated station report" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save quick edits" }));

    await waitFor(() => expect(loadRecords).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByRole("link", { name: "Newer server-selected post" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Station update" })).not.toBeInTheDocument();
  });

});
