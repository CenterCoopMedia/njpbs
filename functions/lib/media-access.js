"use strict";

const { can, hasCapability } = require("./rbac");

// Media capability holders work site-wide; categories are filing labels. The media list, its tab count
// and the asset resolver share this rule, so it lives outside list-media.js to avoid a require
// cycle through lib/media-asset-resolver.js.
function isAudioReadAdmitted(actor, approvedActive = actor?.approvedActive) {
  return actor?.emailVerified === true && approvedActive === true &&
    hasCapability(actor?.principal, "media.audio.read");
}

function mayUseMedia(principal, _category, kind, audioReadAdmitted = false) {
  return (
    (audioReadAdmitted === true && ["image", "document"].includes(kind) && can(principal, "media.image.read")) ||
    can(principal, "media.upload") ||
    can(principal, "media.manage") ||
    (audioReadAdmitted === true && kind === "audio" &&
      can(principal, "media.audio.read"))
  );
}

module.exports = { isAudioReadAdmitted, mayUseMedia };
