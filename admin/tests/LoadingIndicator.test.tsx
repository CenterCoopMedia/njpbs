import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoadingIndicator, STAGE_CYCLE_MS } from "../src/components/ui/LoadingIndicator";

describe("LoadingIndicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("announces the real status and hides decorative tips from assistive technology", () => {
    render(
      <LoadingIndicator
        label="Loading the media library"
        stages={["Asking the CMS for images", "Sorting by upload date"]}
      />,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading the media library");
    expect(status.querySelector(".loading-indicator-label")).toHaveTextContent(
      "Loading the media library",
    );
    const stage = status.querySelector(".loading-indicator-stage");
    expect(status).toHaveAttribute("aria-live", "off");
    expect(status.querySelector(".loading-indicator-label")).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAccessibleName("Loading the media library");
    // Readable but never announced, so the pause control has reachable content.
    expect(stage).not.toHaveAttribute("aria-hidden");
    expect(stage?.closest('[aria-live="polite"]')).toBeNull();
    expect(stage).toHaveTextContent("BOARDWALK TIP NO. 1");
    act(() => vi.advanceTimersByTime(STAGE_CYCLE_MS));
    expect(status).toHaveAccessibleName("Loading the media library");
    expect(status.querySelector('[aria-live="polite"]')).toHaveTextContent("Loading the media library");
    expect(status.querySelector('[aria-live="polite"]')).not.toHaveTextContent("BOARDWALK TIP");
    expect(status.querySelector(".spinner")).not.toBeNull();
  });

  it("stops cycling for reduced motion and follows preference changes", () => {
    let reducedMotion = true;
    let changeListener: (() => void) | undefined;
    const removeEventListener = vi.fn();
    const preference = {
      get matches() {
        return reducedMotion;
      },
      addEventListener: vi.fn((_type: string, listener: () => void) => {
        changeListener = listener;
      }),
      removeEventListener,
    };
    const matchMedia = vi.fn(() => preference);
    vi.stubGlobal("matchMedia", matchMedia);

    const { unmount } = render(
      <LoadingIndicator label="Loading" stages={["First step", "Second step"]} />,
    );
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    expect(screen.queryByRole("button", { name: "Pause text" })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    reducedMotion = false;
    act(() => changeListener?.());
    expect(screen.getByRole("button", { name: "Pause text" })).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(1);

    reducedMotion = true;
    act(() => changeListener?.());
    expect(screen.queryByRole("button", { name: "Pause text" })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    const registeredListener = changeListener;
    unmount();
    expect(removeEventListener).toHaveBeenCalledWith("change", registeredListener);
  });

});
