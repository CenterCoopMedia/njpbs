import { describe, it, expect, beforeEach, vi } from "vitest";
import { createModalDialog } from "../src/lib/dialog";

// The dialog controller is the shared modal behaviour every overlay (donate,
// newsletter, member gating, the report form) routes through, so these tests
// prove the ARIA APG modal contract it promises: focus moves in on open, Escape
// and the close affordances dismiss, and focus returns to the exact trigger on
// close so a keyboard or screen-reader user is never stranded (WCAG 2.1.2, 4.1.2).
// Runs in the default happy-dom environment (a real HTMLDialogElement with
// showModal/close and the close event).

function el(
  tag: string,
  attrs: Record<string, string> = {},
  ...children: Array<Node | string>
): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  for (const child of children) node.append(child);
  return node;
}

function mount(inner?: HTMLElement[]): {
  dialog: HTMLDialogElement;
  trigger: HTMLButtonElement;
} {
  const trigger = el("button", { id: "trigger" }, "Open") as HTMLButtonElement;
  const dialog = el(
    "dialog",
    { id: "dlg", "aria-labelledby": "dlg-title" },
    el("h2", { id: "dlg-title" }, "Newsletter"),
    ...(inner ?? [el("input", { id: "email", type: "email" })]),
    el("button", { type: "button", "data-dialog-close": "", "aria-label": "Close" }, "x"),
  ) as HTMLDialogElement;
  document.body.append(trigger, dialog);
  return { dialog, trigger };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("createModalDialog", () => {
  it("opens the dialog and moves focus to the first focusable control", () => {
    const { dialog, trigger } = mount();
    const modal = createModalDialog(dialog);
    modal.open(trigger);
    expect(dialog.open).toBe(true);
    expect(modal.isOpen).toBe(true);
    // The email input precedes the close button in document order, so it wins
    // initial focus -- not the leading heading (not focusable) or the browser's
    // default of the first control.
    expect(document.activeElement).toBe(document.querySelector("#email"));
  });

  it("honors an explicit initialFocus selector", () => {
    const { dialog, trigger } = mount();
    const modal = createModalDialog(dialog, { initialFocus: "[data-dialog-close]" });
    modal.open(trigger);
    expect(document.activeElement).toBe(dialog.querySelector("[data-dialog-close]"));
  });

  it("ignores an initialFocus target that is hidden and falls back to the first usable control", () => {
    // A caller can pass an initialFocus selector that a responsive or conditional
    // state has hidden. Focusing it would no-op and leave focus unplaced, so the
    // controller must fall back to the first usable control instead of trusting
    // the selector blindly.
    const { dialog, trigger } = mount([
      el("input", { id: "buried", type: "text", hidden: "" }),
      el("input", { id: "real", type: "text" }),
    ]);
    const modal = createModalDialog(dialog, { initialFocus: "#buried" });
    modal.open(trigger);
    expect(document.activeElement).toBe(document.querySelector("#real"));
  });

  it("honors an initialFocus target with tabindex=-1 (the APG heading pattern)", () => {
    // The APG pattern for large or structured dialogs sets initial focus on a
    // static heading/intro block carrying tabindex="-1". That is not a tab stop
    // but is programmatically focusable, so an explicit initialFocus must accept
    // it rather than fall back to the first tab stop.
    const intro = el("h2", { id: "intro", tabindex: "-1" }, "Newsletter");
    const { dialog, trigger } = mount([intro, el("input", { id: "real", type: "text" })]);
    const modal = createModalDialog(dialog, { initialFocus: "#intro" });
    modal.open(trigger);
    expect(document.activeElement).toBe(document.querySelector("#intro"));
  });

  it("skips a control disabled by an ancestor fieldset when choosing initial focus", () => {
    // A control inside <fieldset disabled> is disabled by the ancestor without
    // its own disabled attribute, so it still matches the focusable selector.
    // .focus() no-ops on an actually-disabled control, so it must not win initial
    // focus over the first usable control.
    const fs = el("fieldset", { disabled: "" }, el("input", { id: "in-fs", type: "text" }));
    const { dialog, trigger } = mount([fs, el("input", { id: "real", type: "text" })]);
    const modal = createModalDialog(dialog);
    modal.open(trigger);
    expect(document.activeElement).toBe(document.querySelector("#real"));
  });

  it("skips hidden and aria-hidden fields when choosing initial focus", () => {
    const { dialog, trigger } = mount([
      el("div", { "aria-hidden": "true" }, el("input", { id: "honeypot" })),
      el("input", { id: "real" }),
    ]);
    const modal = createModalDialog(dialog);
    modal.open(trigger);
    expect(document.activeElement).toBe(document.querySelector("#real"));
  });

  it("returns focus to the passed trigger on close", () => {
    const { dialog, trigger } = mount();
    const modal = createModalDialog(dialog);
    modal.open(trigger);
    modal.close();
    expect(dialog.open).toBe(false);
    expect(modal.isOpen).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("falls back to the element focused at open time when no trigger is passed", () => {
    const { dialog, trigger } = mount();
    const modal = createModalDialog(dialog);
    trigger.focus();
    modal.open();
    modal.close();
    expect(document.activeElement).toBe(trigger);
  });

  it("restores focus to the nearest focusable ancestor when the trigger is no longer focusable on close", () => {
    // A trigger that gets disabled after submit, or whose disclosure collapses
    // while the modal is open, is still connected but can no longer take focus.
    // Restoring to it would no-op and strand the keyboard user on <body>, so
    // focus must land on the nearest focusable ancestor instead. happy-dom honors
    // `disabled` for focus (but not display:none, which needs layout), so a
    // disabled trigger is the reliable stand-in for the unfocusable case here.
    const { dialog } = mount();
    const wrapper = el("div", { id: "wrap", tabindex: "0" });
    const opener = el("button", { id: "opener" }, "Open") as HTMLButtonElement;
    wrapper.append(opener);
    document.body.append(wrapper);
    const modal = createModalDialog(dialog);
    modal.open(opener);
    opener.disabled = true;
    modal.close();
    expect(document.activeElement).toBe(wrapper);
  });

  it("Escape closes the dialog and restores focus (never an inescapable trap)", () => {
    const { dialog, trigger } = mount();
    const modal = createModalDialog(dialog);
    modal.open(trigger);
    dialog.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("dismisses on a data-dialog-close click", () => {
    const { dialog, trigger } = mount();
    const modal = createModalDialog(dialog);
    modal.open(trigger);
    dialog.querySelector<HTMLElement>("[data-dialog-close]")!.click();
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("prevents a data-dialog-close button from submitting its enclosing form", () => {
    // A bare <button data-dialog-close> inside a <form> defaults to type=submit,
    // so the dismiss click would also submit the form unless the controller
    // suppresses the default. The dialog covers form-backed overlays (newsletter,
    // the report form), so the close affordance must be submit-safe.
    const closeBtn = el("button", { "data-dialog-close": "", "aria-label": "Close" }, "x");
    const dialog = el(
      "dialog",
      { id: "form-dlg", "aria-label": "Newsletter" },
      el("form", { id: "f" }, el("input", { id: "email3", type: "email" }), closeBtn),
    ) as HTMLDialogElement;
    const trigger = el("button", {}, "Open") as HTMLButtonElement;
    document.body.append(trigger, dialog);
    const modal = createModalDialog(dialog);
    modal.open(trigger);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    closeBtn.dispatchEvent(click);
    expect(dialog.open).toBe(false); // still dismisses
    expect(click.defaultPrevented).toBe(true); // and suppresses the submit default
  });

  it("dismisses on a backdrop click but not a click inside the panel", () => {
    const { dialog, trigger } = mount();
    const modal = createModalDialog(dialog);
    modal.open(trigger);
    // A click on a control inside the dialog must not dismiss.
    dialog.querySelector<HTMLElement>("#email")!.click();
    expect(dialog.open).toBe(true);
    // A click whose target is the dialog element itself is the backdrop.
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(dialog.open).toBe(false);
  });

  it("runs onOpen and onClose exactly once per cycle and is idempotent", () => {
    const { dialog, trigger } = mount();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const modal = createModalDialog(dialog, { onOpen, onClose });
    modal.open(trigger);
    modal.open(trigger); // second open is a no-op while already open
    expect(onOpen).toHaveBeenCalledTimes(1);
    modal.close();
    modal.close(); // second close is a no-op while already closed
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("warns when the dialog has no accessible name (4.1.2)", () => {
    const nameless = el("dialog", { id: "nameless" }) as HTMLDialogElement;
    document.body.append(nameless);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createModalDialog(nameless);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not warn when the dialog has an accessible name", () => {
    const { dialog } = mount();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createModalDialog(dialog);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("destroy() detaches the listeners so dismiss affordances no longer fire", () => {
    const { dialog, trigger } = mount();
    const onClose = vi.fn();
    const modal = createModalDialog(dialog, { onClose });
    modal.open(trigger);
    modal.destroy();
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true })); // backdrop
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("skips a hidden input when choosing initial focus", () => {
    // A leading <input type="hidden"> (a CSRF or tracking field) is not focusable;
    // .focus() on it is a no-op, so it must not win over the first real control.
    const { dialog, trigger } = mount([
      el("input", { id: "csrf", type: "hidden" }),
      el("input", { id: "real", type: "text" }),
    ]);
    const modal = createModalDialog(dialog);
    modal.open(trigger);
    expect(document.activeElement).toBe(document.querySelector("#real"));
  });

  it("dismisses when the click lands on an SVG icon inside a close control", () => {
    // An icon-only close button makes event.target an SVGElement -- an Element but
    // not an HTMLElement -- so the affordance must still resolve through closest().
    const { dialog, trigger } = mount();
    const closeBtn = dialog.querySelector<HTMLElement>("[data-dialog-close]")!;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    closeBtn.append(svg);
    const modal = createModalDialog(dialog);
    modal.open(trigger);
    svg.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("dismisses a click outside the dialog box but not one on the dialog's own padding", () => {
    const { dialog, trigger } = mount();
    // happy-dom has no layout, so give the dialog a real box to exercise the
    // bounds check rather than the no-layout fallback.
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({
      left: 100, top: 100, right: 300, bottom: 300, width: 200, height: 200, x: 100, y: 100,
      toJSON: () => ({}),
    } as DOMRect);
    const modal = createModalDialog(dialog);
    modal.open(trigger);
    // Target is the dialog but the pointer is inside its box (its own padding):
    // must not dismiss.
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 150, clientY: 150 }));
    expect(dialog.open).toBe(true);
    // Pointer outside the box is a genuine backdrop click: dismiss.
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    expect(dialog.open).toBe(false);
  });

  it("skips a control inside a display:none panel when choosing initial focus", () => {
    // A focusable field nested in a CSS-hidden (display:none) panel before the
    // real control cannot take focus -- .focus() no-ops there -- so it must not
    // win over the first usable control.
    const panel = el("div", {}, el("input", { id: "buried", type: "text" }));
    panel.style.display = "none";
    const { dialog, trigger } = mount([panel, el("input", { id: "real", type: "text" })]);
    const modal = createModalDialog(dialog);
    modal.open(trigger);
    expect(document.activeElement).toBe(document.querySelector("#real"));
  });

  it("warns when aria-labelledby points at a missing id (no accessible name)", () => {
    // aria-labelledby present but unresolved is still a nameless modal (4.1.2);
    // a presence-only check would wave it through.
    const orphan = el("dialog", {
      id: "orphan",
      "aria-labelledby": "does-not-exist",
    }) as HTMLDialogElement;
    document.body.append(orphan);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createModalDialog(orphan);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns when aria-label is present but blank", () => {
    const blank = el("dialog", { id: "blank", "aria-label": "   " }) as HTMLDialogElement;
    document.body.append(blank);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createModalDialog(blank);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns and does not open when showModal is unavailable without an opt-in", () => {
    // The default must not hand a keyboard/screen-reader user a non-inert "modal":
    // with no showModal the background is not trapped, so open() warns and no-ops
    // rather than hijacking the caller's real fallback (matching ReportProblem).
    const { dialog, trigger } = mount();
    (dialog as unknown as { showModal?: unknown }).showModal = undefined;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onOpen = vi.fn();
    const modal = createModalDialog(dialog, { onOpen });
    trigger.focus();
    modal.open(trigger);
    expect(warn).toHaveBeenCalled();
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(modal.isOpen).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    warn.mockRestore();
  });

  it("warns and opens non-modal when showModal is unavailable and fallbackToNonModal is set", () => {
    // The degraded overlay is still available, but only when the caller explicitly
    // opts in; it still warns, since the background is not inert.
    const { dialog, trigger } = mount();
    (dialog as unknown as { showModal?: unknown }).showModal = undefined;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const modal = createModalDialog(dialog, { fallbackToNonModal: true });
    modal.open(trigger);
    expect(warn).toHaveBeenCalled();
    expect(dialog.getAttribute("open")).toBe("");
    expect(modal.isOpen).toBe(true);
    warn.mockRestore();
  });

  it("skips a control inside an inert panel when choosing initial focus", () => {
    // An [inert] subtree (an inactive pane before the real controls) cannot take
    // focus -- .focus() no-ops there, like display:none and aria-hidden -- so a
    // control buried in it must not win initial focus over the first usable one.
    const panel = el("div", { inert: "" }, el("input", { id: "buried", type: "text" }));
    const { dialog, trigger } = mount([panel, el("input", { id: "real", type: "text" })]);
    const modal = createModalDialog(dialog);
    modal.open(trigger);
    expect(document.activeElement).toBe(document.querySelector("#real"));
  });

  it("settles close state synchronously without waiting for the queued native close event", () => {
    // In real browsers dialog.close() removes the open attribute now but queues
    // the `close` event as a later task. The controller must not depend on that
    // event for its side effects, or a same-tick caller that closes and then reads
    // isOpen (or reopens) sees the dialog as still open with focus not yet
    // restored. Model the gap by suppressing the event on close().
    const { dialog, trigger } = mount();
    const onClose = vi.fn();
    const modal = createModalDialog(dialog, { onClose });
    modal.open(trigger);
    vi.spyOn(dialog, "close").mockImplementation(() => {
      dialog.removeAttribute("open");
    });
    modal.close();
    expect(modal.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
    // When the queued native close event finally fires, it must not double-run.
    dialog.dispatchEvent(new Event("close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale native close event after a close-then-reopen", () => {
    // Round-trip hardening for the sync-close fix: dialog.close() removes the
    // open attribute now but delivers the native `close` event as a later task,
    // and reopening before it arrives must not let that stale event tear down
    // the new session. Model the gap by suppressing the event on close().
    const { dialog, trigger } = mount();
    const onClose = vi.fn();
    const modal = createModalDialog(dialog, { onClose });
    modal.open(trigger);
    const closeSpy = vi.spyOn(dialog, "close").mockImplementation(() => {
      dialog.removeAttribute("open");
    });
    modal.close();
    expect(modal.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    // Reopen before the queued close event from the first session is delivered.
    modal.open(trigger);
    expect(modal.isOpen).toBe(true);
    // The stale first-session close event finally fires; it must be ignored so
    // the reopened session stays open and onClose does not fire again.
    dialog.dispatchEvent(new Event("close"));
    expect(modal.isOpen).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    // The reopened session still closes normally.
    closeSpy.mockRestore();
    modal.close();
    expect(modal.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("exposes whether the platform supports a true modal (dialog.showModal)", () => {
    // A caller that needs a guaranteed modal can read supportsModal and handle the
    // unsupported engine itself instead of duplicating the feature detection;
    // when it is false, open() warns and does not open unless fallbackToNonModal.
    const { dialog } = mount();
    expect(createModalDialog(dialog).supportsModal).toBe(true);
    (dialog as unknown as { showModal?: unknown }).showModal = undefined;
    expect(createModalDialog(dialog).supportsModal).toBe(false);
  });
});
