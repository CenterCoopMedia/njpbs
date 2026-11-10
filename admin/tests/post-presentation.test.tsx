import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordForm } from "../src/components/RecordForm";

afterEach(cleanup);
afterEach(() => localStorage.clear());

function post(tags: string[] = []) {
  return {
    title: "Transit changes",
    tags,
    blocks: [],
  };
}

function presentationSelect(): HTMLSelectElement {
  return screen.getByRole("combobox", { name: "Presentation" });
}

function visibleTags(): string[] {
  const input = screen.getByRole("textbox", { name: "New tag" });
  const tags = input.closest<HTMLElement>(".editor-tag-list");
  if (!tags) throw new Error("Missing ordinary Tags control.");
  return Array.from(tags.querySelectorAll(".editor-tag-label"), (label) =>
    label.textContent?.trim() ?? "",
  );
}

describe("Post presentation control", () => {
  it("saves the Home hero checkbox separately from public tags", async () => {
    const onSave = vi.fn();
    const view = render(<RecordForm kind="post" initial={post(["Transit"])} onSave={onSave} canSave />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Show in Home hero" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0];
    expect(saved.showInHomeHero).toBe(true);
    expect(saved.tags).toEqual(["Transit"]);
    view.unmount();
    render(<RecordForm kind="post" initial={saved} onSave={() => {}} canSave />);
    expect(screen.getByRole("checkbox", { name: "Show in Home hero" })).toBeChecked();
  });

  it("offers the four named presentations and defaults a marker-free Post to Standard Post", () => {
    render(<RecordForm kind="post" initial={post(["Transit"])} onSave={() => {}} canSave />);

    const select = presentationSelect();
    expect(select).toHaveValue("standard");
    expect(
      within(select).getAllByRole("option").map((option) => option.textContent),
    ).toEqual([
      "Standard post",
      "Special report",
      "Multimedia feature",
      "Interactive/Data Lab",
    ]);
  });

  it("saves an incomplete Interactive/Data Lab draft and adopts its marker after remount", async () => {
    const onSave = vi.fn();
    const view = render(
      <RecordForm
        kind="post"
        initial={post(["Transit", "New Jersey"])}
        onSave={onSave}
        canSave
      />,
    );

    fireEvent.change(presentationSelect(), { target: { value: "interactive" } });
    expect(presentationSelect()).toHaveValue("interactive");
    expect(
      screen.getByText("An Interactive/Data Lab Post must include at least one complete data figure or table, custom HTML block, or approved media or interactive link. You can save this draft and complete it before approval."),
    ).toHaveTextContent("You can save this draft and complete it before approval.");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    const saved = onSave.mock.calls[0]![0] as Record<string, unknown>;
    expect(saved.tags).toEqual([
      "Transit",
      "New Jersey",
      "format:interactive",
    ]);

    view.unmount();
    render(<RecordForm kind="post" initial={saved} onSave={() => {}} canSave />);
    expect(presentationSelect()).toHaveValue("interactive");
  });

  it("hides reserved markers from Tags and rejects typed or pasted competing markers", async () => {
    const onSave = vi.fn();
    render(
      <RecordForm
        kind="post"
        initial={post(["Transit", "format:interactive", "New Jersey"])}
        onSave={onSave}
        canSave
      />,
    );

    expect(presentationSelect()).toHaveValue("interactive");
    expect(visibleTags()).toEqual(["Transit", "New Jersey"]);

    const input = screen.getByRole("textbox", { name: "New tag" });
    const tags = input.closest<HTMLElement>(".editor-tag-list");
    if (!tags) throw new Error("Missing ordinary Tags control.");

    fireEvent.change(input, { target: { value: "format:special-report" } });
    fireEvent.click(within(tags).getByRole("button", { name: "Add tag" }));
    expect(visibleTags()).toEqual(["Transit", "New Jersey"]);

    fireEvent.paste(input, {
      clipboardData: {
        getData: () => "format:multimedia, Housing",
      },
    });
    expect(visibleTags()).toEqual(["Transit", "New Jersey", "Housing"]);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0].tags).toEqual([
      "Transit",
      "New Jersey",
      "Housing",
      "format:interactive",
    ]);
  });

  it.each([
    ["unknown", ["Transit", "format:future"]],
    ["competing", ["Transit", "format:interactive", "format:multimedia"]],
  ])("blocks an invalid legacy %s marker set until a valid choice replaces it", async (_case, tags) => {
    const onSave = vi.fn();
    render(<RecordForm kind="post" initial={post(tags)} onSave={onSave} canSave />);

    const select = presentationSelect();
    expect(select).toHaveValue("");
    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).not.toHaveBeenCalled();
    await waitFor(() => expect(select).toHaveFocus());

    fireEvent.change(select, { target: { value: "special-report" } });
    expect(select).toHaveValue("special-report");
    expect(select).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0].tags).toEqual([
      "Transit",
      "format:special-report",
    ]);
  });
});
