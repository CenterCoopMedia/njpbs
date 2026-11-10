// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const script = readFileSync(new URL("../src/internal/name-atlas/bridge.js", import.meta.url), "utf8");

function harness(role: "parent" | "reader", hash = "") {
  const listeners: Record<string, ((event: any) => void)[]> = {};
  const peer = { postMessage: vi.fn() };
  const location = new URL(`https://dev-public.example.org/atlas/${role === "reader" ? "reader/" : ""}${hash}`);
  const frame = { contentWindow: peer, src: "" };
  const link = { href: "" };
  const history = {
    state: { preserved: true },
    pushState: vi.fn((_state: unknown, _title: string, value: string) => { location.href = new URL(value, location).href; }),
    replaceState: vi.fn((_state: unknown, _title: string, value: string) => { location.href = new URL(value, location).href; }),
  };
  const nativePush = history.pushState;
  const nativeReplace = history.replaceState;
  const emit = (type: string, event: any = {}) => listeners[type]?.forEach((fn) => fn(event));
  const win: any = {
    location, history, parent: role === "reader" ? peer : null,
    addEventListener: (type: string, fn: (event: any) => void) => (listeners[type] ??= []).push(fn),
    dispatchEvent: (event: any) => emit(event.type, event),
  };
  if (role === "parent") win.parent = win;
  runInNewContext(script, {
    window: win,
    document: {
      documentElement: { hasAttribute: () => role === "reader" },
      querySelector: (selector: string) => selector === "[data-name-atlas-frame]" ? (role === "parent" ? frame : null) : link,
    },
    PopStateEvent: class { constructor(public type: string) {} },
  });
  return { win, peer, frame, link, history, nativePush, nativeReplace, location, emit, listeners };
}

describe("atlas shell route bridge", () => {
  it("puts an initial town and event into the reader before it loads", () => {
    const h = harness("parent", "#town=0327&event=T1817");
    expect(h.frame.src).toBe("/atlas/reader/#town=0327&event=T1817");
    expect(h.link.href).toBe(h.frame.src);
    expect(h.history.pushState).not.toHaveBeenCalled();
  });
  it("accepts only the exact iframe and origin and a constrained hash", () => {
    const h = harness("parent");
    const event = { source: h.peer, origin: h.location.origin, data: { type: "njpbs-atlas-route", hash: "#town=2004", replace: false } };
    h.emit("message", { ...event, origin: "https://example.org" });
    h.emit("message", { ...event, source: {} });
    for (const hash of ["https://example.org/", "#town=2004&url=evil", "#town=2004&event=<script>", "#town=2004&town=0101", null]) {
      h.emit("message", { ...event, data: { ...event.data, hash } });
    }
    expect(h.history.pushState).not.toHaveBeenCalled();
    h.emit("message", event);
    expect(h.location.hash).toBe("#town=2004");
    expect(h.history.pushState).toHaveBeenCalledOnce();
    h.emit("message", event);
    expect(h.history.pushState).toHaveBeenCalledOnce();
  });
  it("forwards Back/Forward without making another history entry", () => {
    const h = harness("parent", "#town=2004");
    h.location.hash = "#town=0327&event=T1817";
    h.emit("popstate");
    expect(h.peer.postMessage).toHaveBeenCalledWith({ type: "njpbs-atlas-navigate", hash: h.location.hash }, h.location.origin);
    expect(h.history.pushState).not.toHaveBeenCalled();
    expect(h.link.href).toBe("/atlas/reader/#town=0327&event=T1817");
  });
  it("forwards reader selections with their original push/replace meaning", () => {
    const h = harness("reader");
    h.win.history.pushState(null, "", "#town=0327");
    expect(h.nativePush).not.toHaveBeenCalled();
    expect(h.nativeReplace).toHaveBeenCalledOnce();
    expect(h.peer.postMessage).toHaveBeenLastCalledWith({ type: "njpbs-atlas-route", hash: "#town=0327", replace: false }, h.location.origin);
    h.win.history.replaceState(null, "", "#town=0327&event=T1817");
    expect(h.peer.postMessage).toHaveBeenLastCalledWith({ type: "njpbs-atlas-route", hash: "#town=0327&event=T1817", replace: true }, h.location.origin);
  });
  it("applies parent navigation once, fires the reader handler, and never echoes", () => {
    const h = harness("reader", "#town=2004");
    const observer = vi.fn();
    h.win.addEventListener("popstate", observer);
    const event = { source: h.peer, origin: h.location.origin, data: { type: "njpbs-atlas-navigate", hash: "#town=0327&event=T1817" } };
    h.emit("message", { ...event, origin: "https://example.org" });
    h.emit("message", { ...event, source: {} });
    expect(observer).not.toHaveBeenCalled();
    h.emit("message", event);
    expect(h.location.hash).toBe(event.data.hash);
    expect(observer).toHaveBeenCalledOnce();
    expect(h.peer.postMessage).not.toHaveBeenCalled();
    h.emit("message", event);
    expect(observer).toHaveBeenCalledOnce();
  });
  it("returns to the default selection when Back reaches an empty hash", () => {
    const h = harness("reader", "#town=2004");
    h.emit("message", { source: h.peer, origin: h.location.origin, data: { type: "njpbs-atlas-navigate", hash: "" } });
    expect(h.location.hash).toBe("");
    expect(h.peer.postMessage).not.toHaveBeenCalled();
  });
});
