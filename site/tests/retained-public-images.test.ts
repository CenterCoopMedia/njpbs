// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { freezeRetainedPublicImages, installRetainedPublicImages } from "../scripts/retained-public-images";

let directory: string;
const identity = { buildBatchId: `post-background-${"1".repeat(20)}-${"a".repeat(64)}`, commitSha: "b".repeat(40) };
const urls = ["https://media.njpbs.org/cms-media/fixture/original.webp", "https://njpbs.org/brand/spotlight/watch.jpg"];
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "retained-images-"));
  await writeFile(path.join(directory, "input.json"), JSON.stringify({
    posts: [{ slug: "offline-post", blocks: [{ id: "signup", type: "newsletter_signup", visible: true, data: { newsletterIds: ["cms", "brand"] } }],
      assets: { unused: { url: "https://media.njpbs.org/cms-media/fixture/unused-body.webp", mimeType: "image/webp", width: 640, height: 360 } } }],
    recordCards: urls.map((url, index) => ({ kind: "newsletter", id: index ? "brand" : "cms", newsletter: {
      card: { signupUrl: "https://example.test/join", imageAssetId: index ? "brand" : "cms" },
      image: { url, mimeType: index ? "image/jpeg" : "image/webp", width: 640, height: 360 },
    } })),
  }));
  for (const file of ["launch-media-manager.json", "spotlight-news.json", "schedule.json"]) await writeFile(path.join(directory, file), "{}");
});
afterEach(async () => { vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });
const online = () => vi.fn(async (url: string | URL | Request) => new Response(String(url).endsWith(".jpg") ? "brand-bytes" : "cms-bytes", { headers: { "content-type": String(url).endsWith(".jpg") ? "image/jpeg" : "image/webp" } }));

it("freezes a Post's remote CMS image and brand JPG and replays the original bytes without the provider", async () => {
  const provider = online();
  const files = await freezeRetainedPublicImages(directory, identity, provider);
  expect(files).toHaveLength(3);
  expect(provider.mock.calls.map(([url]) => url)).toEqual([...urls].sort());
  const network = vi.fn(async () => { throw new Error("No network in retained replay"); });
  vi.stubGlobal("fetch", network);
  const restore = await installRetainedPublicImages(path.join(directory, "remote-images.json"), identity);
  try {
    expect(await (await fetch(new Request(urls[0]))).text()).toBe("cms-bytes");
    expect(await (await fetch(urls[1])).text()).toBe("brand-bytes");
    await expect(fetch("https://media.njpbs.org/cms-media/fixture/not-retained.webp")).rejects.toThrow("missing from retained input");
    expect(network).not.toHaveBeenCalled();
  } finally { restore(); }
  expect(globalThis.fetch).toBe(network);
});

it("rejects changed bytes and another source before installing a fetch adapter", async () => {
  await freezeRetainedPublicImages(directory, identity, online());
  const manifestPath = path.join(directory, "remote-images.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await expect(installRetainedPublicImages(manifestPath, { ...identity, commitSha: "c".repeat(40) })).rejects.toThrow("identity differs");
  await writeFile(path.join(directory, manifest.images[0].file), "wrong bytes");
  await expect(installRetainedPublicImages(manifestPath, identity)).rejects.toThrow(/file|bytes differ/);
});

it("refuses redirects outside the public image allowlist without fetching their destination", async () => {
  const provider = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/metadata" } }));
  await expect(freezeRetainedPublicImages(directory, identity, provider)).rejects.toThrow("outside the allowlist");
  expect(provider).toHaveBeenCalledOnce();
});

it("refuses credential-bearing or mutable image URLs instead of falling through to the network", async () => {
  await freezeRetainedPublicImages(directory, identity, online());
  const network = vi.fn(async () => new Response("must not fetch"));
  vi.stubGlobal("fetch", network);
  const restore = await installRetainedPublicImages(path.join(directory, "remote-images.json"), identity);
  try {
    await expect(fetch(`${urls[0]}?token=synthetic-token`)).rejects.toThrow("Invalid retained public image URL");
    expect(network).not.toHaveBeenCalled();
  } finally { restore(); }
  const input = JSON.parse(await readFile(path.join(directory, "input.json"), "utf8"));
  input.recordCards[0].newsletter.image.url = `${urls[0]}?token=synthetic-token`;
  await writeFile(path.join(directory, "input.json"), JSON.stringify(input));
  const provider = online();
  await expect(freezeRetainedPublicImages(directory, identity, provider)).rejects.toThrow("credentials or mutable arguments");
  expect(provider).not.toHaveBeenCalled();
});

it("rejects non-image and over-bound responses before committing the image catalog", async () => {
  await expect(freezeRetainedPublicImages(directory, identity, vi.fn(async () => new Response("error body", { headers: { "content-type": "text/plain" } }))))
    .rejects.toThrow("MIME type differs");
  const large = new Response(new Uint8Array(25 * 1024 * 1024 + 1), { headers: { "content-type": "image/webp" } });
  await expect(freezeRetainedPublicImages(directory, identity, vi.fn(async () => large))).rejects.toThrow("checkpoint bound");
  await expect(readFile(path.join(directory, "remote-images.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("excludes unused Post originals even when their count exceeds the optimizer catalog bound", async () => {
  await writeFile(path.join(directory, "input.json"), JSON.stringify({ posts: [{ blocks: [], assets: Object.fromEntries(
    Array.from({ length: 300 }, (_, index) => [String(index), { url: `https://media.njpbs.org/cms-media/fixture/unused-${index}.webp`, mimeType: "image/webp", width: 640, height: 360 }]),
  ) }] }));
  const provider = online();
  expect(await freezeRetainedPublicImages(directory, identity, provider)).toEqual(["remote-images.json"]);
  expect(provider).not.toHaveBeenCalled();
});

it("gives the next image a fresh deadline after a completed image's signal expires", async () => {
  const controllers: AbortController[] = [];
  const deadlines = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    const controller = new AbortController(); controllers.push(controller); return controller.signal;
  });
  const provider = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new Error("Previous image deadline was reused");
    const response = new Response("complete-image", { headers: { "content-type": "image/webp" } });
    if (provider.mock.calls.length === 1) controllers[0].abort();
    return response;
  });
  try {
    await freezeRetainedPublicImages(directory, identity, provider);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(deadlines).toHaveBeenCalledTimes(2);
    expect(provider.mock.calls[0][1]?.signal).not.toBe(provider.mock.calls[1][1]?.signal);
    expect(deadlines).toHaveBeenCalledWith(120_000);
  } finally { deadlines.mockRestore(); }
});
