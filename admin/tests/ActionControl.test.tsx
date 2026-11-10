import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionControl } from "../src/components/ui/ActionControl";
import { ControlPresentationProvider } from "../src/context/ControlPresentationContext";
import { ICON_CONTROL_REGISTRY } from "../src/lib/icon-control-registry";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderIconControl(children: React.ReactNode) {
  return render(
    <ControlPresentationProvider value="icons">
      {children}
    </ControlPresentationProvider>,
  );
}

describe("ActionControl", () => {
  it("uses Escape only for open help and keeps it from closing a parent", () => {
    const parentKeyDown = vi.fn();
    renderIconControl(
      <div onKeyDown={parentKeyDown}>
        <ActionControl action="view-options" />
      </div>,
    );
    const button = screen.getByRole("button", { name: "View options" });

    const closedEscape = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    button.dispatchEvent(closedEscape);
    expect(parentKeyDown).toHaveBeenCalledTimes(1);
    expect(closedEscape.defaultPrevented).toBe(false);

    parentKeyDown.mockClear();
    act(() => button.focus());
    expect(screen.getByRole("tooltip", { hidden: true })).toBeVisible();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(parentKeyDown).not.toHaveBeenCalled();
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
  });

  it("keeps action state and one-tap activation unchanged in icon mode", () => {
    const onClick = vi.fn();
    renderIconControl(
      <ActionControl
        action="collapse"
        aria-controls="panel"
        aria-expanded="true"
        onClick={onClick}
      />,
    );

    const button = screen.getByRole("button", { name: "Collapse" });
    expect(button).toHaveAttribute("aria-controls", "panel");
    expect(button).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("explains disabled contextual icons on hover while keeping the action inert", () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    renderIconControl(<ActionControl action="add-item" label="Add staff byline" disabled onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Add staff byline" });
    expect(button).toBeDisabled();
    fireEvent.pointerEnter(button.parentElement!);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole("tooltip", { hidden: true })).toHaveTextContent("Add staff byline");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(button.parentElement).not.toHaveAttribute("tabindex");
  });

  it("keeps the eligible registry limited to low-risk controls", () => {
    expect(Object.keys(ICON_CONTROL_REGISTRY)).toEqual(
      expect.arrayContaining([
        "undo",
        "redo",
        "bold",
        "italic",
        "move-up",
        "move-down",
        "expand",
        "collapse",
        "settings",
        "show",
        "hide",
        "add-block",
        "view-options",
        "media-display",
        "media-more",
        "media-favorite",
        "media-collect",
        "media-select",
      ]),
    );
    expect(ICON_CONTROL_REGISTRY["media-more"]).toMatchObject({ label: "More actions", icon: "ellipsis", state: "disclosure", alwaysIcon: true });
    expect(ICON_CONTROL_REGISTRY["media-favorite"]).toMatchObject({ label: "Favorite", icon: "heart", state: "toggle", alwaysIcon: true });
    expect(ICON_CONTROL_REGISTRY["media-collect"]).toMatchObject({ label: "Add to collection", icon: "folder-plus", state: "action", alwaysIcon: true });
    expect(ICON_CONTROL_REGISTRY["media-select"]).toMatchObject({ label: "Select", icon: "check-square", state: "toggle", alwaysIcon: true });
    // Delete and Upload stay unregistered; they are not low-risk controls.
    expect(ICON_CONTROL_REGISTRY).not.toHaveProperty("media-delete");
    expect(ICON_CONTROL_REGISTRY).not.toHaveProperty("media-upload");
    expect(ICON_CONTROL_REGISTRY["media-display"]).toMatchObject({ label: "Display", icon: "sliders", state: "disclosure", risk: "low" });
    expect(ICON_CONTROL_REGISTRY["media-display"].alwaysIcon).toBeUndefined();
    expect(
      Object.values(ICON_CONTROL_REGISTRY).every(
        (entry) => entry.iconEligible && entry.risk === "low",
      ),
    ).toBe(true);
    expect(ICON_CONTROL_REGISTRY).toHaveProperty("move-main");
    expect(ICON_CONTROL_REGISTRY).toHaveProperty("move-side");
    expect(ICON_CONTROL_REGISTRY["move-up"].alwaysIcon).toBe(true);
    expect(ICON_CONTROL_REGISTRY["move-down"].alwaysIcon).toBe(true);
    expect(ICON_CONTROL_REGISTRY["move-up"].icon).toBe("arrow-up");
    expect(ICON_CONTROL_REGISTRY["move-down"].icon).toBe("arrow-down");
    expect(ICON_CONTROL_REGISTRY.collapse.icon).toBe("chevron-up");
    expect(ICON_CONTROL_REGISTRY.expand.icon).toBe("chevron-down");
    // Focus was removed in #1043: the block toolbar's focus mode had no measured need, and an
    // unregistered id keeps a stray control from being reintroduced without a decision.
    expect(ICON_CONTROL_REGISTRY).not.toHaveProperty("focus");
  });
});

it("cancels delayed action help when scrolling moves the trigger", () => {
  vi.useFakeTimers();
  renderIconControl(<ActionControl action="expand" label="Expand formatting" />);
  fireEvent.pointerEnter(screen.getByRole("button", { name: "Expand formatting" }));
  fireEvent.scroll(window);
  act(() => vi.advanceTimersByTime(300));
  expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
});
