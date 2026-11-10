import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ContentQuickEdit,
  type ContentQuickEditTarget,
} from "../src/components/ContentQuickEdit";
import {
  ContentQuickActionsBoundary,
  useContentQuickEditGuard,
  type ContentQuickActionsApi,
} from "../src/context/ContentQuickActionsContext";
import { pageCompositionSeed } from "../../packages/content-core/src/page-composition-seeds";

const principal = {
  id: "sa",
  grants: [{ role: "super_admin" as const }],
};

function GuardProbe() {
  const guard = useContentQuickEditGuard();
  return (
    <div>
      <span data-testid="quick-edit-dirty">{String(guard.dirty)}</span>
      <button type="button" onClick={() => void guard.save()}>
        Save registered quick edits
      </button>
    </div>
  );
}

function renderQuickEdit(
  api: ContentQuickActionsApi,
  target: ContentQuickEditTarget,
  label = "Station update",
  onDocumentChange = vi.fn(),
  persistentEditorDirty = false,
) {
  return {
    onDocumentChange,
    ...render(
      <ContentQuickActionsBoundary value={api}>
        <ContentQuickEdit
          label={label}
          target={target}
          onDocumentChange={onDocumentChange}
          persistentEditorDirty={persistentEditorDirty}
        />
        <GuardProbe />
      </ContentQuickActionsBoundary>,
    ),
  };
}

function postApi(
  overrides: Partial<ContentQuickActionsApi> = {},
): ContentQuickActionsApi {
  return {
    principal,
    loadPage: vi.fn(async () => null),
    savePageMetadata: vi.fn(async () => ({})),
    loadRecord: vi.fn(async () => ({
      id: "post-1",
      type: "post",
      title: "Station update",
      slug: "station-update",
      summary: "Original summary.",
      status: "draft",
      section: "station",
      createdBy: "sa",
      version: 4,
      updatedAt: "2026-08-26T21:46:00.000Z",
    })),
    saveRecordMetadata: vi.fn(async (_kind, recordId, values, baseVersion) => ({
      id: recordId,
      type: "post",
      ...values,
      slug: "station-update",
      status: "draft",
      section: "station",
      createdBy: "sa",
      version: baseVersion + 1,
      updatedAt: "2026-09-01T15:30:00.000Z",
    })),
    transition: vi.fn(async (request) => ({
      id: request.id,
      type: "post",
      title: "Station update",
      slug: "station-update",
      summary: "Original summary.",
      status: request.action === "archive" ? "archived" : "draft",
      section: "station",
      createdBy: "sa",
      version: request.baseVersion + 1,
    })),
    ...overrides,
  };
}

describe("ContentQuickEdit", () => {
  it.each(["program", "event"] as const)(
    "loads and restores an archived %s as restore-only content",
    async (kind) => {
      const document = {
        id: `${kind}-1`,
        type: kind,
        title: `Archived ${kind}`,
        status: "archived",
        createdBy: "sa",
        version: 7,
      };
      const api = postApi({
        loadRecord: vi.fn(async () => document),
        transition: vi.fn(async () => ({ ...document, status: "draft", version: 8 })),
      });
      renderQuickEdit(api, { kind, recordId: document.id }, document.title);

      expect(await screen.findByRole("heading", { name: "Restore deleted content" }))
        .toBeInTheDocument();
      expect(api.loadRecord).toHaveBeenCalledWith(kind, document.id);
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Confirm restore to draft" }));

      await waitFor(() => {
        expect(api.transition).toHaveBeenCalledWith({
          collection: "cmsPosts",
          id: document.id,
          action: "restore",
          baseVersion: 7,
        });
      });
      expect(api.saveRecordMetadata).not.toHaveBeenCalled();
    },
  );

  it("loads and saves bounded Post metadata against the opened version", async () => {
    const api = postApi();
    const { onDocumentChange } = renderQuickEdit(api, {
      kind: "post",
      recordId: "post-1",
    });

    const title = await screen.findByRole("textbox", { name: "Title" });
    const summary = screen.getByRole("textbox", { name: "Summary" });
    expect(screen.queryByRole("textbox", { name: "Slug" })).not.toBeInTheDocument();

    fireEvent.change(title, { target: { value: "Updated station report" } });
    fireEvent.change(summary, { target: { value: "Updated summary." } });
    fireEvent.click(screen.getByRole("button", { name: "Save quick edits" }));

    await waitFor(() => {
      expect(api.saveRecordMetadata).toHaveBeenCalledWith(
        "post",
        "post-1",
        {
          title: "Updated station report",
          summary: "Updated summary.",
        },
        4,
      );
    });
    expect(await screen.findByText("Quick edits saved")).toBeInTheDocument();
    expect(onDocumentChange).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Updated station report",
        slug: "station-update",
        version: 5,
      }),
    );
  });

  it("registers unsaved fields with the shared content exit guard", async () => {
    const api = postApi();
    renderQuickEdit(api, { kind: "post", recordId: "post-1" });

    fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), {
      target: { value: "Guarded station report" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("quick-edit-dirty")).toHaveTextContent("true");
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Save registered quick edits" }),
    );
    await waitFor(() => {
      expect(api.saveRecordMetadata).toHaveBeenCalledWith(
        "post",
        "post-1",
        expect.objectContaining({ title: "Guarded station report" }),
        4,
      );
    });
  });

  it("keeps metadata fields disabled for the whole save mutation", async () => {
    let resolveSave:
      | ((document: Record<string, unknown>) => void)
      | undefined;
    const api = postApi({
      saveRecordMetadata: vi.fn(
        () =>
          new Promise<Record<string, unknown>>((resolve) => {
            resolveSave = resolve;
          }),
      ),
    });
    renderQuickEdit(api, { kind: "post", recordId: "post-1" });

    const title = await screen.findByRole("textbox", { name: "Title" });
    const summary = screen.getByRole("textbox", { name: "Summary" });
    fireEvent.change(title, { target: { value: "Saving station report" } });
    fireEvent.click(screen.getByRole("button", { name: "Save quick edits" }));

    await waitFor(() => expect(title).toBeDisabled());
    expect(summary).toBeDisabled();

    resolveSave?.({
      id: "post-1",
      type: "post",
      title: "Saving station report",
      slug: "station-update",
      summary: "Original summary.",
      status: "draft",
      section: "station",
      createdBy: "sa",
      version: 5,
    });
    expect(await screen.findByText("Quick edits saved")).toBeInTheDocument();
  });

  it("keeps legacy metadata fields read-only without a usable version", async () => {
    const api = postApi({
      loadRecord: vi.fn(async () => ({
        id: "post-1",
        type: "post",
        title: "Legacy station update",
        summary: "Original summary.",
        status: "draft",
        section: "station",
        createdBy: "sa",
      })),
    });
    renderQuickEdit(api, { kind: "post", recordId: "post-1" });

    expect(await screen.findByRole("textbox", { name: "Title" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Summary" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save quick edits" })).toBeDisabled();
  });

  it("requires unsaved field changes to be resolved before a workflow transition", async () => {
    const api = postApi();
    renderQuickEdit(api, { kind: "post", recordId: "post-1" });

    const title = await screen.findByRole("textbox", { name: "Title" });
    fireEvent.change(title, { target: { value: "Unsaved title" } });

    expect(
      screen.getByRole("button", { name: "Submit for review" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Save or discard your quick edits before changing status."),
    ).toBeVisible();
    expect(api.transition).not.toHaveBeenCalled();
  });

  it("blocks workflow transitions while the full editor retains a draft", async () => {
    const api = postApi();
    renderQuickEdit(
      api,
      { kind: "post", recordId: "post-1" },
      "Station update",
      vi.fn(),
      true,
    );

    expect(
      await screen.findByText(
        "Save or discard the full editor draft before changing status here.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Submit for review" }),
    ).toBeDisabled();
    expect(api.transition).not.toHaveBeenCalled();
  });

  it("opens a published Post for quick edits without a write", async () => {
    const api = postApi({
      loadRecord: vi.fn(async () => ({
        id: "post-1",
        type: "post",
        title: "Published station update",
        slug: "published-station-update",
        summary: "Published summary.",
        status: "published",
        section: "station",
        createdBy: "sa",
        version: 7,
      })),
    });
    renderQuickEdit(
      api,
      { kind: "post", recordId: "post-1" },
      "Published station update",
    );

    const title = await screen.findByRole("textbox", { name: "Title" });
    expect(title).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Summary" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Start revision" })).not.toBeInTheDocument();
    expect(api.transition).not.toHaveBeenCalled();
    expect(api.saveRecordMetadata).not.toHaveBeenCalled();
    fireEvent.change(title, { target: { value: "Edited station update" } });
    fireEvent.click(screen.getByRole("button", { name: "Save quick edits" }));
    await waitFor(() => expect(api.saveRecordMetadata).toHaveBeenCalledWith(
      "post", "post-1", { title: "Edited station update", summary: "Published summary." }, 7,
    ));
    expect(api.transition).not.toHaveBeenCalled();
  });

  it("describes schedule cancellation as a return to draft and unlocks quick edits", async () => {
    // #2761: cancellation must not suggest the saved version was approved.
    const api = postApi({
      loadRecord: vi.fn(async () => ({
        id: "post-1", type: "post", title: "Station update",
        slug: "station-update", summary: "Original summary.",
        status: "scheduled", section: "station", createdBy: "sa", version: 4,
      })),
    });
    renderQuickEdit(api, { kind: "post", recordId: "post-1" });

    const title = await screen.findByRole("textbox", { name: "Title" });
    expect(title).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel scheduled publication" }));
    expect(screen.getByText(
      "Cancel the scheduled publication and return this saved version to draft for editing or rescheduling.",
    )).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancel scheduled publication" }));

    await waitFor(() => expect(api.transition).toHaveBeenCalledWith({
      collection: "cmsPosts", id: "post-1", action: "unschedule", baseVersion: 4,
    }));
    expect(await screen.findByText("Scheduled publication cancelled.")).toBeInTheDocument();
    expect(title).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Summary" })).toBeEnabled();
    expect(api.saveRecordMetadata).not.toHaveBeenCalled();
  });

  it("uses Move to recycle bin for the recoverable archive transition", async () => {
    const api = postApi({
      loadRecord: vi.fn(async () => ({
        id: "post-1",
        type: "post",
        title: "Published station update",
        slug: "published-station-update",
        summary: "Published summary.",
        status: "published",
        section: "station",
        createdBy: "sa",
        version: 7,
      })),
    });
    renderQuickEdit(
      api,
      { kind: "post", recordId: "post-1" },
      "Published station update",
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Move to recycle bin" }),
    );
    const confirmation = screen.getByRole("group", {
      name: "Move to recycle bin?",
    });
    expect(confirmation).toHaveTextContent("remain recoverable");

    fireEvent.click(
      within(confirmation).getByRole("button", {
        name: "Confirm move to recycle bin",
      }),
    );

    await waitFor(() => {
      expect(api.transition).toHaveBeenCalledWith({
        collection: "cmsPosts",
        id: "post-1",
        action: "archive",
        baseVersion: 7,
      });
    });
    expect(await screen.findByText("Content deleted.")).toBeInTheDocument();
    expect(screen.getByText("Deleted")).toBeInTheDocument();
  });

  it("merges the Page composition seed before saving bounded metadata", async () => {
    const seedDescription = pageCompositionSeed("home")?.metadata.description;
    if (typeof seedDescription !== "string") {
      throw new Error("The Home composition seed needs a description for this test.");
    }
    const api = postApi({
      loadPage: vi.fn(async () => ({
        id: "home",
        title: "Home",
        status: "draft",
        createdBy: "sa",
        version: 3,
      })),
      savePageMetadata: vi.fn(async (_pageId, values, baseVersion) => ({
        id: "home",
        ...values,
        status: "draft",
        createdBy: "sa",
        version: baseVersion + 1,
      })),
    });
    renderQuickEdit(api, { kind: "page", pageId: "home" }, "Home");

    fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), {
      target: { value: "NJ PBS home" },
    });
    expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
      seedDescription,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save quick edits" }));

    await waitFor(() => {
      expect(api.savePageMetadata).toHaveBeenCalledWith(
        "home",
        {
          title: "NJ PBS home",
          description: seedDescription,
        },
        3,
      );
    });
  });
});
