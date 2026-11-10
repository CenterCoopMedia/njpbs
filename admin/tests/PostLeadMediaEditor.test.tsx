import { useRef, useState } from "react";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PostLeadMediaEditor, duplicatesBodyLead } from "../src/components/PostLeadMediaEditor";
import { RecordForm, type RecordFormHandle } from "../src/components/RecordForm";
import { saveContentWithPublicVideos, videosForPublication } from "../src/lib/publication-videos";
import { embedPlayer } from "../../packages/content-core/src/embed-player";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";
const require = createRequire(import.meta.url);
const contract = require("../../functions/lib/content-document-contract.js");
const templates = require("../../functions/lib/post-templates.js");

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
const legacy = { title: "Station update", date: "2026-10-15", tags: [], blocks: [], heroImage: "old-image", heroImageAlt: "The boardwalk", heroImageCaption: "Photo: NJ PBS" };
const leadVideo = { kind: "library-video", data: { sourceId: "video-library", assetId: "video-one", title: "", caption: "The boardwalk today" } };
function Editor({ initial = legacy }: { initial?: Record<string, unknown> }) {
  const [record, setRecord] = useState(initial);
  return <><PostLeadMediaEditor record={record} fieldId="lead" onChange={leadMedia => setRecord({ ...record, leadMedia })} /><output data-testid="record">{JSON.stringify(record)}</output></>;
}
const record = () => JSON.parse(screen.getByTestId("record").textContent!);

describe("Post lead media authoring (#3582)", () => {
  it.each([false, true])("uses the correct visible and accessible help with template=%s (#3666)", template => {
    const change = vi.fn();
    render(<PostLeadMediaEditor record={legacy} fieldId="context-lead" template={template} onChange={change} />);
    expect(screen.getByText(template
      ? "Shown at the top of Posts made from this template. Videos play only after a reader chooses Play."
      : "Shown at the top of this Post. Videos play only after a reader chooses Play.")).toBeVisible();
    const help = template
      ? "Describe what this image adds to Posts made from this template, or mark it decorative."
      : "Describe what this image adds in this Post, or mark it decorative.";
    expect(screen.getByRole("textbox", { name: "Lead image alt text" })).toHaveAccessibleDescription(expect.stringContaining(help));
    expect(screen.getByRole("button", { name: "About Lead image alt text" })).toHaveAccessibleDescription(expect.stringContaining(help));
    expect(change).not.toHaveBeenCalled();
  });

  it.each([undefined, null])("offers the image picker for an empty lead without writing an incomplete image: %s", leadMedia => {
    const change = vi.fn();
    render(<PostLeadMediaEditor record={{ leadMedia }} fieldId="lead" onChange={change}
      loadMedia={async () => ({ success: true, records: [], total: 0, allCount: 0, page: 1, pageCount: 1, categoryCounts: {}, kindCounts: { image: 0, document: 0 } })} />);
    expect(screen.getByLabelText("Lead media type")).toHaveValue("image");
    expect(screen.getByRole("button", { name: "Choose lead image" })).toBeVisible();
    expect(change).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Lead media type"), { target: { value: "none" } });
    expect(screen.getByLabelText("Lead media type")).toHaveValue("none");
    expect(change).toHaveBeenLastCalledWith(null);
    fireEvent.change(screen.getByLabelText("Lead media type"), { target: { value: "image" } });
    expect(screen.getByLabelText("Lead media type")).toHaveValue("image");
    expect(change).toHaveBeenLastCalledWith(null);
  });

  it.each([
    ["missing", "default"], ["null", "default"], ["missing", "none"], ["null", "none"],
  ])("saves a %s empty lead as null after the %s choice", async (stored, choice) => {
    const saved = vi.fn();
    const form = { current: null } as { current: RecordFormHandle | null };
    render(<RecordForm ref={form} kind="post" canSave initial={{ type: "post", title: "Empty lead", date: "2026-10-15", tags: [], blocks: [],
      ...(stored === "null" ? { leadMedia: null } : {}) }} onSave={async document => {
        const error = contract.validateContentFieldValues("cmsPosts", "post", document, { complete: true });
        if (error) throw new Error(error);
        saved(document);
      }} />);
    expect(screen.getByLabelText("Lead media type")).toHaveValue("image");
    expect(screen.getByRole("option", { name: "No lead media" })).toBeInTheDocument();
    if (choice === "none") fireEvent.change(screen.getByLabelText("Lead media type"), { target: { value: "none" } });
    expect(screen.getByLabelText("Lead media type")).toHaveValue(choice === "none" ? "none" : "image");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(expect.objectContaining({ leadMedia: null })));
    expect(await form.current!.validateForPublication()).toBe(true);
  });

  it("names a caption-only library video preview after activating the existing preview action", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => String(url).endsWith("cmsListSourceMedia")
      ? { success: true, records: [{ id: "video-one", name: "Boardwalk", license: "owned", rightsStatus: "confirmed" }] }
      : { success: true, access: { url: "https://example.test/private-preview.mp4" } } })));
    const shell = { principal: { id: "editor", grants: [{ role: "editor" }] }, getIdToken: async () => "fixture-token", user: { uid: "editor" }, userDoc: null, signOut: vi.fn() } as unknown as ShellData;
    render(<ShellProvider value={shell}><Editor initial={{ ...legacy, leadMedia: leadVideo }} /></ShellProvider>);
    expect(screen.getByRole("button", { name: "Choose a different video" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Preview video" }));
    expect(await screen.findByLabelText("Preview: The boardwalk today")).toHaveAttribute("controls");
  });

  it("explains an unavailable library picker beside its disabled action", () => {
    render(<Editor initial={{ ...legacy, leadMedia: leadVideo }} />);
    expect(screen.getByRole("button", { name: "Choose a different video" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Choose a different video" })).toHaveAccessibleDescription("Sign in to choose a library video.");
    expect(screen.getByText("Sign in to choose a library video.")).toBeVisible();
  });

  it("keeps every lead control locked when its owner becomes read-only", () => {
    const change = vi.fn();
    const initial = { ...legacy, leadMedia: { kind: "embed", data: { title: "Video", url: "https://youtu.be/abcdefghijk" } } };
    const view = render(<PostLeadMediaEditor record={initial} fieldId="lead" onChange={change} />);
    view.rerender(<PostLeadMediaEditor record={initial} fieldId="lead" disabled onChange={change} />);
    expect(screen.getByLabelText("Lead media type")).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Video title" }), { target: { value: "Late edit" } });
    expect(change).not.toHaveBeenCalled();
  });
  it("reads the existing image without migrating and edits it atomically", () => {
    render(<Editor />);
    expect(screen.getByLabelText("Lead media type")).toHaveValue("image");
    expect(record()).not.toHaveProperty("leadMedia");
    fireEvent.change(screen.getByRole("textbox", { name: "Lead image caption" }), { target: { value: "New caption" } });
    expect(record()).toMatchObject({ heroImage: "old-image", heroImageCaption: "Photo: NJ PBS", leadMedia: { kind: "image", data: { assetId: "old-image", alt: "The boardwalk", caption: "New caption" } } });
    fireEvent.change(screen.getByLabelText("Lead media type"), { target: { value: "none" } });
    expect(record().leadMedia).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Lead image caption" })).toBeNull();
  });

  it.each(["linked-video", "embed"])("retains partial %s URLs and shows a nonblocking missing-poster nudge", kind => {
    render(<Editor />);
    fireEvent.change(screen.getByLabelText("Lead media type"), { target: { value: kind } });
    const url = screen.getByRole("textbox", { name: kind === "embed" ? "Video link or iframe code" : "Video link" });
    fireEvent.change(url, { target: { value: "https://www.you" } });
    expect(url).toHaveValue("https://www.you");
    expect(record().leadMedia.data.url).toBe("https://www.you");
    expect(screen.getByText(/Add a poster so/)).toHaveTextContent("You can save and publish without one");
    fireEvent.change(screen.getByRole("textbox", { name: "Video caption" }), { target: { value: "Accessible caption" } });
    expect(record().leadMedia.data.caption).toBe("Accessible caption");
  });

  it("nudges only visible duplicate body videos using the shared provider parser", () => {
    const embed = { kind: "embed", data: { url: "https://youtu.be/abcdefghijk" } };
    const blocks = [{ id: "embed", type: "embed", visible: true, order: 0, data: { url: "https://www.youtube.com/watch?v=abcdefghijk" } }];
    expect(duplicatesBodyLead(embed, blocks)).toBe(true);
    expect(duplicatesBodyLead({ ...embed, data: { url: "https://youtu.be/abcdefghijk?t=30" } }, blocks)).toBe(true);
    expect(duplicatesBodyLead(embed, [{ ...blocks[0], visible: false }])).toBe(false);
    expect(duplicatesBodyLead(leadVideo, [{ id: "video", type: "video", visible: true, order: 0, data: leadVideo.data }])).toBe(true);
  });

  it.each([
    ["https://www.facebook.com/watch/?v=123456789", "https://www.facebook.com/watch/?v=987654321"],
    ["https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv/live", "https://www.youtube.com/channel/UCzyxwvutsrqponmlkjihgfe/live"],
    ["https://vimeo.com/123456789/abcdef1234", "https://vimeo.com/123456789/987654abcd"],
  ])("retains provider identity when comparing %s with another video", (first, second) => {
    const lead = { kind: "embed", data: { url: first } };
    const body = (url: string) => [{ id: "embed", type: "embed", visible: true, order: 0, data: { url } }];
    expect(duplicatesBodyLead(lead, body(first))).toBe(true);
    expect(duplicatesBodyLead(lead, body(second))).toBe(false);
  });

  it.each([
    ["start", "15"], ["end", "90"],
    ...["autoplay", "muted", "topbar", "endscreen"].flatMap(name => [[name, "true"], [name, "false"]]),
  ])("ignores PBS playback %s=%s on either side of the duplicate comparison (#3626)", (name, value) => {
    const plain = "https://player.pbs.org/partnerplayer/123456789/";
    const option = `${plain}?${name}=${value}`;
    const lead = (url: string) => ({ kind: "embed", data: { url } });
    const body = (url: string) => [{ id: "embed", type: "embed", visible: true, order: 0, data: { url } }];
    expect(duplicatesBodyLead(lead(option), body(plain))).toBe(true);
    expect(duplicatesBodyLead(lead(plain), body(option))).toBe(true);
  });

  it("matches combined PBS options across player aliases but keeps different assets distinct (#3626)", () => {
    const lead = { kind: "embed", data: { url: "https://player.pbs.org/portalplayer/123456789/?end=90&muted=true&start=10" } };
    const body = (id: string) => [{ id: "embed", type: "embed", visible: true, order: 0,
      data: { url: `<iframe src="https://player.pbs.org/viralplayer/${id}/?endscreen=false&amp;topbar=false&amp;autoplay=false"></iframe>` } }];
    expect(duplicatesBodyLead(lead, body("123456789"))).toBe(true);
    expect(duplicatesBodyLead(lead, body("987654321"))).toBe(false);
  });

  it("keeps the PBS duplicate reminder nonblocking and preserves saved/player options (#3626)", async () => {
    const leadUrl = "https://player.pbs.org/partnerplayer/123456789/?start=10&end=90&topbar=false&endscreen=false&autoplay=true&muted=true";
    const bodyUrl = "https://player.pbs.org/partnerplayer/123456789/?end=80&muted=false";
    const leadMedia = { kind: "embed", data: { url: leadUrl, title: "PBS source" } };
    const blocks = [{ id: "pbs-body", type: "embed", order: 0, visible: true, data: { url: bodyUrl, caption: "Body playback" } }];
    const save = vi.fn();
    render(<RecordForm kind="post" initial={{ ...legacy, leadMedia, blocks }} canSave onSave={save} />);
    expect(screen.getByText("This video also appears in the body. Consider removing the duplicate body block.")).toBeVisible();
    expect(screen.getByLabelText("Video link or iframe code")).toHaveValue(leadUrl);
    fireEvent.change(screen.getByLabelText("Video title"), { target: { value: "Updated PBS source" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      leadMedia: { ...leadMedia, data: { ...leadMedia.data, title: "Updated PBS source" } }, blocks,
    })));
    expect(embedPlayer(leadUrl)?.src).toBe(leadUrl);
    expect(embedPlayer(bodyUrl)?.src).toBe(bodyUrl);
  });

  it("removes a legacy image and passes complete-save and publication validation", async () => {
    const save = vi.fn();
    const form = { current: null } as { current: RecordFormHandle | null };
    render(<RecordForm ref={form} kind="post" initial={legacy} onSave={save} canSave
      loadMedia={async () => ({ success: true, records: [], total: 0, allCount: 0, page: 1, pageCount: 1, categoryCounts: {}, kindCounts: { image: 0, document: 0 } })} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove lead image" }));
    expect(screen.getByLabelText("Lead media type")).toHaveValue("none");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ leadMedia: null, heroImage: "old-image" })));
    expect(await form.current!.validateForPublication()).toBe(true);
  });

  it("saves an explicit lead clear while retaining legacy data for older readers", async () => {
    const save = vi.fn();
    render(<RecordForm kind="post" initial={legacy} onSave={save} canSave />);
    fireEvent.change(screen.getByLabelText("Lead media type"), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ leadMedia: null, heroImage: "old-image" })));
  });

  it("repairs an inaccessible legacy lead through complete Post and template saves", async () => {
    const saved = vi.fn();
    render(<RecordForm kind="post" initial={{ ...legacy, type: "post", status: "draft", heroImageDecorative: true }}
      onSave={async document => {
        const error = contract.validateContentFieldValues("cmsPosts", "post", document, { complete: true });
        if (error) throw new Error(error);
        const template = templates.capturePost(document, "content");
        expect(template).toHaveProperty("leadMedia", null);
        saved(document);
      }} canSave />);
    fireEvent.change(screen.getByLabelText("Lead media type"), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(expect.objectContaining({ leadMedia: null,
      heroImageDecorative: true, heroImageAlt: "The boardwalk" })));
  });

  it("validates the new owner at publication, allows caption-only names and no poster", async () => {
    let form: RecordFormHandle | null = null;
    function Form() {
      const ref = useRef<RecordFormHandle>(null);
      form = ref.current;
      return <><RecordForm ref={ref} kind="post" allowIncomplete initial={{ ...legacy, leadMedia: { kind: "embed", data: { url: "https://youtu.be/abcdefghijk", title: "" } } }} onSave={vi.fn()} canSave />
        <button onClick={() => { form = ref.current; void form?.validateForPublication(); }}>Check publication</button></>;
    }
    render(<Form />);
    fireEvent.click(screen.getByRole("button", { name: "Check publication" }));
    await screen.findByText(/Choose valid lead media/);
    fireEvent.change(screen.getByRole("textbox", { name: "Video caption" }), { target: { value: "Caption is the accessible name" } });
    fireEvent.click(screen.getByRole("button", { name: "Check publication" }));
    await waitFor(() => expect(screen.queryByText(/Choose valid lead media/)).toBeNull());
    expect(screen.getByText(/Add a poster so/)).toBeVisible();
  });

  it("refuses an unsafe draft URL and focuses the lead owner", async () => {
    const save = vi.fn();
    render(<RecordForm kind="post" initial={{ ...legacy, leadMedia: { kind: "linked-video", data: { url: "javascript:alert(1)", title: "Video" } } }} allowIncomplete onSave={save} canSave />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Check the lead media selection and link/);
    expect(save).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText("Lead media type")).toHaveFocus());
  });

  it.each([
    ["legacy", true], ["legacy", false], ["explicit", true], ["explicit", false],
    ["whitespace", true], ["whitespace", false],
  ] as const)("explains and repairs decorative alt text for a %s image (incomplete=%s)", async (source, allowIncomplete) => {
    const save = vi.fn();
    render(<RecordForm kind="post" initial={source === "legacy"
      ? { ...legacy, heroImageDecorative: true }
      : { ...legacy, leadMedia: { kind: "image", data: { assetId: "old-image", alt: "" } } }}
      allowIncomplete={allowIncomplete} onSave={save} canSave />);
    if (source === "legacy") {
      fireEvent.change(screen.getByRole("textbox", { name: "Lead image caption" }), { target: { value: "Updated photo credit" } });
    } else {
      fireEvent.click(screen.getByRole("checkbox", { name: "Mark lead image as decorative" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Lead image alt text" }), { target: { value: source === "whitespace" ? " " : "Conflicting alt text" } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const type = screen.getByLabelText("Lead media type");
    const alt = screen.getByRole("textbox", { name: "Lead image alt text" });
    await waitFor(() => expect(alt).toHaveFocus());
    expect(alt).toHaveAttribute("aria-invalid", "true");
    expect(alt.getAttribute("aria-describedby")?.split(" ")).toContain(`${type.id}-error`);
    const repair = screen.getByRole("button", { name: "Lead image" });
    expect(repair).toHaveAttribute("aria-controls", alt.id);
    fireEvent.click(repair);
    await waitFor(() => expect(alt).toHaveFocus());
    expect(document.getElementById(`${type.id}-error`)).toHaveTextContent(
      source === "whitespace" && !allowIncomplete
        ? 'The alt text has only spaces. Clear it while "Mark lead image as decorative" is on.'
        : 'Clear the alt text or turn off "Mark lead image as decorative".');
    expect(save).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("textbox", { name: "Lead image alt text" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      leadMedia: { kind: "image", data: expect.objectContaining({ assetId: "old-image", alt: "", altDecorative: true }) },
    })));
  });

  it.each([true, false])("requires descriptive alt after unmarking whitespace-only decorative alt (incomplete=%s)", async allowIncomplete => {
    const save = vi.fn();
    render(<RecordForm kind="post" initial={{ ...legacy,
      leadMedia: { kind: "image", data: { assetId: "old-image", alt: " ", altDecorative: true } } }}
      allowIncomplete={allowIncomplete} onSave={save} canSave />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Mark lead image as decorative" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    if (allowIncomplete) {
      await waitFor(() => expect(save).toHaveBeenCalled());
    } else {
      await screen.findByText("Check the lead image selection, alt text and caption. Choose a library image and add alt text or mark it decorative.");
      expect(save).not.toHaveBeenCalled();
      fireEvent.change(screen.getByRole("textbox", { name: "Lead image alt text" }), { target: { value: "A reporter at the desk" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(save).toHaveBeenCalled());
    }
  });

  it.each([null, [], { assetId: "bad/id", alt: "Description" }, { assetId: "old-image", alt: "Description", unexpected: true }])(
    "keeps malformed image data blocked with image guidance: %j", async data => {
      const save = vi.fn();
      render(<RecordForm kind="post" initial={{ ...legacy, leadMedia: { kind: "image", data } }}
        allowIncomplete onSave={save} canSave />);
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByText("Check the lead image selection, alt text and caption. Choose a library image and add alt text or mark it decorative.");
      expect(save).not.toHaveBeenCalled();
    });
});

describe("entry video publication boundary", () => {
  it.each(["publish", "schedule"])("copies distinct active entry videos before normal %s and omits withdrawn entries", async action => {
    const media = { ...leadVideo, data: { ...leadVideo.data, title: "Results briefing" } };
    const liveBlog = { updates: [{ media }, { media }, { media: { ...media, data: { ...media.data, assetId: "withdrawn-video" } }, withdrawal: "Withdrawn" }] };
    expect(videosForPublication([], null, liveBlog)).toEqual([{ assetId: "video-one", title: "Results briefing" }]);
    const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
      calls.push({ endpoint: String(url).split("/").at(-1)!, body: JSON.parse(options.body as string) });
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ success: true, document: { version: 2 } }) };
    }));
    await saveContentWithPublicVideos("fixture-token", { collection: "cmsPosts", id: "post-one", baseVersion: 1, document: {},
      ...(action === "publish" ? { publish: true } : { scheduleAt: "2026-11-01T14:00:00Z" }) }, { blocks: [], liveBlog });
    expect(calls.map(call => call.endpoint)).toEqual(["cmsPublishSourceVideo", "cmsSaveContent"]);
    expect(calls[0].body).toMatchObject({ collection: "cmsPosts", id: "post-one", assetId: "video-one" });
  });
});

describe("lead video publication boundary (#3582)", () => {
  it("deduplicates lead/body videos and uses the caption for a caption-only library lead", () => {
    const blocks = [{ id: "same", type: "video", order: 0, visible: true, data: { ...leadVideo.data, title: "Body title" } }];
    expect(videosForPublication(blocks, leadVideo)).toEqual([{ assetId: "video-one", title: "The boardwalk today" }]);
  });
  it.each(["publish", "schedule"])("copies a lead-only video before the %s request", async action => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const endpoint = String(url).split("/").at(-1)!;
      calls.push(endpoint);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ success: true, document: { version: 2 } }) };
    }));
    await saveContentWithPublicVideos("test-token", { collection: "cmsPosts", id: "post-one", baseVersion: 1, document: {},
      ...(action === "publish" ? { publish: true } : { scheduleAt: "2026-11-01T14:00:00Z" }) }, { blocks: [], leadMedia: leadVideo });
    expect(calls).toEqual(["cmsPublishSourceVideo", "cmsSaveContent"]);
  });
});

it("keeps invalid explicit no-asset image focus on the rendered type control", async () => {
  const save = vi.fn();
  render(<RecordForm kind="post" initial={{ ...legacy,
    leadMedia: { kind: "image", data: { assetId: "", alt: "Old description", altDecorative: true } },
  }} allowIncomplete canSave onSave={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  const type = screen.getByLabelText("Lead media type");
  await waitFor(() => expect(type).toHaveFocus());
  expect(type).toHaveAttribute("aria-invalid", "true");
  expect(screen.queryByRole("textbox", { name: "Lead image alt text" })).not.toBeInTheDocument();
  const jump = screen.getByRole("button", { name: "Lead image" });
  expect(jump).toHaveAttribute("aria-controls", type.id);
  expect(save).not.toHaveBeenCalled();
});


it("preserves an empty legacy image as an explicit empty lead", async () => {
  const save = vi.fn();
  render(<RecordForm kind="post" initial={{ ...legacy, heroImage: "", heroImageAlt: "Old description", heroImageDecorative: true }}
    allowIncomplete canSave onSave={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ leadMedia: null })));
  expect(screen.getByLabelText("Lead media type")).not.toHaveAttribute("aria-invalid", "true");
  expect(screen.queryByRole("textbox", { name: "Lead image alt text" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Lead image" })).not.toBeInTheDocument();
});
