import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { RecycleBin } from "../src/components/RecycleBin";
import { ContentQuickActionsBoundary, type ContentQuickActionsApi } from "../src/context/ContentQuickActionsContext";

describe("RecycleBin", () => {
  it.each(["page", "post"] as const)("restores a %s with its current version and retains failed items", async (kind) => {
    const document = { id: "home", type: kind, title: "Station update", status: "archived", version: 7, section: "station" };
    const transition = vi.fn().mockRejectedValueOnce(new Error("This version changed. Reload and try again."))
      .mockResolvedValueOnce({ ...document, status: "draft", version: 8 });
    const onRestore = vi.fn();
    const api: ContentQuickActionsApi = {
      principal: { id: "admin", grants: [{ role: "super_admin" }] },
      loadPage: vi.fn(async () => document), loadRecord: vi.fn(async () => document),
      savePageMetadata: vi.fn(), saveRecordMetadata: vi.fn(), transition,
    };
    render(<MemoryRouter><ContentQuickActionsBoundary value={api}>
      <RecycleBin count={1} onRestore={onRestore} loadPage={async () => ({
        page: 1, pageCount: 1, items: [{ id: "home", title: document.title,
          target: kind === "page" ? { kind, pageId: "home" } : { kind, recordId: "home" } }],
      })} />
    </ContentQuickActionsBoundary></MemoryRouter>);
    const bin = screen.getByText("Recycle bin", { selector: "summary" }).closest("details")!;
    bin.setAttribute("open", "");
    fireEvent(bin, new Event("toggle", { bubbles: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    const confirm = await screen.findByRole("button", { name: "Confirm restore to draft" });
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(confirm);
    expect(await screen.findByText("This version changed. Reload and try again.")).toBeInTheDocument();
    expect(onRestore).not.toHaveBeenCalled();
    expect(screen.getByText("Station update")).toBeInTheDocument();
    fireEvent.click(confirm);
    await waitFor(() => expect(onRestore).toHaveBeenCalledOnce());
    expect(transition).toHaveBeenLastCalledWith({
      collection: kind === "page" ? "cmsPages" : "cmsPosts",
      id: "home", action: "restore", baseVersion: 7,
    });
    expect(await screen.findByText("Station update restored to draft.")).toBeInTheDocument();
    expect(api.savePageMetadata).not.toHaveBeenCalled();
    expect(api.saveRecordMetadata).not.toHaveBeenCalled();
  });
});
