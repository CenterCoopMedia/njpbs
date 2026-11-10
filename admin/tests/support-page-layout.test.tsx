import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BlockEditor } from "../src/components/BlockEditor";
import { pageMetadataFromDocument, pageMetadataSaveDocument } from "../src/lib/page-metadata";
import type { AdminBlock } from "../src/lib/block-factory";
import fixture from "./fixtures/support-page.json";
import { planSupportPageComposition } from "../../packages/content-core/src/support-page-composition";

afterEach(cleanup);

describe("support composition in the existing page editor", () => {
  it("keeps layout ownership on load and out of ordinary metadata payloads", () => {
    const metadata = pageMetadataFromDocument("support", { ...fixture, serviceCompositionVersion: 1 });
    expect(metadata.serviceCompositionVersion).toBe(1);
    expect(pageMetadataSaveDocument(metadata)).not.toHaveProperty("serviceCompositionVersion");
  });
  it("moves the destination card set ahead of DAF, adds a card set, and saves CMS order", async () => {
    const onSave = vi.fn();
    const blocks = planSupportPageComposition(fixture).blocks as AdminBlock[];
    render(<BlockEditor pageId="support" section="programLanding" initialBlocks={blocks} onSave={onSave} newId={() => "new-cards"} allowIncomplete />);
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    const outline = (await screen.findByRole("navigation", { name: "Content outline" }));
    fireEvent.click(within(outline).getByRole("button", { name: /^Go to card set 6:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(within(outline).getByRole("button", { name: "Move up: card set 6 in content outline" }));
    const insert = screen.getAllByRole("button", { name: /^Add content: position/ }).at(-1)!;
    fireEvent.click(insert);
    fireEvent.click(screen.getByRole("radio", { name: /card set/i }));
    fireEvent.click(screen.getByRole("button", { name: "Insert block" }));
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    expect(onSave).toHaveBeenCalled();
    expect(onSave.mock.calls[0][0].map((block: AdminBlock) => block.id)).toEqual([
      "fixture-hero-actions", "fixture-transition-notice", "fixture-transition-actions", "fixture-body-copy",
      "fixture-service-destinations", "fixture-daf", "new-cards",
    ]);
  });
});
