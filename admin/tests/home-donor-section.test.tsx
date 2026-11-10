import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockEditor } from "../src/components/BlockEditor";
import type { AdminBlock } from "../src/lib/block-factory";
import { createHomeDonorBlock } from "../../packages/content-core/src/home-donor-section";
import v1 from "../../site/tests/fixtures/home-composition-v1.json";

const original = () => structuredClone(v1.blocks) as AdminBlock[];
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

function SavedHome() {
  const [saved, setSaved] = useState(original());
  const [reopen, setReopen] = useState(0);
  return <><button onClick={() => setReopen(value => value + 1)}>Reopen fixture</button>
    <BlockEditor key={reopen} section="home" pageId="home" homeCompositionVersion={2} initialBlocks={saved}
      allowIncomplete commandsInline onSave={async blocks => { setSaved(blocks); }} />
    <output data-testid="saved">{JSON.stringify(saved)}</output></>;
}

describe("mounted Home giving plank", () => {
  it("adds, edits, arranges, saves, reopens and restores one giving identity without offering a URL field", async () => {
    render(<SavedHome />);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Donor-advised giving" }));
    // The established Home Add/Restore contract focuses the resulting section.
    await waitFor(() => expect(document.querySelector('[data-home-section="home-donor"] .block-card')).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Edit Donor-advised giving" }));
    const dialog = screen.getByRole("dialog", { name: "Donor-advised giving" });
    expect(await within(dialog).findByRole("textbox", { name: "Button text" })).toHaveValue("Learn more");
    expect(within(dialog).queryByRole("textbox", { name: /url|destination|link/i })).toBeNull();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Heading" }), { target: { value: "Reviewed giving heading" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Summary" }), { target: { value: "Reviewed giving\nsummary\tfor staff" } });
    expect(within(dialog).getByRole("textbox", { name: "Summary" })).toHaveValue("Reviewed giving summary for staff");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Button text" }), { target: { value: "Explore giving" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    const plank = document.querySelector<HTMLElement>('[data-home-section="home-donor"]')!;
    fireEvent.keyDown(within(plank).getByRole("button", { name: /^Move:/ }), { key: "ArrowUp" });
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() => expect(JSON.parse(screen.getByTestId("saved").textContent!).at(-2).section).toBe("home-donor"));
    const giving = JSON.parse(screen.getByTestId("saved").textContent!).find((block: AdminBlock) => block.section === "home-donor");
    expect(giving.data.cards[0]).toMatchObject({ title: "Reviewed giving heading", label: "Explore giving", href: "/support/" });
    fireEvent.click(screen.getByRole("button", { name: "Reopen fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Donor-advised giving" }));
    const reopened = screen.getByRole("dialog", { name: "Donor-advised giving" });
    expect(await within(reopened).findByRole("textbox", { name: "Summary" })).toHaveValue("Reviewed giving summary for staff");
    fireEvent.click(within(reopened).getByRole("button", { name: /^Remove section from page/ }));
    fireEvent.click(within(reopened).getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Donor-advised giving Restore hidden section" }));
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() => expect(JSON.parse(screen.getByTestId("saved").textContent!).filter((block: AdminBlock) => block.section === "home-donor")).toEqual([giving]));
  });

  it("prevents read-only, disabled-layout and capacity-limited insertion", () => {
    const secondGrid: AdminBlock = { ...createHomeDonorBlock("ordinary-grid"), section: undefined, order: 7 } as unknown as AdminBlock;
    const disabled = render(<BlockEditor section="home" pageId="home" homeCompositionVersion={2} initialBlocks={original()} readOnly commandsInline />);
    expect(screen.getByRole("button", { name: "Add" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.queryByRole("menu")).toBeNull();
    disabled.unmount();
    const coexist = render(<BlockEditor section="home" pageId="home" homeCompositionVersion={2} initialBlocks={[...original(), secondGrid]} commandsInline />);
    expect(screen.getByRole("button", { name: "Add" })).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Donor-advised giving" }));
    expect(screen.getByRole("button", { name: "Edit Donor-advised giving" })).toBeEnabled();
    coexist.unmount();
    const fullBlocks = [...original(), ...Array.from({ length: 33 }, (_, index) => ({ id: `copy-${index}`, type: "prose", visible: true, order: 7 + index, data: { content: { type: "doc", content: [] } } }))] as AdminBlock[];
    const full = render(<BlockEditor section="home" pageId="home" homeCompositionVersion={2} initialBlocks={fullBlocks} allowIncomplete commandsInline />);
    expect(screen.getByRole("button", { name: "Add" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByText("Remove a plank to make room for new content.")).toBeVisible();
    full.unmount();
    vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", "false");
    render(<BlockEditor section="home" pageId="home" homeCompositionVersion={2} initialBlocks={original()} commandsInline />);
    expect(screen.getByRole("button", { name: "Add" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
