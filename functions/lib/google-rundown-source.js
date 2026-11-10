"use strict";

const { fail } = require("./live-production-requests");
const { sourceId, structureDocument } = require("./rundown-document-structure");
const SCOPES = Object.freeze(["https://www.googleapis.com/auth/documents.readonly", "https://www.googleapis.com/auth/drive.metadata.readonly"]);

function createGoogleRundownSource({ allowedDocumentIds = [], getClient } = {}) {
  let client;
  async function request(url, params) {
    if (!client) {
      const { GoogleAuth } = require("google-auth-library");
      client = getClient ? await getClient() : await new GoogleAuth({ scopes: SCOPES }).getClient();
    }
    // Fixed Google origins only. No redirects, automatic retries, or remote URLs from a document.
    return (await client.request({ url, params, method: "GET", timeout: 5000, retry: false,
      maxRedirects: 0, maxContentLength: 2 * 1024 * 1024, responseType: "json" })).data;
  }
  return async (config, previous, manual = false) => {
    if (!sourceId(config.documentId) || !allowedDocumentIds.includes(config.documentId)) fail("Rundown intake is not activated for this document.", 503);
    const metadata = async () => {
      const data = await request(`https://www.googleapis.com/drive/v3/files/${config.documentId}`,
        { fields: "id,mimeType,modifiedTime,version,trashed", supportsAllDrives: true });
      if (data.id !== config.documentId || data.trashed || data.mimeType !== "application/vnd.google-apps.document" ||
        !/^\d+$/.test(data.version ?? "") || typeof data.modifiedTime !== "string") fail("The selected Google Doc is unavailable.", 422);
      return { version: data.version, modifiedTime: data.modifiedTime };
    };
    const before = await metadata();
    if (!manual && previous?.drive?.version === before.version) return { unchanged: true, drive: before, apiRequests: 1 };
    const document = await request(`https://docs.googleapis.com/v1/documents/${config.documentId}`,
      { includeTabsContent: true, suggestionsViewMode: "PREVIEW_WITHOUT_SUGGESTIONS" });
    const after = await metadata();
    if (before.version !== after.version) fail("The rundown changed during the read. Refresh again.", 409);
    return { snapshot: structureDocument(document, config), drive: after, apiRequests: 3 };
  };
}
module.exports = { SCOPES, createGoogleRundownSource };
