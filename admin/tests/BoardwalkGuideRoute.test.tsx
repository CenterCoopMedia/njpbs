import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  BoardwalkGuideRoute,
  parseGuideManifest,
  parseGuideSearch,
} from "../src/routes/BoardwalkGuideRoute";
import { ShellProvider } from "../src/routes/ShellContext";

const manifest = {
  sections: [{
    id: "start-here",
    title: "Start here",
    description: "Begin with the main work areas.",
    pages: [{
      slug: "overview",
      title: "Overview",
      description: "Learn what Boardwalk controls.",
      audience: "All staff",
    }],
  }],
};

const twoPageManifest = {
  sections: [{
    ...manifest.sections[0],
    pages: [
      manifest.sections[0].pages[0],
      {
        slug: "first-session",
        title: "Your first session",
        description: "Set up the workspace.",
        audience: "New staff",
      },
    ],
  }],
};

function renderGuide(path: string, getIdToken = vi.fn(async () => "id-token")) {
  render(
    <ShellProvider value={{
      principal: { id: "staff", grants: [{ role: "staff" }] },
      user: { uid: "staff", email: "staff@example.org", displayName: "Staff" },
      userDoc: null,
      signOut: () => undefined,
      getIdToken,
    }}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/guide/:slug?" element={<BoardwalkGuideRoute />} />
        </Routes>
      </MemoryRouter>
    </ShellProvider>,
  );
  return { getIdToken };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BoardwalkGuideRoute", () => {
  it("loads the private manifest with the signed-in token", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(manifest), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);

    const { getIdToken } = renderGuide("/guide");

    expect(await screen.findByRole("heading", { name: "Instructions for Boardwalk" })).toBeVisible();
    const overviewLinks = screen.getAllByRole("link", { name: "Overview" });
    expect(overviewLinks).toHaveLength(2);
    for (const link of overviewLinks) {
      expect(link).toHaveAttribute("href", "/guide/overview");
    }
    expect(screen.getAllByRole("link", { name: "Guide home" })[0]).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(getIdToken).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      "/guide-content/manifest.json",
      expect.objectContaining({
        cache: "no-store",
        headers: { authorization: "Bearer id-token" },
      }),
    );
  });

  it("opens guide topics as a keyboard-focusable disclosure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(manifest))));
    renderGuide("/guide");
    await screen.findByRole("heading", { name: "Instructions for Boardwalk" });
    const summary = screen.getByText("Guide topics", { selector: "summary" });
    const topics = summary.closest("details")!;
    expect(topics).not.toHaveAttribute("open");
    summary.focus();
    expect(summary).toHaveFocus();
    fireEvent.click(summary);
    expect(topics).toHaveAttribute("open");
    expect(within(topics).getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/guide/overview");
  });

  it("renders sanitized Markdown and keeps guide links on the Admin host", async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path.endsWith("manifest.json")) return new Response(JSON.stringify(manifest));
      return new Response([
        "## Current work",
        "[Open roles](../access-and-roles/)",
        '<span class="sr-only">Hidden helper</span>',
        "<script>window.guideInjected = true</script>",
      ].join("\n\n"));
    });
    vi.stubGlobal("fetch", fetch);

    renderGuide("/guide/overview");

    expect(await screen.findByRole("heading", { name: "Current work" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Overview" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Open roles" })).toHaveAttribute(
      "href",
      "/guide/access-and-roles/",
    );
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText("Hidden helper")).toHaveClass("sr-only");
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it("defers an authenticated guide image until it nears the viewport", async () => {
    let intersect: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;
    class TestIntersectionObserver {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        intersect = callback;
      }
      disconnect() {}
      observe() {}
    }
    const OriginalURL = URL;
    class TestURL extends OriginalURL {
      static createObjectURL = vi.fn(() => "blob:guide-image");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    vi.stubGlobal("URL", TestURL);
    const fetch = vi.fn(async (path: string) => {
      if (path.endsWith("manifest.json")) return new Response(JSON.stringify(manifest));
      if (path.endsWith("overview.md")) return new Response([
        '<figure><a href="/images/admin-guide/home.webp">',
        '<img src="/images/admin-guide/home.webp" alt="Boardwalk home" width="1200" height="800" loading="lazy" />',
        "</a></figure>",
      ].join(""));
      return new Response(new Blob(["image"]), { headers: { "content-type": "image/webp" } });
    });
    vi.stubGlobal("fetch", fetch);

    renderGuide("/guide/overview");
    const image = await screen.findByRole("img", { name: "Boardwalk home" }, { timeout: 5_000 });
    await waitFor(() => expect(intersect).toBeTypeOf("function"));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(image).not.toHaveAttribute("src");

    await act(async () => intersect?.([{ isIntersecting: true }]));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/guide-content/images/home.webp",
      expect.objectContaining({ headers: { authorization: "Bearer id-token" } }),
    ));
    expect(await screen.findByRole("link", { name: "Boardwalk home" })).toHaveAttribute(
      "href",
      "blob:guide-image",
    );
    expect(screen.getByRole("img", { name: "Boardwalk home" })).toHaveAttribute(
      "src",
      "blob:guide-image",
    );
  });

  it("searches the staff-gated guide corpus and opens a matching heading", async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path.endsWith("manifest.json")) return new Response(JSON.stringify(manifest));
      if (path.endsWith("search.json")) return new Response(JSON.stringify({ passages: [{
        url: "/guide/overview#current-work",
        title: "Overview: Current work",
        text: "Create and review current newsroom work.",
      }] }));
      return new Response("Not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetch);
    renderGuide("/guide");

    await screen.findByRole("searchbox", { name: "Search the guide" });
    await act(async () => {});
    fireEvent.change(screen.getByRole("searchbox", { name: "Search the guide" }), { target: { value: "newsroom work" } });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/guide-content/search.json",
      expect.objectContaining({ headers: { authorization: "Bearer id-token" } }),
    ));

    expect(await screen.findByRole("link", { name: "Overview: Current work" }, { timeout: 5_000 })).toHaveAttribute(
      "href",
      "/guide/overview#current-work",
    );
    expect(screen.getByRole("status")).toHaveTextContent("1 matching sections.");
    fireEvent.click(screen.getByRole("link", { name: "Overview: Current work" }));
    expect(screen.getByRole("searchbox", { name: "Search the guide" })).toHaveValue("");
    expect(screen.queryByRole("link", { name: "Overview: Current work" })).not.toBeInTheDocument();
  });

  it("closes guide search with Escape from a result", async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path.endsWith("manifest.json")) return new Response(JSON.stringify(manifest));
      return new Response(JSON.stringify({ passages: [{
        url: "/guide/overview#current-work",
        title: "Overview: Current work",
        text: "Create and review current newsroom work.",
      }] }));
    });
    vi.stubGlobal("fetch", fetch);
    renderGuide("/guide");

    await screen.findByRole("searchbox", { name: "Search the guide" });
    await act(async () => {});
    fireEvent.change(screen.getByRole("searchbox", { name: "Search the guide" }), { target: { value: "newsroom" } });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/search\.json$/),
      expect.anything(),
    ));
    const search = screen.getByRole("searchbox", { name: "Search the guide" });
    const result = await screen.findByRole("link", { name: "Overview: Current work" }, { timeout: 5_000 });
    result.focus();
    fireEvent.keyDown(result, { key: "Escape" });

    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    expect(screen.queryByRole("link", { name: "Overview: Current work" })).not.toBeInTheDocument();
  });

  it("scrolls to a guide heading after its Markdown arrives", async () => {
    const scrollIntoView = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const fetch = vi.fn(async (path: string) => path.endsWith("manifest.json")
      ? new Response(JSON.stringify(manifest))
      : new Response("## Current work\n\nReview this section."));
    vi.stubGlobal("fetch", fetch);

    renderGuide("/guide/overview#current-work");

    expect(await screen.findByRole("heading", { name: "Current work" })).toBeVisible();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" }));
  });

  it("keeps old Markdown out and closes mobile navigation while the next page loads", async () => {
    let finishNextPage: ((response: Response) => void) | undefined;
    const nextPage = new Promise<Response>((resolve) => { finishNextPage = resolve; });
    const fetch = vi.fn(async (path: string) => {
      if (path.endsWith("manifest.json")) return new Response(JSON.stringify(twoPageManifest));
      if (path.endsWith("overview.md")) return new Response("## Current work\n\nOld page body.");
      return nextPage;
    });
    vi.stubGlobal("fetch", fetch);
    renderGuide("/guide/overview");

    expect(await screen.findByRole("heading", { name: "Current work" })).toBeVisible();
    const mobileNavigation = document.querySelector(".admin-guide-mobile-nav") as HTMLDetailsElement;
    mobileNavigation.open = true;
    fireEvent(mobileNavigation, new Event("toggle"));
    expect(mobileNavigation).toHaveAttribute("open");
    fireEvent.click(within(mobileNavigation).getByRole("link", { name: "Your first session" }));

    expect(await screen.findByRole("heading", { name: "Your first session" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Current work" })).not.toBeInTheDocument();
    expect(mobileNavigation).not.toHaveAttribute("open");

    await act(async () => finishNextPage?.(new Response("## Start writing\n\nNew page body.")));
    expect(await screen.findByRole("heading", { name: "Start writing" })).toBeVisible();
  });

  it("keeps guide navigation available when one page cannot load", async () => {
    const fetch = vi.fn(async (path: string) => path.endsWith("manifest.json")
      ? new Response(JSON.stringify(manifest))
      : new Response("Unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    renderGuide("/guide/overview");

    expect(await screen.findByText("Guide page unavailable")).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "Search the guide" })).toBeVisible();
    expect(screen.getAllByRole("link", { name: "Guide home" })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "Overview" })).toHaveLength(2);
  });

  it("rejects duplicate or malformed page entries", () => {
    expect(() => parseGuideManifest({
      sections: [{ ...manifest.sections[0], pages: [
        manifest.sections[0].pages[0],
        manifest.sections[0].pages[0],
      ] }],
    })).toThrow("The guide index is invalid.");
    expect(() => parseGuideManifest({ sections: [{ ...manifest.sections[0], id: "../bad" }] }))
      .toThrow("The guide index is invalid.");
    expect(() => parseGuideSearch({ passages: [{
      url: "https://dev-public.example.org/admin/docs/overview/",
      title: "Old guide",
      text: "Private content",
    }] })).toThrow("The guide search index is invalid.");
  });

  it("plays a guide video only after a signed-in request", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:guide-video");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const fetch = vi.fn(async (path: string) => {
      if (String(path).endsWith("manifest.json")) return new Response(JSON.stringify(manifest));
      if (String(path).endsWith(".jpg")) return new Response(new Blob(["poster"]));
      if (String(path).endsWith(".mp4")) return new Response(new Blob(["video"]));
      return new Response([
        '<figure class="admin-docs-video">',
        '<video autoplay preload="auto" src="/guide-content/videos/broadcast-schedule.mp4" aria-label="Read the broadcast schedule"></video>',
        "</figure>",
        "",
        "<details><summary>Transcript: Read the broadcast schedule</summary><p>Coverage dates</p></details>",
      ].join("\n"));
    });
    vi.stubGlobal("fetch", fetch);
    renderGuide("/guide/overview");

    const button = await screen.findByRole("button", { name: "Play Read the broadcast schedule" });
    await waitFor(() => expect(button).toBeEnabled());
    const video = document.querySelector("video");
    expect(video).toHaveAttribute("preload", "none");
    expect(video).not.toHaveAttribute("autoplay");
    expect(video).not.toHaveAttribute("src");
    expect(play).not.toHaveBeenCalled();
    expect(screen.getByText("Transcript: Read the broadcast schedule")).toBeVisible();

    fireEvent.click(button);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/guide-content/videos/broadcast-schedule.mp4",
      expect.objectContaining({
        cache: "no-store",
        headers: { authorization: "Bearer id-token" },
      }),
    ));
    await waitFor(() => expect(video).toHaveAttribute("src", "blob:guide-video"));
    expect(play).toHaveBeenCalledOnce();
  });

  it("gives an admitted player the private video address without starting it", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const listeners = new Set<(event: Event) => void>();
    const worker = {
      scriptURL: "https://admin.njpbs.org/guide-video-sw.js",
      postMessage(data?: { type?: string }) {
        if (data?.type !== "guide-video-protocol") return;
        for (const listener of listeners) {
          listener(new MessageEvent("message", { data: { type: "guide-video-protocol", version: 2 } }));
        }
      },
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        controller: worker,
        ready: Promise.resolve({ active: worker }),
        register: vi.fn(async () => ({ active: worker })),
        addEventListener: (_type: string, listener: (event: Event) => void) => {
          listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: (event: Event) => void) => {
          listeners.delete(listener);
        },
      },
    });
    const fetch = vi.fn(async (path: string) => {
      if (String(path).endsWith("manifest.json")) return new Response(JSON.stringify(manifest));
      return new Response([
        '<figure class="admin-docs-video">',
        '<video src="/guide-content/videos/broadcast-schedule.mp4" aria-label="Read the broadcast schedule"></video>',
        "</figure>",
      ].join("\n"));
    });
    vi.stubGlobal("fetch", fetch);
    renderGuide("/guide/overview");

    const video = await screen.findByLabelText("Read the broadcast schedule");
    await waitFor(() => expect(video).toHaveAttribute(
      "src",
      "/guide-content/videos/broadcast-schedule.mp4",
    ));
    expect(video).toHaveAttribute("preload", "none");
    expect(video).toHaveAttribute("controls");
    expect(navigator.serviceWorker.register).toHaveBeenCalledWith("/guide-video-sw.js", { scope: "/guide" });
    expect(video).not.toHaveAttribute("autoplay");
    expect(play).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Play Read the broadcast schedule" })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalledWith(
      "/guide-content/videos/broadcast-schedule.mp4",
      expect.anything(),
    );

    fireEvent.error(video);
    const button = await screen.findByRole("button", { name: "Play Read the broadcast schedule" });
    expect(screen.getByRole("alert")).toHaveTextContent("could not stream");
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:guide-video");
    fireEvent.click(button);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/guide-content/videos/broadcast-schedule.mp4",
      expect.objectContaining({
        headers: { authorization: "Bearer id-token" },
      }),
    ));
  });
});
