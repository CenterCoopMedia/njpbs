import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaRoute, VoiceoverMediaRoute } from "../src/routes/MediaRoute";
import { ExitGuardProvider } from "../src/routes/ExitGuard";
import { NAV_DESTINATIONS } from "../src/lib/nav-destinations";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";
import { clearMediaSessionCache } from "../src/lib/media-session-cache";
import { resetMediaCategoryRegistry } from "../src/lib/use-media-categories";

const mocks = vi.hoisted(() => ({ getIdToken: vi.fn(), save: vi.fn(), fetch: vi.fn() }));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => ({ getIdToken: mocks.getIdToken }) }));
vi.mock("firebase/firestore", async importOriginal => ({ ...await importOriginal<typeof import("firebase/firestore")>(), getDoc:vi.fn(async () => ({exists:() => false})) }));

const voiceover = {
  id: "voiceover-soft-spoken-watching-station-01", name: "Watching NJ PBS", originalName: "soft-spoken-watching-station-01.wav",
  category: "news", categories: ["news"], tags: ["voiceover"], description: "Station identification", altText: "",
  credit: "Jordan Avery", license: null, mimeType: "audio/wav", kind: "audio", sizeBytes: 96044, width: null, height: null,
  url: "https://admin.njpbs.org/media/voiceovers?asset=voiceover-soft-spoken-watching-station-01", source: "voiceover",
  lifecycle: "active", version: 1, etag: '"media.fixture.1"', createdAt: null, createdBy: null, updatedAt: null, updatedBy: null,
  voiceoverTakeId: "soft-spoken-watching-station-01",
  voiceover: { manifestVersion: 1, id: "soft-spoken-watching-station-01", family_id: "watching-station", family: "Watching NJ PBS",
    take: 1, style: "soft-spoken", performer_id: "jordan-avery", performer_name: "Jordan Avery", text: "You're watching NJ PBS.",
    display_text: "You're watching NJ PBS.", complete: true, flags: [], duration_seconds: 2.1 },
};
const uploaded = { ...voiceover, id: "interview", name: "Station interview", originalName: "interview.wav", source: "upload", voiceover: undefined, voiceoverTakeId: undefined,
  url: "https://media.example.test/interview.wav" };
const review = { moreLikeThis: false, notes: "Original note", version: 1, updatedAt: null };
const shell: ShellData = { principal: { id: "reviewer-1", grants: [{ role: "admin" }] },
  user: { uid: "reviewer-1", email: "reviewer@example.test" }, userDoc: null, signOut: vi.fn() };
function mediaElement(element: ReactNode, value: ShellData = shell) { return <ShellProvider value={value}><ExitGuardProvider>{element}</ExitGuardProvider></ShellProvider>; }
function renderRoute(path = "/voiceovers", value: ShellData = shell) {
  const router = createMemoryRouter([{ path: "/voiceovers", element: mediaElement(<VoiceoverMediaRoute />, value) },
    { path: "/media/*", element: mediaElement(<MediaRoute />, value) }], { initialEntries: [path] });
  return { router, ...render(<RouterProvider router={router} />) };
}
function json(body: unknown) { return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }); }

beforeEach(() => {
  clearMediaSessionCache(); resetMediaCategoryRegistry(); localStorage.clear();
  mocks.getIdToken.mockResolvedValue("id-token"); mocks.save.mockReset(); mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (url: string, options: RequestInit) => {
    const endpoint = String(url).split("/").at(-1); const body = JSON.parse(String(options.body));
    if (endpoint === "cmsListMediaCategories") return json({success:true, categories:[{id:"news",label:"Newsroom",active:true,canUpload:true,canManage:true}]});
    if (endpoint === "cmsListMediaSources") return json({success:true, sources:[{id:"video-library",label:"Videos",description:"Staff videos",mediaKind:"video",canBrowse:true,canUpload:false}]});
    if (endpoint === "cmsListSourceMedia") return json({success:true,records:[],total:0,hasMore:false,nextCursor:null});
    if (endpoint === "cmsListMedia") return json({success:true,records:body.assetIds ? [voiceover] : [voiceover,uploaded],paging:"cursor",nextCursor:null,total:null,allCount:null,page:1,pageCount:null,categoryCounts:null,kindCounts:null,
      tabCounts:{audio:2,images:0,voiceovers:196,favorites:1,sources:{"video-library":0}}});
    if (endpoint === "cmsListMediaFavorites") return json({success:true,states:(body.refs ?? []).map((ref:unknown) => ({ref,favorite:false}))});
    if (endpoint === "cmsGetMediaReview") return json({success:true,review});
    if (endpoint === "cmsListMediaComments") return json({success:true,comments:[],nextCursor:null});
    if (endpoint === "cmsSaveMediaReview") return mocks.save(body);
    throw new Error(`Unexpected request ${endpoint}`);
  });
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("unified Audio media route", () => {
  it.each(["staff", "contributor"] as const)("keeps %s Audio reviews without granting upload or metadata management", async role => {
    mocks.save.mockResolvedValueOnce(json({success:true,review:{...review,notes:"Read-only reviewer note",version:2}}));
    renderRoute(`/voiceovers?asset=${voiceover.id}`, {...shell,principal:{id:"reviewer-1",grants:[{role,sections:["news"],registeredMediaSections:["news"]}]}});
    await screen.findByRole("heading",{name:"Audio"});
    const notes=await screen.findByRole("textbox",{name:"Notes"});
    await waitFor(() => expect(notes).toHaveValue("Original note"));
    expect(screen.queryByRole("button",{name:"Upload media"})).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox",{name:"Name"})).not.toBeInTheDocument();
    expect(screen.queryByRole("link",{name:/^Images/})).not.toBeInTheDocument();
    fireEvent.change(notes,{target:{value:"Read-only reviewer note"}});
    fireEvent.click(screen.getByRole("button",{name:"Save details"}));
    expect(await screen.findByText("Your review saved")).toBeVisible();
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).endsWith("cmsUpdateMediaMetadata") || String(url).endsWith("cmsUploadMedia"))).toBe(false);
    const listCalls=mocks.fetch.mock.calls.filter(([url]) => String(url).endsWith("cmsListMedia"));
    expect(listCalls.every(([,init]) => JSON.parse(String(init.body)).kinds?.join() === "audio")).toBe(true);
  });

  it.each(["staff", "contributor"] as const)("offers only readable active categories to %s Audio users", async role => {
    const originalFetch = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url: string, options: RequestInit) => {
      if (String(url).endsWith("cmsListMediaCategories")) return json({success:true,categories:[
        {id:"news",label:"Newsroom",active:true,canUpload:false,canManage:false},
        {id:"arts",label:"Arts",active:true,canUpload:false,canManage:false},
        {id:"retired",label:"Retired",active:false,canUpload:false,canManage:false},
      ]});
      return originalFetch(url, options);
    });
    const grants = role === "staff" ? [{role}] : [{role,sections:["news"],registeredMediaSections:["news"]}];
    renderRoute("/media/voiceovers", {...shell,principal:{id:"reviewer-1",grants}});
    await screen.findByRole("heading",{name:"Audio"});
    await screen.findByRole("button",{name:/^Watching NJ PBS/});
    fireEvent.click(screen.getByRole("button",{name:/^Filter/}));
    const filter = screen.getByRole("dialog",{name:"Filter"});
    fireEvent.click(within(filter).getByRole("button",{name:"Category"}));
    const news = within(filter).getByRole("checkbox",{name:"Newsroom"});
    expect(within(filter).getByRole("checkbox",{name:"Arts"})).toBeInTheDocument();
    expect(within(filter).queryByRole("checkbox",{name:"Retired"})).not.toBeInTheDocument();
    fireEvent.click(news);
    await waitFor(() => expect(mocks.fetch.mock.calls.some(([url,init]) =>
      String(url).endsWith("cmsListMedia") && JSON.parse(String(init.body)).categories?.join() === "news"
    )).toBe(true));
  });

  it("keeps legacy bookmarks and their asset selection in the shared Audio library", async () => {
    const {router} = renderRoute(`/voiceovers?asset=${voiceover.id}`);
    await screen.findByRole("heading", {name:"Audio"});
    expect(router.state.location.pathname).toBe("/media/voiceovers");
    expect(router.state.location.search).toContain(`asset=${voiceover.id}`);
    const sources = screen.getByRole("navigation", {name:"Media sources"});
    expect(within(sources).getAllByRole("link").map(link => link.textContent?.replace(/\d+$/, "").trim())).toEqual(["Images","Videos","Public submissions","Audio","Favorites","Collections"]);
    expect(within(sources).getByRole("link", {name:/^Audio/})).toHaveAttribute("aria-current","page");
    const details = await screen.findByRole("complementary", {name:"Asset details"});
    expect(await within(details).findByRole("textbox", {name:"Notes"})).toHaveValue("Original note");
    expect(within(details).getByText("Jordan Avery", {exact:true})).toBeVisible();
    expect(mocks.fetch.mock.calls.some(([url,init]) => String(url).endsWith("cmsListMedia") && JSON.parse(String(init.body)).kinds?.[0] === "audio")).toBe(true);
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).endsWith("cmsVoiceoverLibrary") || String(url).endsWith("cmsVoiceoverAudio"))).toBe(false);
    expect(NAV_DESTINATIONS.some(item => item.id === "voiceovers")).toBe(false);
    for (const path of ["/media","/media/","/media/images","/media/videos","/media/favorites","/media/collections","/media/voiceovers","/voiceovers","/voiceovers/"]) expect(NAV_DESTINATIONS.find(item => item.id === "media")?.activeFor?.(path)).toBe(true);
    fireEvent.click(within(sources).getByRole("link", {name:/^Videos/}));
    await screen.findByRole("heading", {name:"Videos"});
    expect(router.state.location.pathname).toBe("/media/videos");
  });

  it("saves ordinary metadata when the independent personal review cannot load", async () => {
    const originalFetch = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url: string, options: RequestInit) => {
      const endpoint = String(url).split("/").at(-1);
      if (endpoint === "cmsGetMediaReview") throw new Error("Review unavailable");
      if (endpoint === "cmsUpdateMediaMetadata") return json({success:true,asset:{...voiceover,name:"Updated station identification",version:2,etag:'"media.fixture.2"'}});
      return originalFetch(url, options);
    });
    renderRoute(`/media/voiceovers?asset=${voiceover.id}`);
    const name=await screen.findByRole("textbox",{name:"Name"});
    await screen.findByText("Review unavailable");
    expect(screen.queryByRole("textbox",{name:"Notes"})).not.toBeInTheDocument();
    fireEvent.change(name,{target:{value:"Updated station identification"}});
    fireEvent.click(screen.getByRole("button",{name:"Save details"}));
    expect(await screen.findByText("Media details saved")).toBeVisible();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).endsWith("cmsUpdateMediaMetadata"))).toBe(true);
  });

  it("confirms a personal review save without writing media metadata or the shared favorite", async () => {
    mocks.save.mockResolvedValueOnce(json({success:true,review:{...review,notes:"Use for station IDs",version:2}}));
    renderRoute(`/media/voiceovers?asset=${voiceover.id}`);
    const notes=await screen.findByRole("textbox",{name:"Notes"});
    await waitFor(() => expect(notes).toHaveValue("Original note"));
    fireEvent.change(notes,{target:{value:"Use for station IDs"}});
    fireEvent.click(screen.getByRole("button",{name:"Save details"}));
    expect(await screen.findByText("Your review saved")).toBeVisible();
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).endsWith("cmsUpdateMediaMetadata") || String(url).endsWith("cmsSetMediaFavorite"))).toBe(false);
    expect(screen.getByRole("button",{name:"Save details"})).toBeDisabled();
    expect(screen.getAllByText("Your review saved")).toHaveLength(1);
    expect(screen.getByText("Your private review is version 2.")).toBeVisible();
  });

  it("validates metadata before committing a personal review from the combined save", async () => {
    renderRoute(`/media/voiceovers?asset=${voiceover.id}`);
    const notes=await screen.findByRole("textbox",{name:"Notes"});
    await waitFor(() => expect(notes).toHaveValue("Original note"));
    const name=screen.getByRole("textbox",{name:"Name"});
    fireEvent.change(name,{target:{value:""}});
    fireEvent.change(notes,{target:{value:"Keep this review draft"}});
    fireEvent.submit(name.closest("form")!);
    expect(await screen.findByText("Enter a media name.")).toBeVisible();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(notes).toHaveValue("Keep this review draft");
  });

  it.each([412, 500])("reports a saved personal review when metadata fails with %s", async status => {
    mocks.save.mockResolvedValueOnce(json({success:true,review:{...review,notes:"Keep this reading",version:2}}));
    const originalFetch = mocks.fetch.getMockImplementation()!;
    let metadataRequests = 0;
    mocks.fetch.mockImplementation(async (url: string, options: RequestInit) => {
      if (!String(url).endsWith("cmsUpdateMediaMetadata")) return originalFetch(url, options);
      metadataRequests += 1;
      if (metadataRequests === 1) return new Response(JSON.stringify({error:"Metadata unavailable"}), {
        status, headers:{"content-type":"application/json"},
      });
      return json({success:true,changed:true,asset:{...voiceover,name:"Updated station identification",version:2,etag:'"media.fixture.2"'}});
    });
    renderRoute(`/media/voiceovers?asset=${voiceover.id}`);
    const notes = await screen.findByRole("textbox",{name:"Notes"});
    await waitFor(() => expect(notes).toHaveValue("Original note"));
    fireEvent.change(notes,{target:{value:"Keep this reading"}});
    fireEvent.change(screen.getByRole("textbox",{name:"Name"}),{target:{value:"Updated station identification"}});
    fireEvent.click(screen.getByRole("button",{name:"Save details"}));

    expect(await screen.findByText(/Your review was saved\./)).toBeVisible();
    expect(screen.getByText("Media details were not saved")).toBeVisible();
    expect(notes).toHaveValue("Keep this reading");
    expect(screen.getByRole("textbox",{name:"Name"})).toHaveValue("Updated station identification");
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button",{name:"Reload asset"}) !== null).toBe(status === 412);
    expect(screen.getByRole("button",{name:"Save details"})).toBeEnabled();
    if (status === 412) return;

    fireEvent.click(screen.getByRole("button",{name:"Save details"}));
    expect(await screen.findByText("Media details saved")).toBeVisible();
    expect(screen.queryByText(/Your review was saved\./)).not.toBeInTheDocument();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(metadataRequests).toBe(2);
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).endsWith("cmsSetMediaFavorite"))).toBe(false);
  });

  it("holds a source change during a personal review save and retains notes after failure", async () => {
    let reject!: (error: Error) => void;
    mocks.save.mockReturnValueOnce(new Promise((_,fail) => {reject=fail;}));
    const {router} = renderRoute(`/media/voiceovers?asset=${voiceover.id}`);
    const notes = await screen.findByRole("textbox", {name:"Notes"});
    await waitFor(() => expect(notes).toHaveValue("Original note"));
    fireEvent.change(notes,{target:{value:"Keep this reading"}});
    fireEvent.click(screen.getByRole("button",{name:"Save details"}));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({schemaVersion:1,ref:{backend:"r2",id:voiceover.id},baseVersion:1,moreLikeThis:false,notes:"Keep this reading"}));
    fireEvent.click(screen.getByRole("link",{name:/^Videos/}));
    expect(router.state.location.pathname).toBe("/media/voiceovers");
    await act(async () => reject(new Error("Save unavailable")));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button",{name:/keep editing/i}));
    expect(screen.getByRole("textbox",{name:"Notes"})).toHaveValue("Keep this reading");
    expect(screen.getByRole("link",{name:/^Audio/})).toHaveAttribute("aria-current","page");
  });
});
