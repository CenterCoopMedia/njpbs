"use strict";

const { withoutPublicLeadVideo } = require("./post-lead-media");
const { parseBlocks } = require("./content-blocks");
const { validateSection } = require("./editor-section-contract");
const { blockContentError } = require("./block-content-validation");
const { authorizeContentRead } = require("./content-authorization");
const { can } = require("./rbac");
const { resolvePostPresentation, tagsWithPostPresentation } = require("./post-formats");
const { collectWorkingMediaUsage } = require("./media-usage");
const { validateContentFieldValues } = require("./content-document-contract");

const TEMPLATE_COLLECTION = "cmsPostTemplates";
const TEMPLATE_SCHEMA_VERSION = 1;
const MODES = ["layout", "content"];

class TemplateError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

function pick(value, fields) {
  return Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, structuredClone(value[key])]));
}

// Canonical Post palette only. A new block type needs an explicit capture rule.
const DATA_FIELDS = Object.freeze({
  bio_card: ["profileId", "kind", "name", "role", "party", "area", "summary", "sourceUrl", "sourceLabel", "asOf", "image"],
  row: ["columns"],
  prose: ["content"],
  image: ["itemId", "assetId", "alt", "altDecorative", "caption", "href", "newTab"],
  image_gallery: ["images", "presentation"],
  embed: ["url", "host", "caption", "width", "height", "heading", "mapSize", "mobileHeight", "mapWidth"],
  html: ["html", "title"],
  cta_row: ["ctas"],
  support_appeal: ["heading", "copy", "buttonLabel", "href", "style", "backgroundImageAssetId"],
  link_card: ["title", "url", "source", "date", "summary"],
  topic_shelf: ["title", "topic", "source", "itemLimit", "sort", "pinned"],
  promotion_playlist: ["title", "placement", "presentation", "columns", "cards"],
  data_figure: ["datasetId", "version", "display"],
  election_results: ["races"],
  data_table: ["title", "csv", "source", "sourceHref"],
  divider: [],
});

// Keep paragraph/list/heading structure, including heading levels. Story text,
// links and other story attributes are removed from the empty editable slots.
function emptyRichText(node) {
  const result = { type: node.type };
  if (node.type === "heading") result.attrs = pick(node.attrs ?? {}, ["level"]);
  if (node.type === "orderedList") result.attrs = pick(node.attrs ?? {}, ["start"]);
  if (node.content) result.content = node.content.filter(child => child.type !== "text").map(emptyRichText);
  return result;
}

function emptyImage(image) {
  return { ...pick(image, ["itemId"]), assetId: "", alt: "" };
}

function captureData(block, mode) {
  const fields = DATA_FIELDS[block.type];
  if (!fields) throw new TemplateError(409, `Template block ${block.type} is no longer supported in Posts.`);
  const data = pick(block.data, fields);
  if (mode === "content") return data;
  switch (block.type) {
    case "bio_card": return { profileId: "", kind: "person", name: "", role: "", summary: "", sourceUrl: "", sourceLabel: "", asOf: "" };
    case "prose": return { content: emptyRichText(data.content) };
    case "image": return emptyImage(data);
    case "image_gallery": return { ...pick(data, ["presentation"]), images: data.images.map(emptyImage) };
    case "embed": return { ...pick(data, ["width", "height", "mapSize", "mobileHeight", "mapWidth"]), url: "", caption: "" };
    case "html": return { html: "", title: "" };
    case "cta_row": return { ctas: data.ctas.map(cta => ({ ...pick(cta, ["variant"]), label: "", href: "" })) };
    case "support_appeal": return { style: data.style, heading: "", copy: "", buttonLabel: "", href: "" };
    case "link_card": return { title: "", url: "", source: "", date: "", summary: "" };
    // Topic/source are reusable query settings; explicit story pins are not.
    case "topic_shelf": return { ...pick(data, ["topic", "source", "itemLimit", "sort"]), title: "", pinned: [] };
    case "promotion_playlist": return {
      ...pick(data, ["placement", "presentation", "columns"]), title: "",
      cards: data.cards.map(card => ({ ...pick(card, ["itemId"]), title: "", summary: "", imageAssetId: "", alt: "", href: "" })),
    };
    case "data_figure": return { datasetId: "", version: { mode: "pinned", releaseId: "" }, display: "expanded" };
    case "election_results": return { races: [] };
    case "data_table": return { title: "", csv: "", source: "", sourceHref: "" };
    default: return data;
  }
}

function validateTemplateDocument(document) {
  const metadataError = validateContentFieldValues("cmsPosts", "post", pick(document,
    ["tags", "leadMedia", "heroBackgroundPosition", "heroBackgroundImage", "heroImage", "heroImageAlt", "heroImageDecorative", "heroImageCaption"]),
  { allowIncomplete: true });
  if (metadataError) throw new TemplateError(409, `Template needs repair: ${metadataError}`);
  const parsed = parseBlocks(document.blocks, { complete: false });
  if (!parsed.ok) throw new TemplateError(409, `Template needs repair: ${parsed.error}`);
  const placement = validateSection("post", parsed.blocks);
  if (placement) throw new TemplateError(409, `Template needs repair: ${placement.detail}`);
  const error = blockContentError(parsed.blocks, { complete: false });
  if (error) throw new TemplateError(409, `Template needs repair: ${error}`);
  try { resolvePostPresentation(document.tags ?? []); }
  catch (error) { throw new TemplateError(409, error.message); }
}

function capturePost(post, mode) {
  if (!MODES.includes(mode)) throw new TemplateError(400, "Choose layout only or layout and content.");
  if (post?.type !== "post" || post.deleted === true) throw new TemplateError(409, "Choose an available Post as the template source.");
  validateTemplateDocument(post);
  const document = {
    type: "post", status: "draft", title: "", categories: [],
    tags: tagsWithPostPresentation([], resolvePostPresentation(post.tags ?? [])),
    blocks: post.blocks.map(block => ({
      ...pick(block, ["id", "type", "order", "visible", "section", "layout"]),
      data: captureData(block, mode),
    })),
    ...pick(post, ["heroBackgroundPosition"]),
    ...(mode === "content" ? pick({ ...post, leadMedia: withoutPublicLeadVideo(post.leadMedia) }, ["leadMedia", "heroBackgroundImage", "heroImage", "heroImageAlt", "heroImageDecorative", "heroImageCaption"]) : {}),
  };
  validateTemplateDocument(document);
  return document;
}

function templateResource(template) {
  return template?.sourceResource ?? {};
}

function mayReadTemplate(principal, template) {
  return !!template && authorizeContentRead(principal, { exists: true, resource: templateResource(template) }).allowed;
}

function mayManageTemplate(principal, template) {
  const resource = templateResource(template);
  return can(principal, "content.edit.any", resource) || can(principal, "content.edit.own", resource);
}

function assertTemplateReadable(principal, template) {
  if (!mayReadTemplate(principal, template)) throw new TemplateError(403, "You do not have permission to use this template.");
  if (template.deleted) throw new TemplateError(404, "This template was removed. Choose another template.");
}

function assertTemplateCompatible(template) {
  if (template.schemaVersion !== TEMPLATE_SCHEMA_VERSION) throw new TemplateError(409, "This template version is not supported. Save a new template from its source Post.");
  validateTemplateDocument(template);
}

function templateSummary(id, template, principal) {
  const counts = {};
  for (const block of template.blocks ?? []) counts[block.type] = (counts[block.type] ?? 0) + 1;
  return {
    id, name: template.name, description: template.description, mode: template.mode,
    version: template.version, retired: template.retired, sourceId: template.sourceId,
    sourceVersion: template.sourceVersion, section: template.sourceResource?.section ?? null,
    counts, canManage: mayManageTemplate(principal, template),
  };
}

// Opening a template is a read, so an admitted shared image read covers its images and
// documents. Saving and instantiating a template still require media use.
async function assertTemplateMediaAccess({ firestore, transaction, principal, document, imageReadAdmitted = false }) {
  const usage = collectWorkingMediaUsage({ collection: "cmsPosts", documentId: "template", document });
  const missing = [];
  for (const assetId of usage.assetIds) {
    const asset = await transaction.get(firestore.collection("media_assets").doc(assetId));
    const data = asset.data();
    const resource = { section: data?.category };
    if (!asset.exists || data?.lifecycle !== "active") {
      missing.push(assetId);
      continue;
    }
    const readable = imageReadAdmitted === true && ["image", "document"].includes(data.kind) &&
      can(principal, "media.image.read", resource);
    if (!readable && !can(principal, "media.upload", resource) && !can(principal, "media.manage", resource)) {
      throw new TemplateError(403, `Media asset ${assetId} is restricted. Choose an asset you can use.`);
    }
  }
  if (missing.length) throw new TemplateError(409, `Media asset ${missing[0]} is unavailable. Replace it before saving or using this template.`);
  return usage;
}

async function readTemplateDraft({ firestore, transaction, principal, selection }) {
  const snap = await transaction.get(firestore.collection(TEMPLATE_COLLECTION).doc(selection.id));
  const template = snap.data();
  assertTemplateReadable(principal, template);
  if (template.retired) throw new TemplateError(409, "This template is retired. Choose another template.");
  if (template.version !== selection.version) throw new TemplateError(409, "This template changed. Reload the template list before using it.");
  assertTemplateCompatible(template);
  const document = capturePost(template, "content");
  await assertTemplateMediaAccess({ firestore, transaction, principal, document });
  return document;
}

module.exports = {
  TEMPLATE_COLLECTION, TEMPLATE_SCHEMA_VERSION, MODES, DATA_FIELDS, TemplateError,
  capturePost, validateTemplateDocument, templateResource, mayReadTemplate,
  mayManageTemplate, assertTemplateReadable, assertTemplateCompatible, templateSummary, assertTemplateMediaAccess,
  readTemplateDraft,
};
