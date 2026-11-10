"use strict";

const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const NJPBS_EMAIL_LOGO_CID = "njpbs-email-logo";
const NJPBS_EMAIL_FONTS =
  "'Avenir Next',Avenir,Frutiger,'Segoe UI',Arial,sans-serif";
const NJPBS_EMAIL_LOGO_CONTENT = readFileSync(
  join(__dirname, "../assets/njpbs-horizontal-white.png"),
  "base64",
);

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderNjpbsEmailHeader(serviceLabel) {
  const label = String(serviceLabel ?? "").trim();
  return `<tr>
            <td bgcolor="#0b223d" style="padding:28px 32px 24px;background:#0b223d;border-radius:10px 10px 0 0;border-bottom:4px solid #2638c4;">
              <img src="cid:${NJPBS_EMAIL_LOGO_CID}" width="228" height="62" alt="NJ PBS" style="display:block;width:228px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;color:#ffffff;font-family:${NJPBS_EMAIL_FONTS};font-size:28px;font-weight:700;">
              ${label ? `<p style="margin:10px 0 0;color:#ffffff;font-family:${NJPBS_EMAIL_FONTS};font-size:16px;font-weight:700;line-height:22px;">${escapeHtml(label)}</p>` : ""}
            </td>
          </tr>`;
}

function njpbsEmailLogoAttachment() {
  return {
    content: NJPBS_EMAIL_LOGO_CONTENT,
    content_id: NJPBS_EMAIL_LOGO_CID,
    disposition: "inline",
    filename: "njpbs-horizontal-white.png",
    type: "image/png",
  };
}

module.exports = {
  NJPBS_EMAIL_LOGO_CID,
  njpbsEmailLogoAttachment,
  renderNjpbsEmailHeader,
};
