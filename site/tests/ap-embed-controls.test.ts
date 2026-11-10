import { afterEach, describe, expect, it, vi } from "vitest";
import { installApEmbedControls } from "../../packages/content-core/src/ap-embed-controls";

const origin = "https://interactives.apelections.org";
const url = `${origin}/election-results/customers/layouts/organization-layouts/published/111593/37217.html`;
let dispose = () => {};
afterEach(() => { dispose(); vi.restoreAllMocks(); document.body.innerHTML = ""; });

function mount() {
  document.body.innerHTML = `<iframe srcdoc="AP fixture" class="election-map__frame" src="${url}" height="1200" style="--ap-map-mobile-height:1700px"></iframe><iframe srcdoc="AP fixture" class="election-map__frame" src="${url.replace("37217", "41950")}" height="900"></iframe>`;
  const frames = Array.from(document.querySelectorAll("iframe"));
  frames.forEach(frame => vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {}));
  dispose = installApEmbedControls(window);
  return frames;
}
function send(frame: HTMLIFrameElement, data: unknown, messageOrigin = origin) {
  window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin: messageOrigin, data }));
}

describe("AP layout message protocol", () => {
  it("fits only the sending frame, including later growth and shrinkage", () => {
    const [first, second] = mount();
    send(first, { type: "embed-size", height: 919.2 });
    expect(first.style.height).toBe("920px");
    expect(first.scrolling).toBe("no");
    expect(second.style.height).toBe("");
    expect(second.scrolling).not.toBe("no");
    expect(first.style.getPropertyValue("--ap-map-mobile-height")).toBe("1700px");
    send(first, { type: "embed-size", height: 1511 });
    expect(first.style.height).toBe("1511px");
    send(first, { type: "embed-size", height: 908 });
    expect(first.style.height).toBe("908px");
  });

  it("requires both the exact AP origin and the registered source window", () => {
    const [first] = mount();
    send(first, { type: "embed-size", height: 700 }, `${origin}.example.test`);
    window.dispatchEvent(new MessageEvent("message", { source: window, origin, data: { type: "embed-size", height: 700 } }));
    expect(first.style.height).toBe("");
    expect(first.scrolling).not.toBe("no");
  });

  it.each([null, "919", {}, { type: "other", height: 919 }, ...["919", NaN, Infinity, -1, 0, 20_001].map(height => ({ type: "embed-size", height }))])("keeps the authored fallback for malformed or unsafe size messages: %j", data => {
    const [first] = mount();
    send(first, data);
    expect(first.style.height).toBe("");
    expect(first.height).toBe("1200");
  });

  it("queries on installation and frame load, echoes domain requests only to AP, and cleans up", () => {
    document.body.innerHTML = `<iframe srcdoc="AP fixture" class="election-map__frame" src="${url}"></iframe>`;
    const frame = document.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    dispose = installApEmbedControls(window);
    expect(post).toHaveBeenCalledWith({ type: "embed-size-query" }, origin);
    post.mockClear();
    frame.dispatchEvent(new Event("load"));
    expect(post).toHaveBeenCalledWith({ type: "embed-size-query" }, origin);
    post.mockClear();
    send(frame, { type: "domain-request" }, "https://example.test");
    expect(post).not.toHaveBeenCalled();
    send(frame, { type: "domain-request" });
    expect(post).toHaveBeenCalledWith({ type: "domain-request" }, origin);
    dispose();
    post.mockClear();
    frame.dispatchEvent(new Event("load"));
    send(frame, { type: "domain-request" });
    send(frame, { type: "embed-size", height: 919 });
    expect(post).not.toHaveBeenCalled();
    expect(frame.style.height).toBe("");
  });

  it("does not admit an invalid initial URL or a frame navigated outside the approved layout path", () => {
    document.body.innerHTML = `<iframe srcdoc="AP fixture" class="election-map__frame" src="${origin}/other.html"></iframe>`;
    const invalid = document.querySelector("iframe")!;
    dispose = installApEmbedControls(window);
    send(invalid, { type: "embed-size", height: 919 });
    expect(invalid.style.height).toBe("");
    dispose();
    const [first] = mount();
    first.src = `${url}?unapproved=true`;
    send(first, { type: "embed-size", height: 919 });
    expect(first.style.height).toBe("");
  });
});
