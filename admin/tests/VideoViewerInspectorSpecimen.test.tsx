import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { VideoViewerInspectorSpecimen } from "../src/dev/MediaInspectorSpecimen";

it("keeps native header save and result navigation protected while credentials are pending", async () => {
  render(<VideoViewerInspectorSpecimen getIdToken={() => new Promise(() => {})} />);
  const viewer = screen.getByRole("dialog", { name: "Statehouse B-roll, spring session" });
  const title = within(viewer).getByRole("textbox", { name: "Title" });
  const save = within(viewer).getByRole("button", { name: "Save details" });
  expect(save).toHaveAttribute("form", (title as HTMLInputElement).form!.id);
  fireEvent.change(title, { target: { value: "A pending local draft" } });
  fireEvent.click(save);
  await waitFor(() => expect(within(viewer).getByRole("button", { name: "Close" })).toBeDisabled());
  expect(save).toHaveAttribute("aria-busy", "true");
  expect(save).toHaveAttribute("aria-disabled", "true");
  expect(within(viewer).getByRole("button", { name: "Next file" })).toBeDisabled();
  fireEvent.keyDown(viewer, { key: "Escape" });
  expect(viewer).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Discard changes" })).not.toBeInTheDocument();
});
