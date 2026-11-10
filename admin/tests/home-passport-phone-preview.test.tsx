import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { BlockEditor } from "../src/components/BlockEditor";
import type { AdminBlock } from "../src/lib/block-factory";
import { homeCompositionView } from "../../packages/content-core/src/home-composition";
import { HOME_DESTINATIONS } from "../../packages/content-core/src/home-composition-contract";
import { renderHomePassport } from "../../packages/content-core/src/home-section-render";
import { parseBlocks } from "../../packages/content-core/src/content-model";
import savedHome from "../../site/tests/fixtures/home-v2-parity.json";

afterEach(cleanup);

for (const control of ["Passport", "Passport action"]) {
  it(`explains a withdrawn Passport from the ${control} phone control`, async () => {
    const blocks = structuredClone(savedHome.blocks) as AdminBlock[];
    blocks.filter(block => block.section?.startsWith("home-passport-")).forEach(block => { block.visible = false; });
    render(<BlockEditor section="home" pageId="home" homeCompositionVersion={2} initialBlocks={blocks} commandsInline />);
    fireEvent.click(screen.getByRole("button", { name: `Edit ${control}` }));
    const expand = screen.queryByRole("button", { name: "Expand component preview" });
    if (expand) fireEvent.click(expand);
    expect(within(screen.getByRole("complementary", { name: "Component phone preview" })).getByRole("status")).toHaveTextContent("This section is removed from the page.");
    expect(document.querySelector("iframe.home-preview-frame")).toBeNull();
  });

  it(`shows the complete saved public Passport from the ${control} phone control`, async () => {
    const parsed = parseBlocks(savedHome.blocks);
    if (!parsed.ok) throw new Error(parsed.error);
    const expected = document.createElement("div");
    expected.innerHTML = renderHomePassport(homeCompositionView(parsed.blocks).passport, HOME_DESTINATIONS.passport);
    // Phone frames make links inert without changing the public destination.
    expected.querySelectorAll("a").forEach(anchor => { anchor.tabIndex = -1; });
    render(<BlockEditor section="home" pageId="home" homeCompositionVersion={2}
      initialBlocks={structuredClone(savedHome.blocks) as AdminBlock[]} commandsInline />);
    fireEvent.click(screen.getByRole("button", { name: `Edit ${control}` }));
    const expand = screen.queryByRole("button", { name: "Expand component preview" });
    if (expand) fireEvent.click(expand);
    await waitFor(() => expect(document.querySelector("iframe.home-preview-frame")).not.toBeNull());
    const frame = document.querySelector<HTMLIFrameElement>("iframe.home-preview-frame")!;
    // jsdom does not load srcdoc; reproduce only the browser document boundary.
    const doc = frame.contentDocument!;
    Object.defineProperty(doc, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
    doc.open(); doc.write(frame.srcdoc); doc.close();
    fireEvent.load(frame);
    expect(doc.querySelector(".passport")?.outerHTML).toBe(expected.querySelector(".passport")!.outerHTML);
  });
}
