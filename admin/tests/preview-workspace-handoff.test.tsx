import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Modal editing flows include retained fields and repeated surface changes.
vi.setConfig({ testTimeout: 10_000 });
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { EditorWorkspace } from "../src/components/EditorWorkspace";
import { WorkspaceActionsProvider } from "../src/components/WorkspaceActions";
import { createBlock, type AdminBlock } from "../src/lib/block-factory";

const principal = { id: "admin", grants: [{ role: "admin" as const }] };
const queueId="abcdefghijklmnopqrst";
const richText = (text:string) => ({type:"doc",content:[{type:"paragraph",content:[{type:"text",text}]}]});
const bodyBlock = (text:string) => ({...createBlock("prose","body"),data:{content:richText(text)}});
const headingBlock = (text:string):AdminBlock => ({...createBlock("headline","heading"),data:{text,level:2}});
const post = { id:"story-1", type:"post", title:"Initial story", slug:"story", status:"draft", version:7, blocks:[bodyBlock("Initial body")], credits:[] };
let actions:HTMLDivElement;
let feedback:HTMLDivElement;
let replace:ReturnType<typeof vi.fn>;
const preview = vi.fn(async (target:{collection:"cmsPages"|"cmsPosts";documentId:string;sourceVersion:number}) => ({ success:true as const,
  queueId, ...target, pageId:target.documentId, rendererSha:"a".repeat(40), pagePath: target.collection==="cmsPosts" ? "/posts/story/":"/contact/",
  status:"ready" as const, previewUrl:`https://preview.njpbs.org/p/${queueId}/`, requestedAt:null,completedAt:null,error:null,expiresAt:null,reused:true as const,retryAfterMs:0 }));
const status=vi.fn();
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
async function editBody(target:HTMLElement,text:string) {
  await act(async()=>{target.innerHTML=`<p>${text}</p>`;fireEvent.input(target);await new Promise(resolve=>setTimeout(resolve,0));});
}
function savedBody(record:Record<string,unknown>) {
  const blocks=record.blocks as Array<{data:{content:unknown}}>;
  return JSON.stringify(blocks[0]?.data.content);
}
beforeEach(()=>{
  actions=document.createElement("div");document.body.appendChild(actions);replace=vi.fn();
  feedback=document.createElement("div");document.body.appendChild(feedback);
  vi.spyOn(window,"open").mockReturnValue({closed:false,document:document.implementation.createHTMLDocument(),opener:null,close:vi.fn(),location:{replace}} as unknown as Window);
  preview.mockClear();status.mockClear();
});
afterEach(()=>{cleanup();actions.remove();feedback.remove();localStorage.clear();vi.restoreAllMocks();});
function mount(props:Partial<React.ComponentProps<typeof EditorWorkspace>>={}) {
  return render(<MemoryRouter><WorkspaceActionsProvider target={actions} feedbackTarget={feedback}><EditorWorkspace principal={principal}
    surface={{kind:"record",record:"post",id:"story-1"}} loadRecord={async()=>({status:"ready",record:post})}
    requestSavedPreview={preview} loadPagePreviewStatus={status} {...props}/></WorkspaceActionsProvider></MemoryRouter>);
}
function doneEditing(){for(const dialog of screen.queryAllByRole("dialog")){if(dialog.classList.contains("component-editor-dialog"))fireEvent.click(within(dialog).getByRole("button",{name:"Done"}));}}
async function editComponent(name:string){doneEditing();fireEvent.click(await screen.findByRole("button",{name:`Edit ${name}`}));}
async function clickPreview(){doneEditing();fireEvent.click(await within(actions).findByRole("button",{name:"Preview"}));}

describe("real workspace to exact Preview",()=>{
  it.each((["program", "event"] as const).flatMap(kind => [
    { name: "Writer", role: "contributor" as const, section: "station" },
    { name: "Editor", role: "editor" as const, section: "station" },
    { name: "News", role: "editor" as const, section: "news" },
    { name: "Admin", role: "admin" as const, section: undefined },
    { name: "super-admin", role: "super_admin" as const, section: undefined },
  ].map(account => ({ kind, ...account }))))("$name previews a clean $kind and saves its dirty draft before previewing", async account => {
    const { kind } = account;
    const record = { id: "routed-record", type: kind, title: "Existing routed record", slug: "routed-record", status: "draft", version: 7,
      createdBy: "preview-owner", section: account.section ?? "station",
      description: richText("Saved synopsis or details"), startsAt: "2026-10-12T18:00:00.000Z", previousSlugs: [], locale: "en" };
    const saveRecord = vi.fn(async (_kind: string, sent: Record<string, unknown>) => ({ ...sent, version: 8 }));
    mount({ principal: { id: "preview-owner", grants: [{ role: account.role, ...(account.section ? { sections: [account.section] } : {}) }] },
      surface: { kind: "record", record: kind, id: record.id }, loadRecord: async () => ({ status: "ready", record }), saveRecord,
      requestSavedPreview: async target => ({ ...await preview(target), pagePath: `/${kind}s/routed-record/` }) });
    await screen.findByRole("textbox", { name: "Title" });
    await clickPreview();
    await waitFor(() => expect(preview).toHaveBeenCalledWith({ collection: "cmsPosts", documentId: record.id, sourceVersion: 7 }));
    expect(saveRecord).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith(`https://preview.njpbs.org/p/${queueId}/${kind}s/routed-record/`);
    await waitFor(() => expect(within(actions).getByRole("button", { name: "Preview" })).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Edited routed record" } });
    await clickPreview();
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith({ collection: "cmsPosts", documentId: record.id, sourceVersion: 8 }));
    expect(saveRecord).toHaveBeenCalledTimes(1);
    expect(saveRecord.mock.calls[0][1].title).toBe("Edited routed record");
  });

  it("previews a clean Post using its trusted read without a write",async()=>{
    const saveRecord=vi.fn();mount({saveRecord});await clickPreview();
    await waitFor(()=>expect(preview).toHaveBeenCalledWith({collection:"cmsPosts",documentId:"story-1",sourceVersion:7}));
    expect(saveRecord).not.toHaveBeenCalled();expect(status).not.toHaveBeenCalled();expect(replace).toHaveBeenCalledTimes(1);
  });
  it("previews a clean Page using the loaded document version without a write",async()=>{
    const savePage=vi.fn();mount({surface:{kind:"page",pageId:"contact",section:"genericPage"},savePage,
      loadPage:async()=>({blocks:[],metadata:{title:"Contact"},status:"draft",version:12})});
    await clickPreview();await waitFor(()=>expect(preview).toHaveBeenCalledWith({collection:"cmsPages",documentId:"contact",sourceVersion:12}));
    expect(savePage).not.toHaveBeenCalled();expect(replace).toHaveBeenCalledTimes(1);
  });
  it("saves moved Home hero settings through Preview and reveals invalid hero controls", async () => {
    const savePageMetadata = vi.fn(async (_id, _section, metadata) => ({ blocks: [], metadata, version: 13 }));
    mount({surface:{kind:"page",pageId:"home",section:"home"}, savePage:vi.fn(), savePageMetadata,
      loadPage:async()=>({blocks:[],metadata:{title:"Home",homeHeroTitle:"Home heading",homeHeroSubtitle:"Home subtitle"},status:"draft",version:12})});
    await editComponent("Home hero");
    const selection = await screen.findByRole("combobox",{name:"Selection"});
    expect(selection.closest("[data-panel-id]")).toHaveAttribute("data-panel-id","content");
    fireEvent.change(selection,{target:{value:"manual"}});
    fireEvent.click(screen.getByRole("button",{name:"Add a slide with a URL"}));
    doneEditing();
    fireEvent.click(within(actions).getByRole("button",{name:"Save draft"}));
    await waitFor(()=>expect(selection).toHaveFocus());
    await clickPreview();
    await waitFor(()=>expect(selection).toHaveFocus());
    expect(preview).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Title",{exact:true}),{target:{value:"Hero story"}});
    fireEvent.change(screen.getByLabelText("Destination URL",{exact:true}),{target:{value:"/watch/"}});
    await clickPreview();
    await waitFor(()=>expect(preview).toHaveBeenCalledWith({collection:"cmsPages",documentId:"home",sourceVersion:13}));
    expect(savePageMetadata).toHaveBeenCalledTimes(1);
    expect(savePageMetadata.mock.calls[0][2]).toMatchObject({homeHero:{items:[{title:"Hero story",href:"/watch/"}]}});
  });
  it("shows a blocked-popup error outside the collapsed Page Preview panel", async () => {
    vi.mocked(window.open).mockReturnValue(null);
    mount({surface:{kind:"page",pageId:"contact",section:"genericPage"},
      loadPage:async()=>({blocks:[],metadata:{title:"Contact"},status:"draft",version:12})});
    await clickPreview();
    expect(await within(feedback).findByRole("alert")).toBeVisible();
    expect(feedback).toHaveTextContent("Allow pop-ups for this CMS");
    expect(preview).not.toHaveBeenCalled();
  });
  it("saves a dirty Post and uses the response version, not the old prop",async()=>{
    const saveRecord=vi.fn(async(_kind:string,sent:Record<string,unknown>)=>({...sent,version:8}));mount({saveRecord});
    fireEvent.change(await screen.findByRole("textbox",{name:/^Post title/}),{target:{value:"Current story"}});
    await clickPreview();await waitFor(()=>expect(preview).toHaveBeenCalledWith({collection:"cmsPosts",documentId:"story-1",sourceVersion:8}));
    expect(saveRecord).toHaveBeenCalledTimes(1);expect(saveRecord.mock.calls[0][1].title).toBe("Current story");
  });
  it("joins an older Post save and previews the body captured at click",async()=>{
    const older=deferred<Record<string,unknown>>();
    const captured=deferred<Record<string,unknown>>();
    const saveRecord=vi.fn().mockImplementationOnce(()=>older.promise).mockImplementationOnce(()=>captured.promise);
    mount({saveRecord});
    await editComponent("text 1");
    const body=await screen.findByRole("textbox",{name:"Body"});
    await editBody(body,"First save");
    doneEditing();
    fireEvent.click(screen.getByRole("button",{name:"Save draft"}));
    await waitFor(()=>expect(saveRecord).toHaveBeenCalledTimes(1));
    await editComponent("text 1");
    await editBody(body,"At Preview click");
    await clickPreview();
    await editComponent("text 1");
    await editBody(body,"After Preview click");
    await act(async()=>{older.resolve({...saveRecord.mock.calls[0][1],version:8});});
    await waitFor(()=>expect(saveRecord).toHaveBeenCalledTimes(2));
    expect(saveRecord.mock.calls[1][1].version).toBe(8);
    expect(savedBody(saveRecord.mock.calls[1][1])).toContain("At Preview click");
    expect(savedBody(saveRecord.mock.calls[1][1])).not.toContain("After Preview click");
    await act(async()=>{captured.resolve({...saveRecord.mock.calls[1][1],version:9});});
    await waitFor(()=>expect(preview).toHaveBeenCalledWith({collection:"cmsPosts",documentId:"story-1",sourceVersion:9}));
    expect(body).toHaveTextContent("After Preview click");
    expect(within(actions).getByRole("button",{name:"Save draft"})).toBeEnabled();
  });
  it("previews a direct Post save acknowledgment while preserving later typing",async()=>{
    const pending=deferred<Record<string,unknown>>();
    const saveRecord=vi.fn<NonNullable<React.ComponentProps<typeof EditorWorkspace>["saveRecord"]>>(()=>pending.promise);
    mount({saveRecord});
    await editComponent("text 1");
    const body=await screen.findByRole("textbox",{name:"Body"});
    await editBody(body,"At Preview click");
    await clickPreview();
    await waitFor(()=>expect(saveRecord).toHaveBeenCalledTimes(1));
    await editComponent("text 1");
    await editBody(body,"After Preview click");
    expect(savedBody(saveRecord.mock.calls[0][1])).toContain("At Preview click");
    expect(savedBody(saveRecord.mock.calls[0][1])).not.toContain("After Preview click");
    await act(async()=>{pending.resolve({...saveRecord.mock.calls[0][1],version:8});});
    await waitFor(()=>expect(preview).toHaveBeenCalledWith({collection:"cmsPosts",documentId:"story-1",sourceVersion:8}));
    expect(saveRecord).toHaveBeenCalledTimes(1);
    expect(body).toHaveTextContent("After Preview click");
    expect(within(actions).getByRole("button",{name:"Save draft"})).toBeEnabled();
  });
  it("uses the final metadata acknowledgment for a dirty Page",async()=>{
    const savePageMetadata=vi.fn(async(_id:string,_section:string,metadata:Record<string,unknown>)=>({blocks:[],metadata,status:"draft",version:13}));
    mount({surface:{kind:"page",pageId:"contact",section:"genericPage"},savePageMetadata,
      loadPage:async()=>({blocks:[],metadata:{title:"Contact"},status:"draft",version:12})});
    const title=await screen.findByRole("textbox",{name:"Page title"});
    fireEvent.change(title,{target:{value:"Changed Contact"}});await clickPreview();
    await waitFor(()=>expect(preview).toHaveBeenCalledWith({collection:"cmsPages",documentId:"contact",sourceVersion:13}));
    expect(savePageMetadata).toHaveBeenCalledTimes(1);
  });
  it("joins an older Page metadata save and previews the title captured at click",async()=>{
    const older=deferred<{blocks:AdminBlock[];metadata:Record<string,unknown>;version:number}>();
    const captured=deferred<{blocks:AdminBlock[];metadata:Record<string,unknown>;version:number}>();
    const savePageMetadata=vi.fn().mockImplementationOnce(()=>older.promise).mockImplementationOnce(()=>captured.promise);
    mount({surface:{kind:"page",pageId:"contact",section:"genericPage"},savePageMetadata,
      loadPage:async()=>({blocks:[],metadata:{title:"Contact"},status:"draft",version:12})});
    const title=await screen.findByRole("textbox",{name:"Page title"});
    fireEvent.change(title,{target:{value:"First save"}});
    fireEvent.click(screen.getByRole("button",{name:"Save metadata"}));
    await waitFor(()=>expect(savePageMetadata).toHaveBeenCalledTimes(1));
    fireEvent.change(title,{target:{value:"At Preview click"}});
    await clickPreview();
    fireEvent.change(title,{target:{value:"After Preview click"}});
    await act(async()=>{older.resolve({blocks:[],metadata:savePageMetadata.mock.calls[0][2],version:13});});
    await waitFor(()=>expect(savePageMetadata).toHaveBeenCalledTimes(2));
    expect(savePageMetadata.mock.calls[1][2]).toMatchObject({title:"At Preview click"});
    expect(savePageMetadata.mock.calls[1][3]).toBe(13);
    await act(async()=>{captured.resolve({blocks:[],metadata:savePageMetadata.mock.calls[1][2],version:14});});
    await waitFor(()=>expect(preview).toHaveBeenCalledWith({collection:"cmsPages",documentId:"contact",sourceVersion:14}));
    expect(title).toHaveValue("After Preview click");
    expect(screen.getByRole("button",{name:"Save metadata"})).toBeEnabled();
  });
  it("restores click-time Page metadata after joining an older combined save",async()=>{
    const pageBlocks=[headingBlock("Initial heading")];
    const olderContent=deferred<{blocks:AdminBlock[];metadata:Record<string,unknown>;version:number}>();
    const capturedContent=deferred<{blocks:AdminBlock[];metadata:Record<string,unknown>;version:number}>();
    const olderMetadata=deferred<{blocks:AdminBlock[];metadata:Record<string,unknown>;version:number}>();
    const capturedMetadata=deferred<{blocks:AdminBlock[];metadata:Record<string,unknown>;version:number}>();
    const savePage=vi.fn<NonNullable<React.ComponentProps<typeof EditorWorkspace>["savePage"]>>()
      .mockImplementationOnce(()=>olderContent.promise).mockImplementationOnce(()=>capturedContent.promise);
    const savePageMetadata=vi.fn<NonNullable<React.ComponentProps<typeof EditorWorkspace>["savePageMetadata"]>>()
      .mockImplementationOnce(()=>olderMetadata.promise).mockImplementationOnce(()=>capturedMetadata.promise);
    mount({surface:{kind:"page",pageId:"contact",section:"genericPage"},savePage,savePageMetadata,
      loadPage:async()=>({blocks:pageBlocks,metadata:{title:"Contact"},status:"draft",version:12})});
    await editComponent("heading 1");
    const heading=await screen.findByRole("textbox",{name:"Heading"});
    const title=screen.getByRole("textbox",{name:"Page title"});
    fireEvent.change(heading,{target:{value:"Pending content"}});
    doneEditing();
    fireEvent.change(title,{target:{value:"Pending metadata"}});
    const saveDraft=await within(actions).findByRole("button",{name:"Save draft"});
    await waitFor(()=>expect(saveDraft).toBeEnabled());
    fireEvent.click(saveDraft);
    await waitFor(()=>expect(savePage).toHaveBeenCalledTimes(1));

    fireEvent.change(title,{target:{value:"Contact"}});
    await clickPreview();
    fireEvent.change(title,{target:{value:"After Preview click"}});
    await act(async()=>{olderContent.resolve({blocks:savePage.mock.calls[0][2],metadata:{title:"Contact"},version:13});});
    await waitFor(()=>expect(savePageMetadata).toHaveBeenCalledTimes(1));
    expect(savePageMetadata.mock.calls[0][2]).toMatchObject({title:"After Preview click"});
    expect(savePageMetadata.mock.calls[0][3]).toBe(13);
    await act(async()=>{olderMetadata.resolve({blocks:savePage.mock.calls[0][2],metadata:savePageMetadata.mock.calls[0][2],version:14});});

    await waitFor(()=>expect(savePage).toHaveBeenCalledTimes(2));
    expect(preview).not.toHaveBeenCalled();
    expect(savePage.mock.calls[1][2][0].data).toMatchObject({text:"Pending content"});
    expect(savePage.mock.calls[1][3]).toBe(14);
    await act(async()=>{capturedContent.resolve({blocks:savePage.mock.calls[1][2],metadata:{title:"After Preview click"},version:15});});
    await waitFor(()=>expect(savePageMetadata).toHaveBeenCalledTimes(2));
    expect(savePageMetadata.mock.calls[1][2]).toMatchObject({title:"Contact"});
    expect(savePageMetadata.mock.calls[1][3]).toBe(15);
    expect(preview).not.toHaveBeenCalled();
    await act(async()=>{capturedMetadata.resolve({blocks:savePage.mock.calls[1][2],metadata:savePageMetadata.mock.calls[1][2],version:16});});

    await waitFor(()=>expect(preview).toHaveBeenCalledWith({collection:"cmsPages",documentId:"contact",sourceVersion:16}));
    expect(savePage).toHaveBeenCalledTimes(2);
    expect(savePageMetadata).toHaveBeenCalledTimes(2);
    expect(title).toHaveValue("After Preview click");
    expect(within(actions).getByRole("button",{name:"Save draft"})).toBeEnabled();
  });
  it("captures Page content and metadata before their sequential Preview saves",async()=>{
    const pageBlocks=[headingBlock("Initial heading")];
    const contentSave=deferred<{blocks:AdminBlock[];metadata:Record<string,unknown>;version:number}>();
    const metadataSave=deferred<{blocks:AdminBlock[];metadata:Record<string,unknown>;version:number}>();
    const savePage=vi.fn<NonNullable<React.ComponentProps<typeof EditorWorkspace>["savePage"]>>(()=>contentSave.promise);
    const savePageMetadata=vi.fn<NonNullable<React.ComponentProps<typeof EditorWorkspace>["savePageMetadata"]>>(()=>metadataSave.promise);
    mount({surface:{kind:"page",pageId:"contact",section:"genericPage"},savePage,savePageMetadata,
      loadPage:async()=>({blocks:pageBlocks,metadata:{title:"Contact"},status:"draft",version:12})});
    await editComponent("heading 1");
    const heading=await screen.findByRole("textbox",{name:"Heading"});
    const title=screen.getByRole("textbox",{name:"Page title"});
    fireEvent.change(heading,{target:{value:"Heading at Preview click"}});
    doneEditing();
    fireEvent.change(title,{target:{value:"Title at Preview click"}});
    await clickPreview();
    await waitFor(()=>expect(savePage).toHaveBeenCalledTimes(1));
    await editComponent("heading 1");
    fireEvent.change(heading,{target:{value:"Heading after Preview click"}});
    doneEditing();
    fireEvent.change(title,{target:{value:"Title after Preview click"}});
    expect(savePage.mock.calls[0][2][0].data).toMatchObject({text:"Heading at Preview click"});
    expect(savePage.mock.calls[0][3]).toBe(12);
    await act(async()=>{contentSave.resolve({blocks:savePage.mock.calls[0][2],metadata:{title:"Contact"},version:13});});
    await waitFor(()=>expect(savePageMetadata).toHaveBeenCalledTimes(1));
    expect(savePageMetadata.mock.calls[0][2]).toMatchObject({title:"Title at Preview click"});
    expect(savePageMetadata.mock.calls[0][3]).toBe(13);
    await act(async()=>{metadataSave.resolve({blocks:savePage.mock.calls[0][2],metadata:savePageMetadata.mock.calls[0][2],version:14});});
    await waitFor(()=>expect(preview).toHaveBeenCalledWith({collection:"cmsPages",documentId:"contact",sourceVersion:14}));
    expect(heading).toHaveValue("Heading after Preview click");
    expect(title).toHaveValue("Title after Preview click");
    expect(within(actions).getByRole("button",{name:"Save draft"})).toBeEnabled();
  });

});
