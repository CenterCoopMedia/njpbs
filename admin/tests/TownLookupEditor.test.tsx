import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { BlockEditor } from "../src/components/BlockEditor";
import { createBlock } from "../src/lib/block-factory";
import { parseBlocks } from "../../packages/content-core/src/content-model";

it("labels the heading independently of the plank title and saves edited copy", async () => {
  const save = vi.fn();
  render(<BlockEditor section="genericPage" initialBlocks={[createBlock("town_lookup", "town")]}
    commandsInline allowIncomplete onSave={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit town election lookup 1" }));
  const heading = screen.getByRole("textbox", { name: "Heading" });
  expect(document.querySelectorAll(`[id="${heading.id}"]`)).toHaveLength(1);
  fireEvent.change(heading, { target: { value: "Your town's results" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Introduction" }), { target: { value: "Compare past elections." } });
  fireEvent.change(screen.getByRole("textbox", { name: "Source line" }), { target: { value: "Compiled by NJ Spotlight News." } });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(screen.getByRole("button", { name: "Save page" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  const saved = save.mock.calls[0][0];
  expect(saved[0].data).toEqual({ heading: "Your town's results", introduction: "Compare past elections.", sourceLine: "Compiled by NJ Spotlight News." });
  expect(parseBlocks(saved).ok).toBe(true);
});
