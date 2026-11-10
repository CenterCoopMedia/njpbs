import {useState} from "react";
import {WorkspaceActionsProvider} from "../src/components/WorkspaceActions";
import {afterEach,expect,it,vi} from "vitest";
import {act,cleanup,fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {EditorWorkspace} from "../src/components/EditorWorkspace";
import type {ReportingEditorTransport} from "../src/components/DataHubReportingEditor";
import {createBlock,type AdminBlock} from "../src/lib/block-factory";
import {seedDataHubPageBlocks} from "../src/lib/data-hub-page-seed";
import {editContentRows} from "../src/lib/content-row-editing";
import {validateSection} from "../../packages/content-core/src/editor-admin";
const now="2026-10-22T12:00:00.000Z";
afterEach(()=>{cleanup();localStorage.clear();});
async function fixture(unversioned=false){
 const retained={...createBlock("link_card","retained-card"),data:{title:"Retained link",url:"https://example.org/",summary:"Legacy copy"}};
 const dirty=vi.fn();const save=vi.fn(async(_id,_section,metadata)=>({blocks:[],metadata,version:2,status:"draft"}));
 const saveBlocks=vi.fn(async(_id,_section,blocks)=>({blocks,version:2}));
 const preview=vi.fn(async()=>({success:true as const,queueId:"fixture",pageId:"data-hub" as const,sourceVersion:1,dispatched:true,status:"building" as const}));
 const transport:ReportingEditorTransport={preview:async()=>({stories:[],checkedAt:null,failed:false,cutoffAt:now}),terms:async()=>[],vocabulary:async()=>({tags:["wages"],categories:[]})};
 function Workspace(){const [target,setTarget]=useState<HTMLDivElement|null>(null); return <><div ref={setTarget} role="toolbar" aria-label="Fixture page actions"/><WorkspaceActionsProvider target={target}><EditorWorkspace principal={{id:"editor",grants:[{role:"editor"}]}} surface={{kind:"page",pageId:"data-hub",section:"genericPage"}}
  loadPage={async()=>({blocks:unversioned?[retained]:[],metadata:{title:"New Jersey by the Numbers",description:"Official figures",...(!unversioned?{dataHubCompositionVersion:1}:{})},version:1,status:"draft"})}
  savePage={saveBlocks} savePageMetadata={save} requestPagePreview={preview} loadPagePreviewStatus={async()=>{throw new Error("Preview read must stay behind validation");}} reportingTransport={transport} onDirtyChange={dirty}/></WorkspaceActionsProvider></>; }
 render(<Workspace/>);
 const summary=await screen.findByText("Related reporting");
 const reporting=within(summary.closest("details")!);
 if(unversioned)await act(async()=>{const details=summary.closest("details")!;details.open=true;fireEvent(details,new Event("toggle"));});
 else fireEvent.click(summary);
 const terms=await reporting.findByRole("combobox",{name:"Post tags"});
 await reporting.findByText(/No matching stories/);
 return {dirty,save,preview,saveBlocks,terms,actions:within(screen.getByRole("toolbar",{name:"Fixture page actions"}))};
}
it("seeds every compiled section before retained legacy blocks without data loss",()=>{
 const retained={...createBlock("link_card","retained-card"),data:{title:"Retained link",url:"https://example.org/",summary:"Legacy copy"}};
 const blocks=seedDataHubPageBlocks([retained]);
 expect(blocks).toHaveLength(26);
 expect(blocks.slice(0,25).every(block=>block.type==="data_hub_section")).toBe(true);
 expect(blocks.at(-1)).toEqual({...retained,order:25});
 expect(retained.order).toBe(0);
});
it("retains a full legacy Page with collision-free seed IDs and permits repair to the normal cap",()=>{
 const retained=Array.from({length:40},(_,order)=>({...createBlock("divider",order===0?"tmp-seed-data-hub-introduction":`old-${order}`),order}));
 let blocks=seedDataHubPageBlocks(retained);
 expect(blocks).toHaveLength(65);expect(new Set(blocks.map(block=>block.id)).size).toBe(65);
 expect(blocks.slice(25)).toEqual(retained.map((block,index)=>({...block,order:index+25})));
 expect(validateSection("genericPage",blocks)).not.toBeNull();
 for(const block of retained.slice(0,25))blocks=editContentRows("genericPage",blocks,{kind:"remove",id:block.id}).blocks;
 expect(blocks).toHaveLength(40);expect(validateSection("genericPage",blocks)).toBeNull();
});
it("keeps unversioned retained content clean and saves reporting without activating blocks",async()=>{
 const {dirty,save,saveBlocks,terms,actions}=await fixture(true);
 const saveButton=actions.getByRole("button",{name:"Save draft"});
 expect(saveButton).toBeDisabled();expect(dirty).not.toHaveBeenCalledWith(true);
 expect(save).not.toHaveBeenCalled();expect(saveBlocks).not.toHaveBeenCalled();
 fireEvent.change(terms,{target:{value:"wages"}});fireEvent.keyDown(terms,{key:"Enter"});
 fireEvent.click(saveButton);
 await waitFor(()=>expect(save).toHaveBeenCalledTimes(1));
 expect(save.mock.calls[0][2]).toMatchObject({dataHubReporting:{figures:{minimumwage:{posts:{tags:["wages"]}}}}});
 expect(save.mock.calls[0][2]).not.toHaveProperty("dataHubCompositionVersion");
 expect(saveBlocks).not.toHaveBeenCalled();
 await waitFor(()=>expect(saveButton).toBeDisabled());
});
it("uses the existing dirty/leave guard for unfinished terms and becomes clean after clear",async()=>{
 const {dirty}=await fixture();const save=screen.getByRole("button",{name:"Save draft"});expect(save).toBeDisabled();
 expect(screen.getAllByRole("button",{name:/Add/}).length).toBeGreaterThan(0);
 expect(screen.queryByLabelText(/URL slug/)).not.toBeInTheDocument();
 expect(screen.getByRole("textbox",{name:"Page title"})).toHaveValue("New Jersey by the Numbers");
 expect(screen.getByRole("textbox",{name:"Page summary"})).toHaveValue("Official figures");
 const terms=screen.getByRole("combobox",{name:"Post tags"});fireEvent.change(terms,{target:{value:"unfinished"}});
 await waitFor(()=>expect(dirty).toHaveBeenLastCalledWith(true));expect(save).not.toBeDisabled();
 fireEvent.change(terms,{target:{value:""}});
 await waitFor(()=>expect(dirty).toHaveBeenLastCalledWith(false));expect(save).toBeDisabled();
});
it("refuses an unfinished term, reveals its figure and focuses it before preview can proceed",async()=>{
 const {save,preview}=await fixture();fireEvent.change(screen.getByRole("combobox",{name:"Post tags"}),{target:{value:"unfinished"}});
 fireEvent.change(screen.getByLabelText("Figure"),{target:{value:"snap"}});
 fireEvent.click(screen.getByText("Related reporting"));
 fireEvent.click(screen.getByRole("button",{name:"Save draft"}));
 await waitFor(()=>expect(screen.getByRole("combobox",{name:"Post tags"})).toHaveFocus());
 expect(screen.getByRole("combobox",{name:"Post tags"})).toHaveValue("unfinished");
 expect(screen.getByLabelText("Figure")).toHaveValue("minimumwage");expect(save).not.toHaveBeenCalled();expect(preview).not.toHaveBeenCalled();
});
it("saves a mapping through metadata and never sends editor-only term state",async()=>{
 const {save}=await fixture();const terms=screen.getByRole("combobox",{name:"Post tags"});
 fireEvent.change(terms,{target:{value:"wages"}});fireEvent.keyDown(terms,{key:"Enter"});
 fireEvent.click(screen.getByRole("button",{name:"Save draft"}));
 await waitFor(()=>expect(save).toHaveBeenCalledTimes(1));
 expect(save.mock.calls[0][2]).toMatchObject({dataHubReporting:{figures:{minimumwage:{posts:{tags:["wages"]}}}}});
 expect(save.mock.calls[0][2]).not.toHaveProperty("_dataHubReportingDrafts");
});

it("keeps Preview behind the same unfinished-term save gate",async()=>{
 const {save,preview}=await fixture();fireEvent.change(screen.getByRole("combobox",{name:"Post tags"}),{target:{value:"unfinished"}});
 fireEvent.click(screen.getByRole("button",{name:"Preview"}));
 fireEvent.click(await screen.findByRole("button",{name:"Save and preview"}));
 await screen.findAllByText(/Finish adding or clear/);
 expect(save).not.toHaveBeenCalled();expect(preview).not.toHaveBeenCalled();
});
