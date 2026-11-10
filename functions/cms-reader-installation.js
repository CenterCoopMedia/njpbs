"use strict";
const { createVersionedCmsReaderHandler } = require("./lib/cms-versioned-reader");
const { createCmsGetPublicPageHandler } = require("./public-content");
const { createCmsGetPublishedSettingsHandler } = require("./settings");
const { createCmsPreviewHandler, createCmsPreviewStatusHandler } = require("./preview");
const { createPairCurrentCodeHandler } = require("./pair-current-code");

// The default-off reader mounts construct explicit named versions from this factory.
function createCmsReaderInstallation({ firestore, readers, version, authenticate, edge, now = Date.now } = {}) {
  const common = { firestore, retainedReplies: true, now, ...(authenticate ? { requirePrincipalFn: authenticate } : {}) };
  const pairCode = createPairCurrentCodeHandler({ firestore, readers, edge, now });
  return {
    reader: createVersionedCmsReaderHandler({ firestore, readers, version, authenticate, edge, now, handlers: {
      cmsGetPublicPage: createCmsGetPublicPageHandler({ firestore, retainedReplies: true, now }),
      cmsGetPublishedSettings: createCmsGetPublishedSettingsHandler(common),
      cmsPreview: createCmsPreviewHandler(common),
      cmsPreviewStatus: createCmsPreviewStatusHandler(common),
      cmsReadPairCurrentCodeV2: pairCode,
    } }),
    pairCode,
  };
}
module.exports = { createCmsReaderInstallation };
