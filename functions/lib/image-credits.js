"use strict";

// Reads the credit, caption and copyright a photographer or wire service embedded
// in an image, so the web copy can keep them after every other field (GPS
// position included) is dropped. Only three text fields are read; nothing else in
// the embedded metadata is trusted or kept.

const MAX_FIELD_CHARS = 2_000;

// EXIF IFD0 tags, type ASCII.
const EXIF_IMAGE_DESCRIPTION = 0x010e;
const EXIF_ARTIST = 0x013b;
const EXIF_COPYRIGHT = 0x8298;

// IPTC IIM application record (2) datasets.
const IPTC_BYLINE = 80;
const IPTC_CREDIT = 110;
const IPTC_COPYRIGHT = 116;
const IPTC_CAPTION = 120;

function cleanText(value) {
  if (typeof value !== "string") return null;
  const text = value
    // eslint-disable-next-line no-control-regex -- Embedded metadata cannot retain controls.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, MAX_FIELD_CHARS);
  return text.length ? text : null;
}

function decodeText(bytes) {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  // Legacy IPTC and EXIF text is often Latin-1. A replacement character means the
  // bytes were not UTF-8.
  return utf8.includes("�") ? Buffer.from(bytes).toString("latin1") : utf8;
}

function readExifCredits(exif) {
  const found = {};
  if (!Buffer.isBuffer(exif) || exif.length < 8) return found;
  // sharp returns the APP1 payload, which starts with "Exif\0\0" before the TIFF header.
  const base = exif.subarray(0, 6).toString("latin1") === "Exif\u0000\u0000" ? 6 : 0;
  const tiff = exif.subarray(base);
  if (tiff.length < 8) return found;
  const order = tiff.subarray(0, 2).toString("latin1");
  if (order !== "II" && order !== "MM") return found;
  const little = order === "II";
  const u16 = (offset) => (little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset));
  const u32 = (offset) => (little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset));
  if (u16(2) !== 42) return found;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return found;
  const count = u16(ifd);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > tiff.length) break;
    const tag = u16(entry);
    const type = u16(entry + 2);
    const length = u32(entry + 4);
    if (type !== 2 || length === 0) continue;
    if (tag !== EXIF_IMAGE_DESCRIPTION && tag !== EXIF_ARTIST && tag !== EXIF_COPYRIGHT) continue;
    const start = length <= 4 ? entry + 8 : u32(entry + 8);
    if (start + length > tiff.length) continue;
    // eslint-disable-next-line no-control-regex -- EXIF ASCII values end with NUL padding.
    const text = cleanText(decodeText(tiff.subarray(start, start + length)).replace(/\u0000+$/, ""));
    if (!text) continue;
    if (tag === EXIF_IMAGE_DESCRIPTION) found.caption = text;
    if (tag === EXIF_ARTIST) found.credit = text;
    if (tag === EXIF_COPYRIGHT) found.copyright = text;
  }
  return found;
}

function readIptcCredits(iptc) {
  const found = {};
  if (!Buffer.isBuffer(iptc)) return found;
  // IIM datasets start with 0x1C, the record number and the dataset number. The
  // buffer may be wrapped in Photoshop resource blocks, so scan for the markers.
  for (let offset = 0; offset + 5 <= iptc.length; offset += 1) {
    if (iptc[offset] !== 0x1c || iptc[offset + 1] !== 2) continue;
    const dataset = iptc[offset + 2];
    const length = iptc.readUInt16BE(offset + 3);
    // Extended-length datasets (high bit set) are not used for these text fields.
    if (length & 0x8000) continue;
    const start = offset + 5;
    if (start + length > iptc.length) break;
    const text = cleanText(decodeText(iptc.subarray(start, start + length)));
    if (text) {
      if (dataset === IPTC_CAPTION) found.caption ??= text;
      if (dataset === IPTC_COPYRIGHT) found.copyright ??= text;
      if (dataset === IPTC_CREDIT) found.credit ??= text;
      if (dataset === IPTC_BYLINE) found.byline ??= text;
    }
    offset = start + length - 1;
  }
  return found;
}

/**
 * The embedded credit, caption and copyright from sharp metadata, or null when
 * none is present. IPTC wins over EXIF, and an IPTC credit wins over its by-line,
 * because newsroom tools write the credit line there.
 */
function readImageCredits(metadata) {
  const exif = readExifCredits(metadata?.exif);
  const iptc = readIptcCredits(metadata?.iptc);
  const credits = {
    credit: iptc.credit ?? iptc.byline ?? exif.credit ?? null,
    caption: iptc.caption ?? exif.caption ?? null,
    copyright: iptc.copyright ?? exif.copyright ?? null,
  };
  return credits.credit || credits.caption || credits.copyright ? credits : null;
}

/** The EXIF fields written onto the web copy. GPS and every other tag are left out. */
function webCopyExif(credits) {
  if (!credits) return null;
  const ifd0 = {};
  if (credits.credit) ifd0.Artist = credits.credit;
  if (credits.copyright) ifd0.Copyright = credits.copyright;
  if (credits.caption) ifd0.ImageDescription = credits.caption;
  return Object.keys(ifd0).length ? { IFD0: ifd0 } : null;
}

module.exports = { readImageCredits, webCopyExif };
