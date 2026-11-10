import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoverCard } from "../src/components/ui/HoverCard";

function renderCard(focusDelay?: number) {
  render(
    <HoverCard
      content={<p>Studio B walkthrough.mp4 · 12:34 · 1.4 GB</p>}
      focusDelay={focusDelay}
      label="Details for Studio B walkthrough"
    >
      <button type="button">Studio B walkthrough</button>
    </HoverCard>,
  );
  return screen.getByRole("button", { name: "Studio B walkthrough" });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("HoverCard", () => {
  it("appears after a hover pause and describes its trigger", () => {
    const trigger = renderCard();
    fireEvent.pointerEnter(trigger);
    expect(screen.queryByText(/12:34/)).toBeNull();

    act(() => vi.advanceTimersByTime(600));
    const card = screen.getByRole("group", { name: "Details for Studio B walkthrough" });
    expect(card).toHaveTextContent("1.4 GB");
    expect(trigger.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("describes its trigger with the details, not just the card's name", () => {
    const trigger = renderCard();
    fireEvent.focus(trigger);
    expect(trigger).toHaveAccessibleDescription("Studio B walkthrough.mp4 · 12:34 · 1.4 GB");
  });

  it("opens on keyboard focus without a delay", () => {
    const trigger = renderCard();
    fireEvent.focus(trigger);
    expect(screen.getByRole("group", { name: "Details for Studio B walkthrough" })).toBeInTheDocument();
  });

  it("stays open while the pointer moves onto the card", () => {
    const trigger = renderCard();
    fireEvent.pointerEnter(trigger);
    act(() => vi.advanceTimersByTime(600));
    const card = screen.getByRole("group");

    fireEvent.pointerLeave(trigger);
    fireEvent.pointerEnter(card);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole("group")).toBeInTheDocument();

    fireEvent.pointerLeave(card);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("dismisses on Escape without moving focus", () => {
    const trigger = renderCard();
    trigger.focus();
    fireEvent.focus(trigger);
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("group")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("with focusDelay, focus opens the card after the delay and Escape closes it without moving focus", () => {
    const trigger = renderCard(600);
    trigger.focus();
    fireEvent.focus(trigger);
    expect(screen.queryByRole("group")).toBeNull();

    act(() => vi.advanceTimersByTime(599));
    expect(screen.queryByRole("group")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("group", { name: "Details for Studio B walkthrough" })).toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("group")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("with focusDelay, moving focus away before the delay never opens the card", () => {
    const trigger = renderCard(600);
    fireEvent.focus(trigger);
    act(() => vi.advanceTimersByTime(300));
    fireEvent.blur(trigger);
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("with focusDelay, a pointer that leaves before the delay does not cancel the focus opening", () => {
    const trigger = renderCard(600);
    fireEvent.pointerEnter(trigger);
    fireEvent.focus(trigger);
    act(() => vi.advanceTimersByTime(200));
    fireEvent.pointerLeave(trigger);
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByRole("group", { name: "Details for Studio B walkthrough" })).toBeInTheDocument();
  });

  it("with focusDelay, Escape before the delay cancels the pending card", () => {
    const trigger = renderCard(600);
    fireEvent.focus(trigger);
    fireEvent.keyDown(trigger, { key: "Escape" });
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.queryByRole("group")).toBeNull();
  });
});
