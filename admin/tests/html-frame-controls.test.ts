import { afterEach, describe, expect, it } from "vitest";
import {
  HTML_FRAME_HEIGHT_MESSAGE,
  installHtmlFrameControls,
} from "../../packages/content-core/src/html-frame-controls";

describe("installHtmlFrameControls", () => {
  let dispose = () => {};
  afterEach(() => {
    dispose();
    document.body.innerHTML = "";
  });

  function setup() {
    document.body.innerHTML = '<iframe data-html-frame></iframe><iframe data-html-frame></iframe><iframe></iframe>';
    const [first, second, unmarked] = Array.from(document.querySelectorAll("iframe"));
    dispose = installHtmlFrameControls(window);
    const post = (frame: HTMLIFrameElement, height: unknown) =>
      window.dispatchEvent(new MessageEvent("message", {
        data: { [HTML_FRAME_HEIGHT_MESSAGE]: height },
        source: frame.contentWindow,
      }));
    return { first, second, unmarked, post };
  }

  it("resizes only the marked frame that sent the height, within bounds", () => {
    const { first, second, unmarked, post } = setup();
    post(first, 320.2);
    expect(first.style.height).toBe("321px");
    expect(second.style.height).toBe("");
    post(unmarked, 500);
    expect(unmarked.style.height).toBe("");
    post(second, 5);
    expect(second.style.height).toBe("40px");
    post(second, 1e9);
    expect(second.style.height).toBe("20000px");
    post(second, "900");
    expect(second.style.height).toBe("20000px");
  });
});
