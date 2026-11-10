// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Office and Acrobat exports carry author names, internal document-management paths and IDs.
// Public PDFs keep only a document title. They must be saved without object streams so these
// plain-byte checks see every dictionary.
const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const publicDir = join(siteRoot, "public");
const forbidden = ["/ObjStm", "/Metadata", "/PieceInfo", "<x:xmpmeta"];

function pdfFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pdfFiles(path);
    return entry.name.toLowerCase().endsWith(".pdf") ? [path] : [];
  });
}

// PDF names may escape characters as #xx, for example /Inf#6f for /Info.
function decodeNames(text: string): string {
  return text.replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function infoKeys(text: string): string[] {
  return [...text.matchAll(/\/Info\s+(\d+)\s+(\d+)\s+R/g)].flatMap(([, num, gen]) => {
    const start = text.search(new RegExp(`(^|\\s)${num}\\s+${gen}\\s+obj\\b`));
    if (start < 0) return ["unreadable info dictionary"];
    const dict = text.slice(start, text.indexOf("endobj", start))
      .replace(/\((?:\\.|[^\\)])*\)/g, "")
      .replace(/<[0-9A-Fa-f\s]*>/g, "");
    return (dict.match(/\/[A-Za-z]+/g) ?? []).filter((key) => key !== "/Title");
  });
}

describe("public PDF metadata", () => {
  it.each(pdfFiles(publicDir).map((path) => relative(siteRoot, path)))("%s has only a document title", (path) => {
    const text = decodeNames(readFileSync(join(siteRoot, path)).toString("latin1"));
    expect(forbidden.filter((marker) => text.includes(marker))).toEqual([]);
    expect(infoKeys(text)).toEqual([]);
  });
});
