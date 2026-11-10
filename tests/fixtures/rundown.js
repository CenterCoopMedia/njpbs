// Synthetic passages modeled on the marker conventions in #3329. No studio script.
export const paragraph = (text, style = {}, startIndex = 1) => ({ startIndex, paragraph: {
  paragraphStyle: style, elements: [{ textRun: { content: `${text}\n` } }],
} });
export function rundownDocument(text = "BANNER: SYNTHETIC CITY HEARING") {
  return { documentId: "synthetic_doc", revisionId: "revision-1", suggestionsViewMode: "PREVIEW_WITHOUT_SUGGESTIONS", tabs: [
    { tabProperties: { tabId: "show", title: "Selected show" }, documentTab: { body: { content: [
      paragraph("City hearing", { namedStyleType: "HEADING_1", headingId: "story-city" }), paragraph(text),
    ] } }, childTabs: [{ tabProperties: { tabId: "child", title: "Interview" }, documentTab: { body: { content: [
      paragraph("Interview", { namedStyleType: "HEADING_1", headingId: "story-interview" }),
      paragraph("LOWER THIRDS:"), paragraph("NAME: ALEX EXAMPLE"), paragraph("TITLE: SYNTHETIC REPORTER"),
    ] } } }] },
    { tabProperties: { tabId: "reference", title: "Reference" }, documentTab: { body: { content: [paragraph("BANNER: DO NOT IMPORT REFERENCE")] } } },
  ] };
}
export const sourceConfig = { documentId: "synthetic_doc", tabIds: ["show", "child"], enabled: true };
