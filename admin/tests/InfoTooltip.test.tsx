import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InfoTooltip } from "../src/components/ui/InfoTooltip";

describe("InfoTooltip", () => {
  it("dismisses on an outside tap even when touch has not focused the trigger", () => {
    render(<InfoTooltip label="search visibility" content="This does not make the page private." />);
    const trigger = screen.getByRole("button", { name: "About search visibility" });
    fireEvent.click(trigger);
    expect(screen.getByRole("tooltip", { hidden: true })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("tooltip", { hidden: true })).not.toBeInTheDocument();
  });

  it("provides an accessible description and stays open after a touch-style click", () => {
    render(<InfoTooltip label="search visibility" content="This does not make the page private." />);
    const button = screen.getByRole("button", { name: "About search visibility" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAccessibleDescription("This does not make the page private.");
    fireEvent.focus(button);
    fireEvent.click(button);
    expect(screen.getByRole("tooltip", { hidden: true })).toHaveTextContent("This does not make the page private.");
    fireEvent.keyDown(button, { key: "Escape" });
    expect(screen.queryByRole("tooltip", { hidden: true })).not.toBeInTheDocument();
  });

  it("stays open on scroll while its trigger has keyboard focus", () => {
    render(<InfoTooltip label="search visibility" content="This does not make the page private." />);
    const trigger = screen.getByRole("button", { name: "About search visibility" });

    fireEvent.focus(trigger);
    expect(screen.getByRole("tooltip", { hidden: true })).toBeInTheDocument();

    fireEvent.scroll(window);
    expect(screen.getByRole("tooltip", { hidden: true })).toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip", { hidden: true })).not.toBeInTheDocument();
  });
});
