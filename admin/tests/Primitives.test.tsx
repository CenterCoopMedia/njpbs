import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AsyncActionButton, Button } from "../src/components/ui/Primitives";

describe("admin UI primitives", () => {
  it("renders button variants with a safe default type", () => {
    const onClick = vi.fn();

    render(
      <Button variant="primary" onClick={onClick}>
        Save draft
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Save draft" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("button-primary");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keeps async action geometry stable and announces pending work", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <AsyncActionButton
        label="Save"
        onClick={onClick}
        pending={false}
        pendingAnnouncement="Saving record."
        pendingLabel="Saving…"
        variant="primary"
      />,
    );

    const idle = screen.getByRole("button", { name: "Save" });
    expect(idle).not.toHaveAttribute("aria-busy");
    expect(idle).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    idle.focus();

    rerender(
      <AsyncActionButton
        disabled
        label="Save"
        onClick={onClick}
        pending
        pendingAnnouncement="Saving record."
        pendingLabel="Saving…"
        variant="primary"
      />,
    );

    const pending = screen.getByRole("button", { name: "Save: Saving…" });
    expect(pending).toHaveAccessibleName("Save: Saving…");
    expect(pending).not.toBeDisabled();
    expect(pending).toHaveAttribute("aria-disabled", "true");
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(pending).toHaveFocus();
    expect(pending.querySelector(".activity-indicator")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Saving record.");
    fireEvent.click(pending);
    expect(onClick).not.toHaveBeenCalled();
  });

});
