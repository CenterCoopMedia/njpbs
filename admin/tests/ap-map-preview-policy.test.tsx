import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { HomePreviewFrame } from "../src/components/HomePreviewFrame";

it("permits the AP map document in Phone preview while keeping draft scripts disabled", () => {
  const root = document.createElement("template");
  root.innerHTML = renderToStaticMarkup(<HomePreviewFrame html="" title="AP map preview" interactivePlayers />);
  const frame = root.content.querySelector("iframe")!;
  const content = new DOMParser().parseFromString(frame.srcdoc, "text/html");
  const policy = content.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")!;
  const frames = policy.split(";").find(value => value.trim().startsWith("frame-src"))!.trim().split(/\s+/);
  expect(frames).toContain("https://interactives.apelections.org");
  expect(frames).not.toContain("https:");
  expect(policy).toContain("script-src 'none'");
  expect(policy).toContain("connect-src 'none'");
  expect(frame.getAttribute("sandbox")).toBe("allow-same-origin allow-scripts");
  expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
});
