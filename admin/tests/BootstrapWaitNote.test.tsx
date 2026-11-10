import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BootstrapView } from "../src/components/BootstrapView";
import {
  BOOTSTRAP_NOTE_INTERVAL_MS,
  BootstrapWaitNote,
} from "../src/components/BootstrapWaitNote";

let motion: boolean;
let visibility: boolean;
let motionListeners: Set<() => void>;

beforeEach(() => {
  vi.useFakeTimers();
  motion = false;
  visibility = false;
  motionListeners = new Set();
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.spyOn(document, "hidden", "get").mockImplementation(() => visibility);
  vi.stubGlobal("matchMedia", () => ({
    get matches() { return motion; },
    addEventListener: (_: string, listener: () => void) => motionListeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => motionListeners.delete(listener),
  }));
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const advance = (ms = BOOTSTRAP_NOTE_INTERVAL_MS) => act(() => vi.advanceTimersByTime(ms));

describe("bootstrap tips", () => {
  it("does not auto-rotate with reduced motion, including a changed preference", () => {
    motion = true;
    render(<BootstrapWaitNote slow={false} />);
    advance();
    expect(screen.getByText("BOARDWALK TIP NO. 1")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    act(() => { motion = false; motionListeners.forEach((listener) => listener()); });
    advance();
    expect(screen.getByText("BOARDWALK TIP NO. 2")).toBeInTheDocument();
    act(() => { motion = true; motionListeners.forEach((listener) => listener()); });
    advance();
    expect(screen.getByText("BOARDWALK TIP NO. 2")).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the real checklist and slow status while stopping tips at eight seconds", () => {
    render(<BootstrapView stage="admission" />);
    const states = () => screen.getAllByRole("listitem").map((step) => step.getAttribute("data-state"));
    expect(states()).toEqual(["done", "active", "pending", "pending"]);
    advance();
    expect(screen.getByText("BOARDWALK TIP NO. 2")).toBeInTheDocument();
    expect(states()).toEqual(["done", "active", "pending", "pending"]);
    advance(3500);
    expect(screen.getByText(/taking longer than usual/)).toHaveAttribute("role", "status");
    advance();
    expect(screen.getByText("BOARDWALK TIP NO. 2")).toBeInTheDocument();
    expect(states()).toEqual(["done", "active", "pending", "pending"]);
    expect(vi.getTimerCount()).toBe(0);
  });

});
