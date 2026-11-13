import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecordForm, type RecordSaveReceipt } from "../src/components/RecordForm";

describe("per-story automatic CTA choice", () => {
  it("saves and reloads the opt-out as story metadata", async () => {
    const save = vi.fn(async (record: Record<string, unknown>): Promise<RecordSaveReceipt> => ({
      kind: "record-save-receipt", document: { ...record, id: "cta-story", version: 2 }, mintedIds: {},
    }));
    const view = render(<RecordForm kind="post" canSave allowIncomplete initial={{ title: "Sensitive coverage", blocks: [] }} onSave={save} />);
    const toggle = screen.getByRole("checkbox", { name: "Skip automatic CTAs" });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]![0].disableStoryCtas).toBe(true);
    view.unmount();
    render(<RecordForm kind="post" canSave allowIncomplete initial={{ title: "Sensitive coverage", blocks: [], disableStoryCtas: true }} onSave={save} />);
    expect(screen.getByRole("checkbox", { name: "Skip automatic CTAs" })).toBeChecked();
  });
  it("locks the switch when the record is read only", () => {
    render(<RecordForm kind="post" readOnly canSave allowIncomplete initial={{ title: "Read only", blocks: [], disableStoryCtas: true }} onSave={vi.fn()} />);
    expect(screen.getByRole("checkbox", { name: "Skip automatic CTAs" })).toBeDisabled();
  });
});
