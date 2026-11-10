import { afterEach, describe, expect, it } from "vitest";
import { escapeSearchAction, mediaShortcut } from "../src/lib/media-search";

function keyEvent(key: string, target: EventTarget, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

afterEach(() => { document.body.innerHTML = ""; });

describe("media search shortcuts", () => {
  it("focuses search on / outside text entry", () => {
    const button = document.createElement("button");
    document.body.append(button);
    expect(mediaShortcut(keyEvent("/", button), document)).toBe("focus-search");
    expect(mediaShortcut(keyEvent("/", document.body), document)).toBe("focus-search");
  });

  it("ignores / with a modifier, a repeat, a prevented event, text entry, or an open modal dialog or media popover", () => {
    const button = document.createElement("button");
    document.body.append(button);
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true }]) {
      expect(mediaShortcut(keyEvent("/", button, init), document)).toBeNull();
    }
    const prevented = keyEvent("/", button);
    prevented.preventDefault();
    expect(mediaShortcut(prevented, document)).toBeNull();

    for (const tag of ["input", "textarea", "select"]) {
      const field = document.createElement(tag);
      document.body.append(field);
      expect(mediaShortcut(keyEvent("/", field), document)).toBeNull();
    }
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    document.body.append(editable);
    expect(mediaShortcut(keyEvent("/", editable), document)).toBeNull();

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    expect(mediaShortcut(keyEvent("/", button), document)).toBeNull();
    dialog.remove();

    const popover = document.createElement("div");
    popover.className = "ui-popover";
    document.body.append(popover);
    expect(mediaShortcut(keyEvent("/", button), document)).toBeNull();
    popover.remove();

    const quickLook = document.createElement("div");
    quickLook.className = "media-quick-look";
    document.body.append(quickLook);
    expect(mediaShortcut(keyEvent("/", button), document)).toBeNull();
    expect(mediaShortcut(keyEvent("V", button, { shiftKey: true }), document)).toBeNull();
  });

  it("reads the real target through composedPath()[0] so a slash typed in a shadow-root field is left alone", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const field = host.attachShadow({ mode: "open" }).appendChild(document.createElement("input"));
    const event = keyEvent("/", host);
    Object.defineProperty(event, "composedPath", { value: () => [field, host, document.body] });
    expect(mediaShortcut(event, document)).toBeNull();
  });

  it("opens Display on Shift+V under the same guards", () => {
    const button = document.createElement("button");
    const input = document.createElement("input");
    document.body.append(button, input);
    expect(mediaShortcut(keyEvent("V", button, { shiftKey: true }), document)).toBe("open-display");
    expect(mediaShortcut(keyEvent("V", input, { shiftKey: true }), document)).toBeNull();
    expect(mediaShortcut(keyEvent("v", button), document)).toBeNull();
  });

  it("on Escape clears and commits when details are saved, clears only the draft while details are unsaved, and blurs an empty field", () => {
    expect(escapeSearchAction("studio", false)).toBe("clear-and-commit");
    expect(escapeSearchAction("studio", true)).toBe("clear-draft");
    expect(escapeSearchAction("", false)).toBe("blur");
    expect(escapeSearchAction("", true)).toBe("blur");
  });
});
