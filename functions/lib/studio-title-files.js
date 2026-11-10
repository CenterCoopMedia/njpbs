"use strict";

const { defineString } = require("firebase-functions/params");
const { parseStudioTitleFiles } = require("./live-production-contract");

const STUDIO_TITLE_FILES = defineString("CMS_STUDIO_TITLE_FILES", { default: "" });
let studioTitleFiles;

function readStudioTitleFiles() {
  if (studioTitleFiles === undefined) {
    try {
      const encoded = STUDIO_TITLE_FILES.value();
      if (typeof encoded !== "string" || Buffer.byteLength(encoded) > 2048) throw new Error();
      studioTitleFiles = parseStudioTitleFiles(JSON.parse(encoded));
    } catch { studioTitleFiles = null; }
  }
  return studioTitleFiles;
}

module.exports = { readStudioTitleFiles };
