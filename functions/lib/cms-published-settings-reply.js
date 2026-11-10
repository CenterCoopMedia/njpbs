"use strict";

const { projectPublishedCmsSettings, CmsSettingsContractError, CMS_SETTINGS_SCHEMAS } = require("./cms-settings-contract");

// The stored document (including its real version) is the source. A build
// projection cannot replace this endpoint's validation or wire serializer.
function publishedSettingsReply({ id, document, schemas = CMS_SETTINGS_SCHEMAS, invalid = () => {} }) {
  const missing = { success: true, found: false, id };
  if (document?.published === undefined) return missing;
  let published;
  try { published = projectPublishedCmsSettings({ documentId: id, schemas, document }); }
  catch (error) {
    if (!(error instanceof CmsSettingsContractError)) throw error;
    invalid();
    return missing;
  }
  return published ? { success: true, found: true, id, published } : missing;
}

module.exports = { publishedSettingsReply };
