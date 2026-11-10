import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountPostShareControls } from "../src/lib/post-share-dom";

function controls(id: string): HTMLElement {
  const root = document.createElement("section");
  root.dataset.postShare = "";
  root.dataset.postShareTitle = `Story ${id}`;
  root.dataset.postShareUrl = `https://njpbs.org/posts/${id}/`;
  root.innerHTML = `
    <details data-post-share-disclosure>
      <summary data-post-share-summary>Share this post</summary>
      <a href="mailto:?subject=Story">Email</a>
      <a href="https://www.facebook.com/sharer/sharer.php">Facebook</a>
      <a href="https://x.com/intent/tweet">X</a>
      <a href="https://www.linkedin.com/sharing/share-offsite/">LinkedIn</a>
      <button type="button" data-post-share-copy hidden>Copy link</button>
      <button type="button" data-post-share-native hidden>Share with device</button>
    </details>
    <p role="status" aria-live="polite" data-post-share-status></p>
    <label data-post-share-fallback hidden>
      Article URL
      <input data-post-share-fallback-url readonly value="https://njpbs.org/posts/${id}/">
    </label>
  `;
  document.body.append(root);
  return root;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("post share controls", () => {
  it("keeps link actions functional and hides script-only actions before mounting", () => {
    const root = controls("no-script");
    const links = [...root.querySelectorAll<HTMLAnchorElement>("a")];
    const copy = root.querySelector<HTMLButtonElement>("[data-post-share-copy]")!;

    expect(links).toHaveLength(4);
    expect(links.every((link) => link.href !== "")).toBe(true);
    expect(copy.hidden).toBe(true);

    mountPostShareControls(root, {});
    expect(copy.hidden).toBe(false);
  });

  it("copies the canonical URL and announces success", async () => {
    const root = controls("one");
    const writeText = vi.fn().mockResolvedValue(undefined);

    mountPostShareControls(root, { clipboard: { writeText } });
    root.querySelector<HTMLButtonElement>("[data-post-share-copy]")?.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());

    expect(writeText).toHaveBeenCalledWith("https://njpbs.org/posts/one/");
    expect(root.querySelector("[data-post-share-status]")?.textContent).toBe(
      "Link copied.",
    );
    expect(
      root.querySelector("[data-post-share-fallback]")?.hasAttribute("hidden"),
    ).toBe(true);
  });

  it("reveals a selectable canonical URL when clipboard access fails", async () => {
    const root = controls("one");
    const input = root.querySelector<HTMLInputElement>("[data-post-share-fallback-url]")!;
    const select = vi.spyOn(input, "select");

    mountPostShareControls(root, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    root.querySelector<HTMLButtonElement>("[data-post-share-copy]")?.click();
    await vi.waitFor(() => expect(select).toHaveBeenCalled());

    expect(root.querySelector("[data-post-share-status]")?.textContent).toBe(
      "Copy failed. Select and copy the article URL.",
    );
    expect(
      root.querySelector("[data-post-share-fallback]")?.hasAttribute("hidden"),
    ).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it("keeps native sharing hidden unless the browser supports it", async () => {
    const unsupported = controls("unsupported");
    mountPostShareControls(unsupported, {});
    expect(
      unsupported.querySelector("[data-post-share-native]")?.hasAttribute("hidden"),
    ).toBe(true);

    const supported = controls("supported");
    const share = vi.fn().mockResolvedValue(undefined);
    mountPostShareControls(supported, { share });
    const button = supported.querySelector<HTMLButtonElement>(
      "[data-post-share-native]",
    )!;
    expect(button.hasAttribute("hidden")).toBe(false);

    button.click();
    await vi.waitFor(() => expect(share).toHaveBeenCalled());
    expect(share).toHaveBeenCalledWith({
      title: "Story supported",
      url: "https://njpbs.org/posts/supported/",
    });
  });

  it("offers the canonical URL when native sharing fails", async () => {
    const root = controls("failed-share");
    const input = root.querySelector<HTMLInputElement>("[data-post-share-fallback-url]")!;
    const select = vi.spyOn(input, "select");
    mountPostShareControls(root, {
      share: vi.fn().mockRejectedValue(new Error("share target unavailable")),
    });

    root.querySelector<HTMLButtonElement>("[data-post-share-native]")?.click();
    await vi.waitFor(() => expect(select).toHaveBeenCalled());

    expect(root.querySelector("[data-post-share-status]")?.textContent).toBe(
      "Sharing was not completed. Copy the link instead.",
    );
    expect(input.value).toBe("https://njpbs.org/posts/failed-share/");
  });

  it("clears stale feedback when a later native share succeeds", async () => {
    const root = controls("share-retry");
    const share = vi
      .fn()
      .mockRejectedValueOnce(new Error("target unavailable"))
      .mockResolvedValueOnce(undefined);
    mountPostShareControls(root, { share });
    const button = root.querySelector<HTMLButtonElement>(
      "[data-post-share-native]",
    )!;

    button.click();
    await vi.waitFor(() =>
      expect(
        root.querySelector("[data-post-share-status]")?.textContent,
      ).toMatch(/not completed/i),
    );
    button.click();
    await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(root.querySelector("[data-post-share-status]")?.textContent).toBe(
        "",
      ),
    );

    expect(
      root.querySelector<HTMLElement>("[data-post-share-fallback]")?.hidden,
    ).toBe(true);
  });

  it("keeps share-sheet cancellation silent", async () => {
    const root = controls("cancelled-share");
    const share = vi
      .fn()
      .mockRejectedValue(new DOMException("cancel", "AbortError"));
    mountPostShareControls(root, { share });

    root.querySelector<HTMLButtonElement>("[data-post-share-native]")?.click();
    await vi.waitFor(() => expect(share).toHaveBeenCalled());

    expect(root.querySelector("[data-post-share-status]")?.textContent).toBe(
      "",
    );
    expect(
      root.querySelector<HTMLElement>("[data-post-share-fallback]")?.hidden,
    ).toBe(true);
  });

  it("closes the disclosure with Escape and returns focus to its trigger", () => {
    const root = controls("escape");
    mountPostShareControls(root, {});
    const disclosure = root.querySelector<HTMLDetailsElement>(
      "[data-post-share-disclosure]",
    )!;
    const summary = root.querySelector<HTMLElement>(
      "[data-post-share-summary]",
    )!;
    disclosure.open = true;

    disclosure.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );

    expect(disclosure.open).toBe(false);
    expect(document.activeElement).toBe(summary);
  });

  it("closes the disclosure after an outside click", () => {
    const root = controls("outside");
    mountPostShareControls(root, {});
    const disclosure = root.querySelector<HTMLDetailsElement>(
      "[data-post-share-disclosure]",
    )!;
    const outside = document.createElement("button");
    document.body.append(outside);
    disclosure.open = true;

    outside.click();

    expect(disclosure.open).toBe(false);
  });

  it("mounts two placements without sharing status or state", async () => {
    const first = controls("one");
    const second = controls("two");
    const writeText = vi.fn().mockResolvedValue(undefined);

    mountPostShareControls(first, { clipboard: { writeText } });
    mountPostShareControls(second, { clipboard: { writeText } });
    second.querySelector<HTMLButtonElement>("[data-post-share-copy]")?.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());

    expect(writeText).toHaveBeenCalledWith("https://njpbs.org/posts/two/");
    expect(first.querySelector("[data-post-share-status]")?.textContent).toBe("");
    expect(second.querySelector("[data-post-share-status]")?.textContent).toBe(
      "Link copied.",
    );
  });
});
