import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import PDFDocument from "pdfkit";
import type { ScheduleExport } from "./schedule-export";
import { formatScheduleExportDate } from "./schedule-export";

// Static PDFs cannot resolve CSS custom properties. These values mirror the
// named light-document and brand owners in styles/design-tokens.css. A contract
// test keeps the two representations together.
export const SCHEDULE_PDF_COLORS = {
  navy: "#0b1f3a",
  blue: "#2638c4",
  ink: "#10131f",
  muted: "#515a72",
  paper: "#ffffff",
  rule: "#e2e6f0",
  lightBlue: "#eef2fb",
  note: "#f6f8fd",
} as const;
const NAVY = SCHEDULE_PDF_COLORS.navy;
const BLUE = SCHEDULE_PDF_COLORS.blue;
const INK = SCHEDULE_PDF_COLORS.ink;
const MUTED = SCHEDULE_PDF_COLORS.muted;
const PAPER = SCHEDULE_PDF_COLORS.paper;
const RULE = SCHEDULE_PDF_COLORS.rule;
const LIGHT_BLUE = SCHEDULE_PDF_COLORS.lightBlue;
const LEFT = 48;
const RIGHT = 48;
const CONTENT_BOTTOM = 738;
const CONTENT_WIDTH = 612 - LEFT - RIGHT;
// PDFKit 0.20 supports this subset; @types/pdfkit 0.17 omits it.
const PDF_UA_SUBSET = "PDF/UA" as unknown as PDFKit.PDFDocumentOptions["subset"];

interface SchedulePdfAssets {
  readonly regularFont: Buffer;
  readonly boldFont: Buffer;
  readonly blackFont: Buffer;
  readonly logo: Buffer;
}

function assetPath(path: string): string {
  return resolve(process.cwd(), "public", path);
}

function sourceAssetPath(path: string): string {
  return resolve(process.cwd(), "src", "assets", path);
}

export async function loadSchedulePdfAssets(): Promise<SchedulePdfAssets> {
  const [regularFont, boldFont, blackFont, logo] = await Promise.all([
    readFile(sourceAssetPath("pdf-fonts/PublicSans-Regular.ttf")),
    readFile(sourceAssetPath("pdf-fonts/PublicSans-Bold.ttf")),
    readFile(sourceAssetPath("pdf-fonts/PublicSans-Black.ttf")),
    readFile(assetPath("brand/njpbs-horizontal-white-navy.png")),
  ]);
  return { regularFont, boldFont, blackFont, logo };
}

const dayLabel = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const timeLabel = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York",
  timeZoneName: "short",
});

function formatDay(date: string): string {
  return dayLabel.format(new Date(`${date}T12:00:00Z`));
}

export function formatScheduleStartTime(instant: string): string {
  return timeLabel
    .format(new Date(instant))
    .replace("AM", "a.m.")
    .replace("PM", "p.m.");
}

function artifact(
  doc: PDFKit.PDFDocument,
  type: "Pagination" | "Layout",
  draw: () => void,
): void {
  doc.markContent("Artifact", { type });
  draw();
  doc.endMarkedContent();
}

function addPageFrame(
  doc: PDFKit.PDFDocument,
  assets: SchedulePdfAssets,
  firstPage: boolean,
): number {
  doc.addPage({ size: "LETTER", margins: { top: 0, right: 0, bottom: 0, left: 0 } });
  artifact(doc, "Layout", () => {
    doc.rect(0, 0, 612, firstPage ? 104 : 66).fill(NAVY);
    doc.image(assets.logo, LEFT, firstPage ? 24 : 16, {
      fit: firstPage ? [126, 43] : [92, 31],
      valign: "center",
    });
    doc
      .fillColor(PAPER)
      .font("PublicSans-Bold")
      .fontSize(firstPage ? 13 : 9.5)
      .text(`NJ PBS schedule`, 244, firstPage ? 36 : 22, {
        width: 320,
        align: "right",
        lineBreak: false,
      });
  });
  return firstPage ? 126 : 86;
}

function addDateHeader(
  doc: PDFKit.PDFDocument,
  root: PDFKit.PDFStructureElement,
  date: string,
  continued: boolean,
  y: number,
): number {
  const heading = `${formatDay(date)} · NJ PBS (WNJT)${continued ? " · Continued" : ""}`;
  artifact(doc, "Layout", () => {
    doc
      .roundedRect(LEFT, y, CONTENT_WIDTH, 28, 3)
      .fill(LIGHT_BLUE);
  });
  root.add(
    doc.struct("H2", {}, [() => {
      doc
        .fillColor(NAVY)
        .font("PublicSans-Bold")
        .fontSize(10.5)
        .text(`${heading} `, LEFT + 10, y + 8, {
          width: CONTENT_WIDTH - 20,
          lineBreak: false,
        });
    }]),
  );
  return y + 35;
}

function rowHeight(doc: PDFKit.PDFDocument, title: string, episodeTitle?: string): number {
  const copy = episodeTitle ? `${title}\n${episodeTitle}` : title;
  doc.font("PublicSans-Bold").fontSize(9.4);
  const titleHeight = doc.heightOfString(copy, { width: 392, lineGap: 1.5 });
  return Math.max(26, Math.ceil(titleHeight + 11));
}

function addListing(
  doc: PDFKit.PDFDocument,
  root: PDFKit.PDFStructureElement,
  y: number,
  startsAt: string,
  title: string,
  episodeTitle?: string,
): number {
  const height = rowHeight(doc, title, episodeTitle);
  const spoken = `${formatScheduleStartTime(startsAt)}. ${title}${episodeTitle ? `. ${episodeTitle}` : ""}. NJ PBS, WNJT. `;
  artifact(doc, "Layout", () => {
    doc
      .moveTo(LEFT, y + height)
      .lineTo(LEFT + CONTENT_WIDTH, y + height)
      .lineWidth(0.55)
      .strokeColor(RULE)
      .stroke();
  });
  root.add(
    doc.struct("P", { actual: spoken }, [() => {
      doc
        .fillColor(BLUE)
        .font("PublicSans-Bold")
        .fontSize(9.2)
        .text(`${formatScheduleStartTime(startsAt)} `, LEFT + 6, y + 8, {
          width: 92,
          lineBreak: false,
        });
      doc
        .fillColor(INK)
        .font("PublicSans-Bold")
        .fontSize(9.4)
        .text(`${title} `, LEFT + 106, y + 7, {
          width: 392,
          lineGap: 1.5,
        });
      if (episodeTitle) {
        doc
          .fillColor(MUTED)
          .font("PublicSans")
          .fontSize(8.5)
          .text(`${episodeTitle} `, LEFT + 106, doc.y + 1, {
            width: 392,
            lineGap: 1.5,
          });
      }
    }]),
  );
  return y + height;
}

function addPageNumbers(doc: PDFKit.PDFDocument): void {
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    artifact(doc, "Pagination", () => {
      doc
        .fillColor(MUTED)
        .font("PublicSans")
        .fontSize(8)
        .text(`NJ PBS schedule · Page ${index + 1} of ${range.count}`, LEFT, 754, {
          width: CONTENT_WIDTH,
          align: "center",
          lineBreak: false,
        });
    });
  }
}

/** Render the baked 14-day window, with provenance only in document metadata. */
export async function renderSchedulePdf(
  schedule: ScheduleExport,
  assets?: SchedulePdfAssets,
): Promise<Buffer> {
  const pdfAssets = assets ?? await loadSchedulePdfAssets();
  const doc = new PDFDocument({
    autoFirstPage: false,
    bufferPages: true,
    compress: true,
    displayTitle: true,
    lang: "en-US",
    pdfVersion: "1.7",
    subset: PDF_UA_SUBSET,
    tagged: true,
    info: {
      Title: `NJ PBS schedule: ${schedule.rangeLabel}`,
      Author: "NJ PBS",
      Subject: `NJ PBS broadcast listings for ${schedule.rangeLabel}`,
      Keywords: "NJ PBS, schedule, WNJT, television",
      CreationDate: new Date(schedule.exportedAt),
      // PDFKit accepts custom information fields beyond the standard typed keys.
      ...{ ScheduleProvenance: JSON.stringify({
        source: schedule.sourceLabel,
        sourceRevisionDates: schedule.sourceRevisionDates,
        sourceCheckedAt: schedule.sourceCheckedAt,
        sourceCheckText: schedule.sourceCheckText,
        sourceStatus: schedule.sourceStatus,
        correctedDayCount: schedule.correctedDayCount,
        pbsCheckedDayCount: schedule.pbsCheckedDayCount,
        unknownDayCount: schedule.unknownDayCount,
        generatedAt: schedule.generatedAt,
        exportedAt: schedule.exportedAt,
        timeZone: schedule.timeZone,
        missingDates: schedule.missingDates,
        coverageNotice: schedule.coverageNotice,
        notice: schedule.notice,
      }) },
    },
  });
  doc.registerFont("PublicSans", pdfAssets.regularFont);
  doc.registerFont("PublicSans-Bold", pdfAssets.boldFont);
  doc.registerFont("PublicSans-Black", pdfAssets.blackFont);

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const root = doc.struct("Document", { lang: "en-US" });
  doc.addStructure(root);
  let y = addPageFrame(doc, pdfAssets, true);

  root.add(
    doc.struct("H1", {}, [() => {
      doc
        .fillColor(NAVY)
        .font("PublicSans-Black")
        .fontSize(25)
        .text(`${schedule.title} `, LEFT, y, { width: CONTENT_WIDTH });
      y = doc.y + 7;
    }]),
  );
  root.add(
    doc.struct("P", {}, [() => {
      doc
        .fillColor(MUTED)
        .font("PublicSans")
        .fontSize(11);
      const start = formatScheduleExportDate(schedule.startDate);
      const end = formatScheduleExportDate(schedule.endDate);
      const dashX = LEFT + doc.widthOfString(start) + 4;
      const endX = dashX + doc.widthOfString("–") + 4;
      doc.text(`${start} `, LEFT, y, { lineBreak: false });
      doc.text("– ", dashX, y, { lineBreak: false });
      doc.text(`${end} `, endX, y, { width: CONTENT_WIDTH - (endX - LEFT) });
      y = doc.y + 7;
    }]),
  );
  root.add(
    doc.struct("P", {}, [() => {
      doc
        .fillColor(MUTED)
        .font("PublicSans")
        .fontSize(9)
        .text("All times are Eastern. ", LEFT, y, { width: CONTENT_WIDTH });
      y = doc.y + 14;
    }]),
  );

  for (const date of schedule.dates) {
    const day = schedule.days.find((item) => item.date === date);
    const firstListing = day?.entries[0];
    const dayStartHeight = 35 + (firstListing
      ? rowHeight(doc, firstListing.title, firstListing.episodeTitle)
      : 26);
    if (y + dayStartHeight > CONTENT_BOTTOM) {
      y = addPageFrame(doc, pdfAssets, false);
    }
    y = addDateHeader(doc, root, date, false, y);
    if (!firstListing) {
      root.add(doc.struct("P", {}, [() => {
        doc.fillColor(MUTED).font("PublicSans").fontSize(9)
          .text("Listings unavailable. ", LEFT + 6, y + 7, { width: CONTENT_WIDTH - 12 });
      }]));
      y += 26;
    }
    for (const listing of day?.entries ?? []) {
      const height = rowHeight(doc, listing.title, listing.episodeTitle);
      if (y + height > CONTENT_BOTTOM) {
        y = addPageFrame(doc, pdfAssets, false);
        y = addDateHeader(doc, root, date, true, y);
      }
      y = addListing(
        doc,
        root,
        y,
        listing.startsAt,
        listing.title,
        listing.episodeTitle,
      );
    }
    y += 8;
  }

  root.end();
  addPageNumbers(doc);
  doc.end();
  return finished;
}
