import {
  isRetiredRecordKind,
  retiredRecordLabel,
  type RecordKind,
  type SectionId,
} from "../../../packages/content-core/src/editor-admin";
import type { LibraryRecordKind } from "./content-vocab";
import {
  PUBLIC_PAGES,
  publicPage,
  type PublicPageId,
} from "../../../packages/content-core/src/public-pages";

export interface RecordDestination {
  description: string;
  label: string;
  navLabel: string;
  record: RecordKind;
}

export interface PageDestination {
  description: string;
  label: string;
  pageId: PublicPageId;
  section: SectionId;
}

// The storage vocabulary reused by library filters, direct record routes, isolated specimens, and
// editor headings. It intentionally does not define the shell's page-first navigation.
export const RECORD_DESTINATIONS: readonly RecordDestination[] = [
  { record: "program", label: "Program", navLabel: "Programs", description: "Shows and series" },
  { record: "staff", label: "Staff member", navLabel: "Staff", description: "Bios and bylines" },
  { record: "event", label: "Event", navLabel: "Events", description: "Public dates and details" },
  { record: "sponsor", label: "Sponsor", navLabel: "Sponsors", description: "Supporter acknowledgments" },
  { record: "newsletter", label: "Newsletter", navLabel: "Newsletters", description: "Signup descriptions" },
  { record: "post", label: "Post", navLabel: "Posts", description: "Write and publish station updates" },
] as const;

export const PAGE_DESTINATIONS: readonly PageDestination[] = PUBLIC_PAGES.map((page) => ({
  pageId: page.id,
  section: page.editorTemplate,
  label: page.id === "home" ? "Home page" : page.title,
  description: `Build and save the page draft for ${page.path}. Publishing is separate.`,
}));

export function recordDestination(kind: RecordKind): RecordDestination {
  return RECORD_DESTINATIONS.find((choice) => choice.record === kind) ?? {
    record: kind,
    label: kind,
    navLabel: kind,
    description: "",
  };
}

// The type word a library or newsroom row shows. A retired kind never has a
// destination -- there is no list, no create action, and no editor to open -- so it
// resolves to its retired label instead of an invented one (#1039, #1103).
export function contentKindLabel(kind: LibraryRecordKind): string {
  return isRetiredRecordKind(kind)
    ? retiredRecordLabel(kind)
    : recordDestination(kind).label;
}

export function pageDestination(pageId: PublicPageId): PageDestination {
  const page = publicPage(pageId);
  return page
    ? {
        pageId,
        section: page.editorTemplate,
        label: page.id === "home" ? "Home page" : page.title,
        description: `Build and save the page draft for ${page.path}. Publishing is separate.`,
      }
    : { pageId, section: "genericPage", label: pageId, description: "" };
}
