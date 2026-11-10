import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { AccountMenu } from "../src/components/ui/AccountMenu";

function Harness({
  onSignOut = vi.fn(),
  displayName = "Sam Morgan",
}: {
  onSignOut?: () => void;
  displayName?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <MemoryRouter>
      <button type="button">Outside control</button>
      <AccountMenu
        displayName={displayName}
        email="account-22@example.org"
        open={open}
        onOpenChange={setOpen}
        items={[
          { key: "profile", label: "Profile", to: "/account/profile" },
          { key: "settings", label: "Settings", to: "/account/settings" },
          { key: "sign-out", label: "Sign out", onSelect: onSignOut },
        ]}
      />
    </MemoryRouter>
  );
}

function toggle() {
  return screen.getByRole("button", {
    name: "Account menu for Sam Morgan",
  });
}

describe("account menu", () => {
  it("is a real control that names the signed-in person and starts closed", () => {
    render(<Harness />);

    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(toggle()).toHaveAttribute("aria-haspopup", "menu");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    // The identity text stays readable beside the control rather than being
    // hidden behind it.
    expect(within(toggle()).getByText("Sam Morgan")).toBeInTheDocument();
    expect(within(toggle()).getByText("account-22@example.org")).toBeInTheDocument();
  });

  it("opens on click with every action reachable and focus inside the menu", () => {
    render(<Harness />);

    fireEvent.click(toggle());

    // The menu takes its name from the control that opened it, so a screen reader
    // announces whose account these actions belong to.
    const menu = screen.getByRole("menu", {
      name: "Account menu for Sam Morgan",
    });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Profile",
      "Settings",
      "Sign out",
    ]);
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(items[0]).toHaveFocus();
    expect(items[0]).toHaveAttribute("tabindex", "0");
    expect(items[1]).toHaveAttribute("tabindex", "-1");
    expect(menu).toHaveAttribute("aria-labelledby", toggle().id);
  });

  it("opens from the keyboard at the end the arrow key asks for", () => {
    render(<Harness />);

    fireEvent.keyDown(toggle(), { key: "ArrowUp" });
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items[2]).toHaveFocus();
  });

  it("moves through the items with the arrow, home and end keys", () => {
    render(<Harness />);
    fireEvent.click(toggle());
    const menu = screen.getByRole("menu");
    const items = within(menu).getAllByRole("menuitem");

    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[1], { key: "End" });
    expect(items[2]).toHaveFocus();
    // Wrapping, so the last item's next is the first.
    fireEvent.keyDown(items[2], { key: "ArrowDown" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0], { key: "ArrowUp" });
    expect(items[2]).toHaveFocus();
    fireEvent.keyDown(items[2], { key: "Home" });
    expect(items[0]).toHaveFocus();
  });

  it("closes on escape and puts focus back on the control", () => {
    render(<Harness />);
    fireEvent.click(toggle());

    fireEvent.keyDown(screen.getAllByRole("menuitem")[0], { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(toggle()).toHaveFocus();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("closes when a pointer goes down outside it, without stealing focus", () => {
    render(<Harness />);
    fireEvent.click(toggle());

    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside control" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(toggle()).not.toHaveFocus();
  });

  it("shows who is signed in at the head of the open menu", () => {
    render(<Harness />);
    fireEvent.click(toggle());

    const menu = screen.getByRole("menu");
    const identity = menu.querySelector(".account-menu-identity");
    expect(identity).toHaveTextContent("Sam Morgan");
    expect(identity).toHaveTextContent("account-22@example.org");
    // Readable by assistive technology too: the toggle's name carries only the display name,
    // so this is where a screen-reader user learns the address.
    expect(identity).not.toHaveAttribute("aria-hidden");
    // The identity block is a heading for the items, not an item: the roving focus and the
    // item count are unchanged by it.
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(3);
  });

  it("closes on tab so focus continues past the menu", () => {
    render(<Harness />);
    fireEvent.click(toggle());

    fireEvent.keyDown(screen.getAllByRole("menuitem")[0], { key: "Tab" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("runs an action item and returns focus to the control", () => {
    const onSignOut = vi.fn();
    render(<Harness onSignOut={onSignOut} />);
    fireEvent.click(toggle());

    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));

    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(toggle()).toHaveFocus();
  });

  it("shows initials while no profile photo is resolved", () => {
    render(<Harness />);
    expect(within(toggle()).getByText("SM")).toBeInTheDocument();
  });
});
