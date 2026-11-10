import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaCategorySettings } from "../src/components/MediaCategorySettings";

afterEach(cleanup);

describe("MediaCategorySettings", () => {
  it("keeps new-category input after a failed create", async () => {
    const mutate = vi
      .fn()
      .mockRejectedValue(new Error("The category already exists."));
    render(
      <MediaCategorySettings
        load={vi.fn().mockResolvedValue({ success: true, categories: [] })}
        mutate={mutate}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add category" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Category ID" }), {
      target: { value: "local-news" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Label" }), {
      target: { value: "Local news" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Order" }), {
      target: { value: "30" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
      target: { value: "Local newsroom images" },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Create category" }).closest("form")!,
    );

    expect(await screen.findByText("The category already exists.")).toBeVisible();
    await waitFor(() => expect(mutate).toHaveBeenCalledOnce());
    expect(screen.getByRole("textbox", { name: "Category ID" })).toHaveValue(
      "local-news",
    );
    expect(screen.getByRole("textbox", { name: "Label" })).toHaveValue(
      "Local news",
    );
    expect(screen.getByRole("spinbutton", { name: "Order" })).toHaveValue(30);
    expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
      "Local newsroom images",
    );
  });
});
