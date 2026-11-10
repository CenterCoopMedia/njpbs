import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ContentShelfSources } from "../src/components/ContentShelfPicker";
import { InlineBlockSurface } from "../src/components/InlineBlockSurface";
import { createBlock } from "../src/lib/block-factory";

afterEach(cleanup);

describe("record card panel", () => {
  it("shows the chosen title, status, edit link and removal", async () => {
    const onChange = vi.fn();
    const loadRecord = vi.fn(async () => ({
      status: "ready" as const,
      record: { title: "On the record", status: "published" },
    }));
    render(<ContentShelfSources.Provider value={{ loadRecord }}>
      <InlineBlockSurface block={{ ...createBlock("record_card", "card_1"),
        data: { recordKind: "program", recordId: "program_1" } }} hasError={false} onChange={onChange} />
    </ContentShelfSources.Provider>);
    await waitFor(() => expect(screen.getByText("On the record")).toBeVisible());
    expect(screen.getByText("Status: published")).toBeVisible();
    expect(screen.getByRole("link", { name: "Edit record" }))
      .toHaveAttribute("href", "/content/program/program_1/edit");
    fireEvent.click(screen.getByRole("button", { name: "Remove record" }));
    expect(onChange).toHaveBeenCalledWith({ recordKind: "program", recordId: "" });
  });

  it("warns when the chosen record is missing", async () => {
    render(<ContentShelfSources.Provider value={{
      loadRecord: async () => ({ status: "missing" as const }),
    }}>
      <InlineBlockSurface block={{ ...createBlock("record_card", "card_1"),
        data: { recordKind: "event", recordId: "missing_1" } }} hasError={false} onChange={() => {}} />
    </ContentShelfSources.Provider>);
    await waitFor(() => expect(screen.getByText(/hidden on the public site/)).toBeVisible());
  });

  it("warns when a routed record has no admitted public snapshot", async () => {
    render(<ContentShelfSources.Provider value={{
      loadRecord: async () => ({ status: "ready" as const,
        record: { title: "Unpublished event", status: "published",
          publiclyVisible: false, publishAt: "2026-09-27T12:00:00.000Z",
          published: { metadata: { title: "Unpublished event" } } } }),
    }}>
      <InlineBlockSurface block={{ ...createBlock("record_card", "card_1"),
        data: { recordKind: "event", recordId: "event_1" } }} hasError={false} onChange={() => {}} />
    </ContentShelfSources.Provider>);
    await waitFor(() => expect(screen.getByText(/hidden on the public site/)).toBeVisible());
  });

  it("changes the stored kind and id after a picker choice", async () => {
    const onChange = vi.fn();
    render(<ContentShelfSources.Provider value={{
      loadLibrarySelection: async () => ({
        records: [{ id: "newsletter_1", kind: "newsletter", title: "Weekly dispatch", status: "draft" }],
        page: 1, pageCount: 1, total: 1,
      }) as any,
    }}>
      <InlineBlockSurface block={createBlock("record_card", "card_1")} hasError={false}
        onChange={onChange} />
    </ContentShelfSources.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Choose record" }));
    const choice = await screen.findByRole("button", { name: /Weekly dispatch/ });
    fireEvent.click(choice);
    expect(onChange).toHaveBeenCalledWith({
      recordKind: "newsletter", recordId: "newsletter_1", variant: "card",
    });
  });
});
