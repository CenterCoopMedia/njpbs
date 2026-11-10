import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RecordForm } from "../src/components/RecordForm";
import { pageMetadataFromDocument, pageMetadataSaveDocument } from "../src/lib/page-metadata";
afterEach(cleanup);
it.each(["post", "page"] as const)("saves a custom destination from the %s settings with new tabs on by default", async kind => {
  const save = vi.fn();
  render(<RecordForm kind={kind} pageId={kind === "page" ? "contact" : undefined} initial={{ title: "Contact NJ PBS", blocks: [], date: "2026-11-01" }} onSave={save} canSave />);
  fireEvent.change(screen.getByLabelText("Point this content to"), { target: { value: "custom" } });
  expect(screen.getByLabelText("Open in a new tab")).toBeChecked();
  fireEvent.change(screen.getByLabelText("Custom URL"), { target: { value: "https://example.test/story" } });
  fireEvent.click(screen.getByRole("button", { name: /save/i }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0][0]).toMatchObject({ contentLinkMode: "custom", contentLinkUrl: "https://example.test/story", contentLinkNewTab: true });
});
it("round-trips Page link metadata without the body and preserves the target while disabled", () => {
  const initial = { title: "Contact NJ PBS", contentLinkMode: "custom", contentLinkUrl: "https://example.test/story", contentLinkNewTab: false, blocks: [{ type: "divider" }] };
  const values = pageMetadataFromDocument("contact", initial);
  const saved = pageMetadataSaveDocument({ ...values, contentLinkMode: "normal" });
  expect(saved).toMatchObject({ contentLinkMode: "normal", contentLinkUrl: "https://example.test/story", contentLinkNewTab: false });
  expect(saved).not.toHaveProperty("blocks"); expect(initial.blocks).toEqual([{ type: "divider" }]);
});
