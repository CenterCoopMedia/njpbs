import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it.each(["development", "production"])("keeps production brand artwork usable in the %s preview", async environment => {
  vi.stubEnv("VITE_CMS_DEPLOYMENT_ENVIRONMENT", environment);
  vi.resetModules();
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { HomePreviewFrame } = await import("../src/components/HomePreviewFrame");
  const root = document.createElement("template");
  root.innerHTML = renderToStaticMarkup(createElement(HomePreviewFrame, { html: "", title: "Image policy" }));
  const frame = root.content.querySelector("iframe")!;
  const content = new DOMParser().parseFromString(frame.srcdoc, "text/html");
  expect(content.querySelector("base")!.getAttribute("href")).toBe(environment === "development"
    ? "https://dev-public.example.org/" : "https://njpbs.org/");
  const policy = content.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")!;
  const images = policy.split(";").find(value => value.trim().startsWith("img-src"))!.trim().split(/\s+/);
  expect(images.includes("https://njpbs.org") || images.includes("https://njpbs.org/brand/")).toBe(true);
  expect(images).not.toContain("https:");
});
