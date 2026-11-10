interface ShareNavigator {
  clipboard?: {
    writeText(value: string): Promise<void>;
  };
  share?(data: { title: string; url: string }): Promise<void>;
}

function requiredElement<T extends Element>(root: HTMLElement, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Post sharing control is missing ${selector}`);
  return element;
}

export function mountPostShareControls(
  root: HTMLElement,
  browser: ShareNavigator,
): void {
  if (root.dataset.postShareMounted === "true") return;

  const title = root.dataset.postShareTitle;
  const url = root.dataset.postShareUrl;
  if (!title || !url) throw new Error("Post sharing data is incomplete");

  const disclosure = requiredElement<HTMLDetailsElement>(
    root,
    "[data-post-share-disclosure]",
  );
  const summary = requiredElement<HTMLElement>(root, "[data-post-share-summary]");
  const copy = requiredElement<HTMLButtonElement>(root, "[data-post-share-copy]");
  const native = requiredElement<HTMLButtonElement>(root, "[data-post-share-native]");
  const status = requiredElement<HTMLElement>(root, "[data-post-share-status]");
  const fallback = requiredElement<HTMLElement>(root, "[data-post-share-fallback]");
  const fallbackUrl = requiredElement<HTMLInputElement>(
    root,
    "[data-post-share-fallback-url]",
  );

  const clearFeedback = () => {
    status.textContent = "";
    fallback.hidden = true;
  };

  const showCopyFallback = () => {
    fallback.hidden = false;
    fallbackUrl.focus();
    fallbackUrl.select();
  };

  copy.addEventListener("click", async () => {
    clearFeedback();
    try {
      if (!browser.clipboard) throw new Error("Clipboard access is unavailable");
      await browser.clipboard.writeText(url);
      fallback.hidden = true;
      status.textContent = "Link copied.";
    } catch {
      status.textContent = "Copy failed. Select and copy the article URL.";
      showCopyFallback();
    }
  });
  copy.hidden = false;

  if (typeof browser.share === "function") {
    native.hidden = false;
    native.addEventListener("click", async () => {
      clearFeedback();
      try {
        await browser.share?.({ title, url });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        status.textContent = "Sharing was not completed. Copy the link instead.";
        showCopyFallback();
      }
    });
  }

  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !disclosure.open) return;
    disclosure.open = false;
    summary.focus();
  });

  root.ownerDocument.addEventListener("click", (event) => {
    if (
      disclosure.open &&
      event.target instanceof Node &&
      !root.contains(event.target)
    ) {
      disclosure.open = false;
    }
  });

  root.dataset.postShareMounted = "true";
}
