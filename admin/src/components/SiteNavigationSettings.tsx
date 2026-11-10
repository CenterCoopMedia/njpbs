import { PostsBrowseEditor } from "./PostsBrowseEditor";
import type { PostsBrowseConfig } from "../../../packages/content-core/src/posts-browse";
import { canonicalPostsBrowse } from "../lib/posts-browse-draft";
import { SettingsInspector, useSettingsDirty, useSettingsSectionActive } from "./SettingsWorkspace";
import { EditorFrameHeader } from "./EditorFrameHeader";
import { useReorder } from "../hooks/useReorder";
import { ReorderHandle } from "./ReorderHandle";
import { ActionControl } from "./ui/ActionControl";
import { LAUNCH_LABELS, ROUTE_CHOICES, siteNavigationSchema, siteNavigationLinkSummary, siteNavigationLinkOpensInNewTab, siteNavigationHeaderNote, siteNavigationFooterNote } from "../lib/site-navigation-presentation";
import { useSettingsPublication } from "../hooks/useSettingsPublication";
import { SettingsPublicationStatus } from "./SettingsPublicationStatus";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  DEFAULT_SITE_NAVIGATION,
  SITE_NAVIGATION_LAUNCH_KEYS,
  SITE_NAVIGATION_SETTINGS_ID,
  safeNavigationHref,
  navigationTargetAllowsNewTab,
  validateCmsSettingsValues,
  CMS_SETTINGS_READ_SCHEMAS,
  type SiteNavigationLaunchKey,
  type SiteNavigationRouteKey,
  type SiteNavigationSettingsValues,
  type SiteNavigationTarget,
} from "../../../packages/content-core/src/cms-settings";
import {
  resolveSiteNavigation,
} from "../../../packages/content-core/src/site-navigation";
import {
  PUBLIC_PAGES,
  isCustomPageId,
} from "../../../packages/content-core/src/public-pages";
import {
  AsyncActionButton,
  Button,
  InlineMessage,
  Panel,
  Select,
  TextInput,
} from "./ui/Primitives";
import { SiteNavigationLoading } from "./SiteNavigationLoading";
import {
  isConflictError,
  settingsPublicationRefusalMessage,
  type CmsSettingsPublishedSnapshot,
  type GetSettingsResponse,
  type MutateSettingsResponse,
  type PageDirectoryEntry,
  type PublishSettingsRequest,
  type SaveSettingsRequest,
} from "../lib/functions";
import { useSuccessNotice } from "./ui/SuccessNoticeRegion";

export { SITE_NAVIGATION_SETTINGS_ID };
export type SiteNavigationValues = SiteNavigationSettingsValues;


const SITE_NAVIGATION = siteNavigationSchema();
export const SITE_NAVIGATION_HEADER_MAX_ITEMS = SITE_NAVIGATION.header.maxItems;
export const SITE_NAVIGATION_FOOTER_MAX_COLUMNS = SITE_NAVIGATION.footer.maxItems;
export const SITE_NAVIGATION_COLUMN_MAX_LINKS = SITE_NAVIGATION.footer.maxLinks;
export const SITE_NAVIGATION_LABEL_BYTES = SITE_NAVIGATION.footer.labelMaxBytes;
export const SITE_NAVIGATION_HEADING_BYTES = SITE_NAVIGATION.footer.headingMaxBytes;
export const SITE_NAVIGATION_HREF_BYTES = SITE_NAVIGATION.footer.hrefMaxBytes;
const LOCKED_LINK_IDS = new Set(
  (SITE_NAVIGATION.footer.lockedLinks ?? []).map(({ id }) => id),
);

// Rendered by PublicSiteLayout.astro in code. Shown here read-only so staff can
// see what every page carries without an edit path.
const REQUIRED_FCC_LINKS = ["Public file", "WNJS", "WNJN", "WNJT", "WNJB"];
const REQUIRED_LEGAL_LINKS = [
  "Closed captioning",
  "Accessibility",
  "Privacy policy",
  "Your privacy choices",
  "EEO report",
];


// Routes the public site builds outside the page catalog. An internal web
// address under one of these is not flagged as unknown.
const ROUTED_PREFIXES = [
  "/posts/",
  "/authors/",
  "/coverage/",
  "/schedule/",
  "/search/",
  "/programs/",
  "/staff/",
];

export interface SiteNavigationSettingsTransport {
  load: () => Promise<GetSettingsResponse<SiteNavigationValues>>;
  save: (
    request: SaveSettingsRequest<SiteNavigationValues>,
  ) => Promise<MutateSettingsResponse<SiteNavigationValues>>;
  publish: (
    request: PublishSettingsRequest,
  ) => Promise<MutateSettingsResponse<SiteNavigationValues>>;
  loadPages: () => Promise<PageDirectoryEntry[]>;
  loadVocabulary?: () => Promise<import("../../../packages/content-core/src/published-vocabulary").PublishedVocabulary>;
}

// One "Links to" choice per target type, with each conditional route listed
// on its own so staff pick it in one step.
type TargetChoice = "page" | `route:${SiteNavigationRouteKey}` | "launch" | "href";


function choiceFor(target: SiteNavigationTarget): TargetChoice {
  return target.type === "route" ? `route:${target.key}` : target.type;
}

interface DraftLink {
  id: string;
  label: string;
  target: SiteNavigationTarget;
  external: boolean;
}

interface DraftColumn {
  id: string;
  heading: string;
  links: DraftLink[];
}

interface Draft {
  header: DraftLink[];
  footer: DraftColumn[];
  postsBrowse?: PostsBrowseConfig;
}

interface ReadySettings {
  status: "ready";
  values: SiteNavigationValues;
  version: number | null;
  published: CmsSettingsPublishedSnapshot<SiteNavigationValues> | null;
}

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | ReadySettings;

type ActionState =
  | { type: "idle" }
  | { type: "saved" }
  | { type: "conflict" }
  | { type: "save-error" }
  | { type: "publish-error"; message?: string };

interface PageOption {
  id: string;
  title: string;
  path: string;
}

type Area = { kind: "header" } | { kind: "column"; columnId: string };

// Header and footer ids are unique only within their own list, so DOM ids and
// focus keys carry the area.
function scopeOf(area: Area): "header" | "footer" {
  return area.kind === "header" ? "header" : "footer";
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function canonicalTarget(target: SiteNavigationTarget): SiteNavigationTarget {
  switch (target.type) {
    case "page":
      return target.hash
        ? { type: "page", pageId: target.pageId, hash: target.hash }
        : { type: "page", pageId: target.pageId };
    case "route":
      return { type: "route", key: target.key };
    case "launch":
      return { type: "launch", key: target.key };
    case "href":
      return { type: "href", href: target.href.trim() };
  }
}

function canonicalLink(link: DraftLink): DraftLink {
  return {
    id: link.id,
    label: link.label.trim(),
    target: canonicalTarget(link.target),
    external: link.external && navigationTargetAllowsNewTab(link.target),
  };
}

function canonicalValues(draft: Draft): SiteNavigationValues {
  return {
    ...(draft.postsBrowse ? { postsBrowse: canonicalPostsBrowse(draft.postsBrowse) } : {}),
    header: draft.header.map(canonicalLink),
    footer: draft.footer.map((column) => ({
      id: column.id,
      heading: column.heading.trim(),
      links: column.links.map(canonicalLink),
    })),
  };
}

function draftFromValues(values: SiteNavigationValues): Draft {
  return JSON.parse(JSON.stringify(values)) as Draft;
}

function valuesEqual(left: SiteNavigationValues, right: SiteNavigationValues): boolean {
  return (
    JSON.stringify(canonicalValues(draftFromValues(left))) ===
    JSON.stringify(canonicalValues(draftFromValues(right)))
  );
}

function valuesFromUnknown(value: unknown, schemaVersion: number): SiteNavigationValues {
  const schema = CMS_SETTINGS_READ_SCHEMAS["site-navigation"].versions[schemaVersion];
  if (!schema || validateCmsSettingsValues(schema, value)) {
    throw new Error("The site navigation setting is invalid.");
  }
  return value as SiteNavigationValues;
}

function publishedFromUnknown(
  value: unknown,
): CmsSettingsPublishedSnapshot<SiteNavigationValues> | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The published site navigation is invalid.");
  }
  const record = value as Record<string, unknown>;
  const publishedAt =
    typeof record.publishedAt === "string" ? new Date(record.publishedAt) : null;
  if (
    !Number.isSafeInteger(record.schemaVersion) ||
    !Number.isSafeInteger(record.sourceVersion) ||
    Number(record.sourceVersion) < 1 ||
    !publishedAt ||
    Number.isNaN(publishedAt.getTime()) ||
    publishedAt.toISOString() !== record.publishedAt
  ) {
    throw new Error("The published site navigation is invalid.");
  }
  return {
    schemaVersion: Number(record.schemaVersion),
    sourceVersion: Number(record.sourceVersion),
    publishedAt: record.publishedAt,
    values: valuesFromUnknown(record.values, Number(record.schemaVersion)),
  };
}

function readyFromResponse(
  response: GetSettingsResponse<SiteNavigationValues>,
): ReadySettings {
  if (!response.found) {
    return {
      status: "ready",
      values: DEFAULT_SITE_NAVIGATION,
      version: null,
      published: null,
    };
  }
  if (!Number.isSafeInteger(response.settings.version) || response.settings.version < 1) {
    throw new Error("The site navigation version is invalid.");
  }
  return {
    status: "ready",
    values: valuesFromUnknown(response.settings.values, response.settings.schemaVersion),
    version: response.settings.version,
    published: publishedFromUnknown(response.settings.published),
  };
}

function readyFromMutation(
  response: MutateSettingsResponse<SiteNavigationValues>,
): ReadySettings {
  return readyFromResponse({
    success: true,
    found: true,
    id: response.id,
    settings: response.settings,
  });
}

/** Turn the shared validator's first error into a sentence staff can act on. */
export function describeNavigationError(error: string): string {
  if (/Posts browsing|subject|browsing group/.test(error)) return error;
  if (/must keep the contact link/.test(error)) {
    return "The footer must keep the Contact link.";
  }
  if (/link contact cannot change its target/.test(error)) {
    return "The Contact link must keep pointing to the Contact page.";
  }
  if (/ids must be unique/.test(error)) {
    return "Two items share an internal id. Reload the saved navigation and try again.";
  }
  if (error === "header must contain at least one link") {
    return "The header needs at least one link.";
  }
  if (error === "footer must contain at least one column") {
    return "The footer needs at least one column.";
  }
  const match = /^(header|footer)(?:\[(\d+)\])?(?:\.links\[(\d+)\])?\.?\s?(.*)$/.exec(error);
  if (!match) return "The navigation is invalid.";
  const [, field, first, second, rest] = match;
  let where = field === "header" ? "The header" : "The footer";
  if (field === "header" && first !== undefined) where = `Header link ${Number(first) + 1}`;
  if (field === "footer" && first !== undefined) {
    where = second !== undefined
      ? `Footer column ${Number(first) + 1}, link ${Number(second) + 1}`
      : `Footer column ${Number(first) + 1}`;
  }
  if (/^links must contain at least one link/.test(rest)) {
    return `${where} needs at least one link. Add a link or remove the column.`;
  }
  const detail = rest
    .replace(/^target must contain a safe link$/, "needs a safe web address")
    .replace(/^target link can be/, "web address can be")
    .replace(/^target must name a public page$/, "needs a page")
    .replace(/^label is required$/, "needs a label")
    .replace(/^heading is required$/, "needs a heading")
    .replace(/^heading must be unique$/, "needs a different heading from the other footer columns")
    .replace(/^target is invalid$/, "has an invalid link type");
  return `${where} ${detail}.`;
}

function knownInternalPath(path: string, pages: readonly PageOption[]): boolean {
  const bare = path.split(/[?#]/)[0];
  const withSlash = bare.endsWith("/") ? bare : `${bare}/`;
  return (
    withSlash === "/" ||
    pages.some((page) => page.path === withSlash) ||
    ROUTED_PREFIXES.some((prefix) => withSlash.startsWith(prefix))
  );
}

/** Non-blocking advice for one link. Save stays available. */
function linkWarning(link: DraftLink, pages: readonly PageOption[]): string | null {
  if (link.target.type === "page") {
    const { pageId } = link.target;
    if (isCustomPageId(pageId) && !pages.some((page) => page.id === pageId)) {
      return "This page is not published, so the public site hides this link until it is.";
    }
    return null;
  }
  if (link.target.type !== "href") return null;
  const href = link.target.href.trim();
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  const bare = href.split(/[?#]/)[0];
  const page = pages.find((option) => option.path === bare || option.path === `${bare}/`);
  if (page) {
    return `This address is the ${page.title} page. Choose Page as the link type so the link follows the page if its address changes.`;
  }
  return knownInternalPath(href, pages)
    ? null
    : "This address is not a known page on the public site. Check it before you publish.";
}

function linkFieldError(link: DraftLink): string | null {
  const label = link.label.trim();
  if (!label) return "Enter a label.";
  if (utf8Bytes(label) > SITE_NAVIGATION_LABEL_BYTES) {
    return `Use no more than ${SITE_NAVIGATION_LABEL_BYTES} bytes.`;
  }
  return null;
}

function hrefFieldError(link: DraftLink): string | null {
  if (link.target.type !== "href") return null;
  const href = link.target.href.trim();
  if (!href) return "Enter a web address.";
  if (utf8Bytes(href) > SITE_NAVIGATION_HREF_BYTES) {
    return `Use no more than ${SITE_NAVIGATION_HREF_BYTES} bytes.`;
  }
  return safeNavigationHref(href) === href
    ? null
    : "Enter a safe address: https://, http://, mailto:, tel: or a path that starts with /.";
}

function allIds(draft: Draft): Set<string> {
  return new Set([
    ...draft.header.map(({ id }) => id),
    ...draft.footer.flatMap((column) => [column.id, ...column.links.map(({ id }) => id)]),
  ]);
}

function nextId(draft: Draft, prefix: string): string {
  const ids = allIds(draft);
  for (let index = 1; ; index += 1) {
    const id = `${prefix}-${index}`;
    if (!ids.has(id)) return id;
  }
}

function newLink(id: string): DraftLink {
  return { id, label: "New link", target: { type: "page", pageId: "about" }, external: false };
}

function targetForChoice(choice: TargetChoice, current: SiteNavigationTarget): SiteNavigationTarget {
  if (choice === choiceFor(current)) return current;
  switch (choice) {
    case "page":
      return { type: "page", pageId: "about" };
    case "route:postsIndex":
      return { type: "route", key: "postsIndex" };
    case "route:inTheNews":
      return { type: "route", key: "inTheNews" };
    case "launch":
      return { type: "launch", key: "pbsVideo" };
    case "href":
      return { type: "href", href: "" };
  }
}

function move<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function describedBy(...ids: Array<string | false | null | undefined>): string | undefined {
  const value = ids.filter(Boolean).join(" ");
  return value || undefined;
}

function PublishedStatus({
  published,
}: {
  published: CmsSettingsPublishedSnapshot<SiteNavigationValues> | null;
}) {
  if (!published) return <>Not published. The public site shows the default navigation.</>;
  return (
    <>
      Published version {published.sourceVersion} on{" "}
      <time dateTime={published.publishedAt}>
        {new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(published.publishedAt))}
      </time>
    </>
  );
}

export function SiteNavigationSettings({
  load,
  save,
  publish,
  loadPages,
  loadVocabulary,
}: SiteNavigationSettingsTransport) {
  const sectionActive = useSettingsSectionActive();
  const successNotice = useSuccessNotice();
  const [attempt, setAttempt] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [draft, setDraft] = useState<Draft>(draftFromValues(DEFAULT_SITE_NAVIGATION));
  const [customPages, setCustomPages] = useState<PageOption[]>([]);
  const [publishedPaths, setPublishedPaths] = useState<ReadonlyMap<string, string>>(new Map());
  const [pagesFailed, setPagesFailed] = useState(false);
  const [pending, setPending] = useState<"save" | "publish" | null>(null);
  const [actionState, setActionState] = useState<ActionState>({ type: "idle" });
  const { publication, observe, retry, retrying, refresh, needsRefresh } = useSettingsPublication(load,
    (sourceVersion) => publish({ id: SITE_NAVIGATION_SETTINGS_ID, baseVersion: sourceVersion }));
  const [announcement, setAnnouncement] = useState("");
  const [previewWidth, setPreviewWidth] = useState<"desktop" | "phone">("desktop");
  const [footerOpen, setFooterOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const focusTargets = useRef(new Map<string, HTMLElement>());
  const [pendingFocus, setPendingFocus] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadState({ status: "loading" });
    setActionState({ type: "idle" });
    observe();
    load()
      .then((response) => {
        if (!cancelled) observe(response.found ? response.publication : undefined);
        return readyFromResponse(response);
      })
      .then((loaded) => {
        if (cancelled) return;
        setDraft(draftFromValues(loaded.values));
        setLoadState(loaded);

      })
      .catch(() => {
        if (!cancelled) setLoadState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, load, observe]);

  useEffect(() => {
    let cancelled = false;
    setPagesFailed(false);
    loadPages()
      .then((pages) => {
        if (cancelled) return;
        const published = pages.filter((page) => page.published === true);
        setPublishedPaths(new Map(published.map((page) => [page.id, page.livePath ?? page.path])));
        setCustomPages(
          published
            .filter((page) => isCustomPageId(page.id))
            .map((page) => ({
              id: page.id,
              title: page.liveTitle ?? page.title,
              path: page.livePath ?? page.path,
            })),
        );
      })
      .catch(() => {
        if (!cancelled) setPagesFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loadPages]);

  useEffect(() => {
    if (!pendingFocus || !sectionActive) return;
    for (const key of pendingFocus) {
      const element = focusTargets.current.get(key);
      if (element && !(element as HTMLButtonElement).disabled) {
        element.focus();
        if (element instanceof HTMLInputElement) element.scrollIntoView?.({ block: "center", inline: "nearest" });
        break;
      }
    }
    setPendingFocus(null);
  }, [pendingFocus, draft, sectionActive]);

  function toggleExpanded(key: string, focusKey: string) {
    setSelectedKey(current => current === key ? null : key);
    if (selectedKey !== key) setPendingFocus([focusKey]);
  }

  function focusRef(key: string) {
    return (element: HTMLElement | null) => {
      if (element) focusTargets.current.set(key, element);
      else focusTargets.current.delete(key);
    };
  }

  function inputFocusRef(key: string) {
    const register = focusRef(key);
    return (element: HTMLDivElement | null) => register(element?.querySelector("input") ?? null);
  }

  function update(next: (current: Draft) => Draft) {
    setDraft(next);
    setActionState((current) => (current.type === "conflict" ? current : { type: "idle" }));
  }

  function updateLinks(area: Area, change: (links: DraftLink[]) => DraftLink[]) {
    update((current) =>
      area.kind === "header"
        ? { ...current, header: change(current.header) }
        : {
            ...current,
            footer: current.footer.map((column) =>
              column.id === area.columnId ? { ...column, links: change(column.links) } : column,
            ),
          },
    );
  }

  function editLink(area: Area, linkId: string, patch: Partial<DraftLink>) {
    updateLinks(area, (links) =>
      links.map((link) => link.id === linkId ? {
        ...link,
        ...patch,
        external: patch.target && patch.target.type !== link.target.type &&
          !navigationTargetAllowsNewTab(patch.target)
          ? false
          : (patch.external ?? link.external),
      } : link),
    );
  }

  function areaName(area: Area): string {
    if (area.kind === "header") return "the header";
    const column = draft.footer.find(({ id }) => id === area.columnId);
    return `the ${column?.heading.trim() || "untitled"} column`;
  }

  function moveLink(area: Area, index: number, direction: -1 | 1) {
    const links = area.kind === "header"
      ? draft.header
      : draft.footer.find(({ id }) => id === area.columnId)?.links ?? [];
    const target = index + direction;
    if (target < 0 || target >= links.length) return;
    const link = links[index];
    updateLinks(area, (current) => move(current, index, target));
    const key = direction < 0 ? "up" : "down";
    const other = direction < 0 ? "down" : "up";
    const scope = scopeOf(area);
    setPendingFocus([`${scope}:link:${link.id}:${key}`, `${scope}:link:${link.id}:${other}`]);
    setAnnouncement(
      `Moved ${link.label.trim() || "link"} to position ${target + 1} of ${links.length} in ${areaName(area)}.`,
    );
  }

  function moveLinkToColumn(fromColumnId: string, linkId: string, toColumnId: string) {
    if (fromColumnId === toColumnId) return;
    const from = draft.footer.find(({ id }) => id === fromColumnId);
    const to = draft.footer.find(({ id }) => id === toColumnId);
    const link = from?.links.find(({ id }) => id === linkId);
    if (!from || !to || !link || to.links.length >= SITE_NAVIGATION_COLUMN_MAX_LINKS) return;
    update((current) => ({
      ...current,
      footer: current.footer.map((column) =>
        column.id === fromColumnId
          ? { ...column, links: column.links.filter(({ id }) => id !== linkId) }
          : column.id === toColumnId
            ? { ...column, links: [...column.links, link] }
            : column,
      ),
    }));
    setPendingFocus([`footer:link:${link.id}:column`]);
    setAnnouncement(
      `Moved ${link.label.trim() || "link"} to the end of the ${to.heading.trim() || "untitled"} column.`,
    );
  }

  function removeLink(area: Area, linkId: string) {
    if (LOCKED_LINK_IDS.has(linkId)) return;
    const link = (area.kind === "header"
      ? draft.header
      : draft.footer.find(({ id }) => id === area.columnId)?.links ?? []
    ).find(({ id }) => id === linkId);
    updateLinks(area, (links) => links.filter(({ id }) => id !== linkId));
    setPendingFocus([area.kind === "header" ? "add:header" : `add:${area.columnId}`]);
    setAnnouncement(`Removed ${link?.label.trim() || "link"} from ${areaName(area)}.`);
  }

  function addLink(area: Area) {
    const id = nextId(draft, "link");
    updateLinks(area, (links) => [...links, newLink(id)]);
    setSelectedKey(`${scopeOf(area)}:${id}`);
    setPendingFocus([`${scopeOf(area)}:link:${id}:label`]);
    setAnnouncement(`Added a link to ${areaName(area)}.`);
  }

  function moveColumn(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= draft.footer.length) return;
    const column = draft.footer[index];
    update((current) => ({ ...current, footer: move(current.footer, index, target) }));
    const key = direction < 0 ? "up" : "down";
    const other = direction < 0 ? "down" : "up";
    setPendingFocus([`column:${column.id}:${key}`, `column:${column.id}:${other}`]);
    setAnnouncement(
      `Moved the ${column.heading.trim() || "untitled"} column to position ${target + 1} of ${draft.footer.length}.`,
    );
  }

  function removeColumn(columnId: string) {
    const column = draft.footer.find(({ id }) => id === columnId);
    if (!column || column.links.some(({ id }) => LOCKED_LINK_IDS.has(id))) return;
    update((current) => ({
      ...current,
      footer: current.footer.filter(({ id }) => id !== columnId),
    }));
    setPendingFocus(["add:column"]);
    setAnnouncement(`Removed the ${column.heading.trim() || "untitled"} column.`);
  }

  function addColumn() {
    const columnId = nextId(draft, "column");
    const linkId = nextId(
      { ...draft, footer: [...draft.footer, { id: columnId, heading: "", links: [] }] },
      "link",
    );
    update((current) => ({
      ...current,
      footer: [...current.footer, { id: columnId, heading: "New column", links: [newLink(linkId)] }],
    }));
    setSelectedKey(`footer:${linkId}`);
    setPendingFocus([`column:${columnId}:heading`]);
    setAnnouncement("Added a footer column.");
  }

  function adopt(ready: ReadySettings) {
    setDraft(draftFromValues(ready.values));
    setLoadState(ready);
  }

  async function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loadState.status !== "ready" || pending) return;
    const values = canonicalValues(draft);
    if (validateCmsSettingsValues(SITE_NAVIGATION.schema, values)) return;
    setPending("save");
    setActionState({ type: "idle" });
    try {
      const response = await save(
        loadState.version === null
          ? { id: SITE_NAVIGATION_SETTINGS_ID, values, createOnly: true }
          : { id: SITE_NAVIGATION_SETTINGS_ID, values, baseVersion: loadState.version },
      );
      adopt(readyFromMutation(response));
      setActionState({ type: "saved" });
      successNotice.show("Site navigation draft saved.");
    } catch (error) {
      setActionState({ type: isConflictError(error) ? "conflict" : "save-error" });
    } finally {
      setPending(null);
    }
  }

  async function publishDraft() {
    if (loadState.status !== "ready" || pending || retrying || loadState.version === null) return;
    const values = canonicalValues(draft);
    if (
      validateCmsSettingsValues(SITE_NAVIGATION.schema, values) ||
      !valuesEqual(values, loadState.values)
    ) {
      return;
    }
    setPending("publish");
    setActionState({ type: "idle" });
    try {
      const response = await publish({ id: SITE_NAVIGATION_SETTINGS_ID,
        baseVersion: loadState.version });
      const published = readyFromMutation(response);
      if (!published.published || !response.publication) throw new Error("The settings publication receipt is missing.");
      adopt(published);
      observe(response.publication);
    } catch (error) {
      const message = settingsPublicationRefusalMessage(error);
      setActionState(message ? { type: "publish-error", message }
        : { type: isConflictError(error) ? "conflict" : "publish-error" });
    } finally {
      setPending(null);
    }
  }

  const reorder = useReorder({
    items: [
      ...draft.header.map(link => ({ id: `header:${link.id}`, label: link.label || "Untitled link", group: "header" })),
      ...draft.footer.flatMap(column => column.links.map(link => ({ id: `footer:${link.id}`, label: link.label || "Untitled link", group: column.id }))),
    ],
    disabled: pending !== null,
    onMove: (id, target) => {
      const linkId = id.slice(id.indexOf(":") + 1);
      const targetId = target.targetId.slice(target.targetId.indexOf(":") + 1);
      const column = draft.footer.find(item => item.links.some(link => link.id === linkId));
      const area: Area = id.startsWith("header:") ? { kind: "header" } : { kind: "column", columnId: column?.id ?? "" };
      updateLinks(area, current => {
        const link = current.find(item => item.id === linkId);
        if (!link || !current.some(item => item.id === targetId)) return current;
        const next = current.filter(item => item.id !== linkId);
        next.splice(next.findIndex(item => item.id === targetId) + (target.after ? 1 : 0), 0, link);
        return next;
      });
    },
  });
  useSettingsDirty(loadState.status === "ready" && !valuesEqual(canonicalValues(draft), loadState.values), pending !== null || retrying);

  if (loadState.status === "loading") return <SiteNavigationLoading />;
  if (loadState.status === "error") {
    return (
      <InlineMessage tone="error" title="Site navigation could not be loaded">
        <p>Try the request again.</p>
        <Button onClick={() => setAttempt((value) => value + 1)}>Retry</Button>
      </InlineMessage>
    );
  }

  const builtinPages: PageOption[] = PUBLIC_PAGES.map(({ id, title, path }) => ({
    id,
    title,
    path: publishedPaths.get(id) ?? path,
  }));
  const pageOptions = [...builtinPages, ...customPages];
  const values = canonicalValues(draft);
  const validationError = validateCmsSettingsValues(SITE_NAVIGATION.schema, values);
  const valid = validationError === null;
  const dirty = !valuesEqual(values, loadState.values);
  const publishedMatchesSaved = Boolean(
    loadState.published && valuesEqual(loadState.values, loadState.published.values),
  );
  const canPublish =
    valid &&
    !dirty &&
    loadState.version !== null &&
    (!publishedMatchesSaved || !publication);
  const livePaths = new Set(publishedPaths.values());
  const preview = valid
    ? resolveSiteNavigation({ header: values.header, footer: values.footer }, {
        postsIndexEnabled: true,
        pagePath: (pageId) => publishedPaths.get(pageId),
        hasPublishedPath: (path) => livePaths.has(path),
      })
    : null;
  const disabled = pending !== null;


  function renderLinkFields(area: Area, link: DraftLink) {
    const scope = scopeOf(area);
    const base = `site-nav-${scope}-${link.id}`;
    const locked = LOCKED_LINK_IDS.has(link.id);
    const labelError = linkFieldError(link);
    const hrefError = hrefFieldError(link);
    const warning = linkWarning(link, pageOptions);
    const labelBytes = utf8Bytes(link.label.trim());
    const target = link.target;
    const knownPage =
      target.type === "page" && pageOptions.some((page) => page.id === target.pageId);
    const opensInNewTab = siteNavigationLinkOpensInNewTab(link);
    return (
          <div className="site-nav-item-fields" id={`${base}-fields`}>
            <div className="site-nav-field" ref={inputFocusRef(`${scope}:link:${link.id}:label`)}>
              <label className="editor-field-label" htmlFor={`${base}-label`}>Label</label>
              <TextInput
                aria-describedby={describedBy(`${base}-label-count`, labelError && `${base}-label-error`)}
                aria-invalid={labelError ? "true" : undefined}
                className="field-control"
                disabled={disabled}
                id={`${base}-label`}
                onChange={(event) => editLink(area, link.id, { label: event.target.value })}
                value={link.label}
              />
              <small className="muted" id={`${base}-label-count`}>
                {labelBytes} of {SITE_NAVIGATION_LABEL_BYTES} bytes used.
              </small>
              {labelError ? (
                <small className="field-error" id={`${base}-label-error`}>{labelError}</small>
              ) : null}
            </div>

            <div className="site-nav-field">
              <label className="editor-field-label" htmlFor={`${base}-type`}>Links to</label>
              <Select
                aria-describedby={locked ? `${base}-locked` : undefined}
                disabled={disabled || locked}
                id={`${base}-type`}
                onChange={(event) => {
                  const choice = event.target.value as TargetChoice;
                  editLink(area, link.id, {
                    target: targetForChoice(choice, link.target),
                    ...(choice === "launch" ? { external: true } : {}),
                  });
                }}
                value={choiceFor(target)}
              >
                <option value="page">Page</option>
                {(Object.keys(ROUTE_CHOICES) as SiteNavigationRouteKey[]).map((key) => (
                  <option key={key} value={`route:${key}`}>{ROUTE_CHOICES[key].label}</option>
                ))}
                <option value="launch">PBS service</option>
                <option value="href">Web address</option>
              </Select>
            </div>

            {target.type === "page" ? (
              <div className="site-nav-field">
                <label className="editor-field-label" htmlFor={`${base}-page`}>Page</label>
                <Select
                  aria-describedby={locked ? `${base}-locked` : undefined}
                  disabled={disabled || locked}
                  id={`${base}-page`}
                  onChange={(event) =>
                    editLink(area, link.id, { target: { type: "page", pageId: event.target.value } })}
                  value={target.pageId}
                >
                  {!knownPage ? <option value={target.pageId}>Unpublished page</option> : null}
                  {pageOptions.map((page) => (
                    <option key={page.id} value={page.id}>
                      {page.title} ({page.path})
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}

            {target.type === "launch" ? (
              <div className="site-nav-field">
                <label className="editor-field-label" htmlFor={`${base}-launch`}>PBS service</label>
                <Select
                  disabled={disabled}
                  id={`${base}-launch`}
                  onChange={(event) =>
                    editLink(area, link.id, {
                      target: { type: "launch", key: event.target.value as SiteNavigationLaunchKey },
                    })}
                  value={target.key}
                >
                  {SITE_NAVIGATION_LAUNCH_KEYS.map((launchKey) => (
                    <option key={launchKey} value={launchKey}>{LAUNCH_LABELS[launchKey]}</option>
                  ))}
                </Select>
              </div>
            ) : null}

            {target.type === "href" ? (
              <div className="site-nav-field">
                <label className="editor-field-label" htmlFor={`${base}-href`}>Web address</label>
                <TextInput
                  aria-describedby={describedBy(
                    hrefError && `${base}-href-error`,
                    warning && `${base}-warning`,
                  )}
                  aria-invalid={hrefError ? "true" : undefined}
                  autoCapitalize="none"
                  disabled={disabled}
                  id={`${base}-href`}
                  inputMode="url"
                  onChange={(event) =>
                    editLink(area, link.id, { target: { type: "href", href: event.target.value } })}
                  spellCheck={false}
                  value={target.href}
                />
                {hrefError ? (
                  <small className="field-error" id={`${base}-href-error`}>{hrefError}</small>
                ) : null}
              </div>
            ) : null}

            {target.type === "route" ? (
              <p className="muted site-nav-route-note">{ROUTE_CHOICES[target.key].note}</p>
            ) : null}

            <label className="site-nav-external">
              <input
                checked={opensInNewTab}
                disabled={disabled || !navigationTargetAllowsNewTab(target)}
                onChange={(event) => editLink(area, link.id, { external: event.target.checked })}
                type="checkbox"
              />
              <span>External site. Opens a web address in a new tab.</span>
            </label>
          </div>

    );
  }

  function renderLink(area: Area, link: DraftLink, index: number, count: number) {
    const scope = scopeOf(area);
    const key = `${scope}:${link.id}`;
    const base = `site-nav-${scope}-${link.id}`;
    const name = link.label.trim() || "link";
    const locked = LOCKED_LINK_IDS.has(link.id);
    const labelError = linkFieldError(link);
    const hrefError = hrefFieldError(link);
    const warning = linkWarning(link, pageOptions);
    // Use the public resolver's rule so the row matches the site and preview.
    const summary = siteNavigationLinkSummary(link, pageOptions);
    // One selected link owns the inspector; row errors remain visible when closed.
    const open = selectedKey === key;
    return (
      <li {...reorder.itemProps(key)} className="site-nav-item" data-selected={open || undefined} data-locked={locked ? "true" : undefined} key={link.id}>
        <div className="site-nav-item-row">
          <ReorderHandle {...reorder.handleProps(key)} aria-label={`Reorder ${name}`} disabled={disabled} />
          <p className="site-nav-item-summary">
            <strong>{link.label.trim() || "Untitled link"}</strong>
            <span className="muted">
              {summary}
            </span>
          </p>
          <div className="site-nav-item-actions" role="group" aria-label={`Arrange ${name}`}>
            {area.kind === "column" && draft.footer.length > 1 ? (
              <select
                aria-label={`Column for ${name}`}
                className="field-control site-nav-move-column"
                disabled={disabled}
                onChange={(event) => moveLinkToColumn(area.columnId, link.id, event.target.value)}
                ref={focusRef(`${scope}:link:${link.id}:column`)}
                value={area.columnId}
              >
                {draft.footer.map((column) => (
                  <option
                    disabled={
                      column.id !== area.columnId &&
                      column.links.length >= SITE_NAVIGATION_COLUMN_MAX_LINKS
                    }
                    key={column.id}
                    value={column.id}
                  >
                    {column.id === area.columnId ? "In " : "Move to "}
                    {column.heading.trim() || "untitled column"}
                  </option>
                ))}
              </select>
            ) : null}
            <ActionControl action={open ? "close" : "edit"}
              aria-controls={open ? `${base}-fields` : undefined}
              aria-expanded={open}
              accessibleName={`${open ? "Close" : "Edit"} ${name}`}
              label={open ? "Close" : "Edit"}
              disabled={disabled}
              onClick={() => toggleExpanded(key, `${scope}:link:${link.id}:label`)}
              variant="secondary"
            >
            </ActionControl>
            <ActionControl action="move-up"
              accessibleName={`Move up, ${name}`}
              disabled={disabled || index === 0}
              onClick={() => moveLink(area, index, -1)}
              ref={focusRef(`${scope}:link:${link.id}:up`)}
              variant="ghost"
             />
            <ActionControl action="move-down"
              accessibleName={`Move down, ${name}`}
              disabled={disabled || index === count - 1}
              onClick={() => moveLink(area, index, 1)}
              ref={focusRef(`${scope}:link:${link.id}:down`)}
              variant="ghost"
             />
            <ActionControl action="remove-item"
              label="Remove"
              aria-describedby={locked ? `${base}-locked` : undefined}
              accessibleName={`Remove ${name}`}
              disabled={disabled || locked}
              onClick={() => removeLink(area, link.id)}
              variant="danger-quiet"
             />
          </div>
        </div>

        {labelError || hrefError ? <p className="field-error">{labelError || hrefError}{open ? " Correct this link in Link settings." : ` Select Edit ${name} to correct it.`}</p> : null}
        {warning ? (
          <p className="site-nav-warning" id={`${base}-warning`} role="status">{warning}</p>
        ) : null}
        {locked ? (
          <p className="muted site-nav-lock" id={`${base}-locked`}>
            Contact is required on every page for captioning and accessibility complaints. You can rename it or move it, including to another column, but you cannot remove it or change where it goes.
          </p>
        ) : null}


      </li>
    );
  }

  const footerHasErrors = draft.footer.some(column => !column.heading.trim() ||
    utf8Bytes(column.heading.trim()) > SITE_NAVIGATION_HEADING_BYTES || !column.links.length ||
    draft.footer.some(other => other.id !== column.id && other.heading.trim().replace(/\s+/g, " ").toLowerCase() === column.heading.trim().replace(/\s+/g, " ").toLowerCase()) ||
    column.links.some(link => Boolean(linkFieldError(link) || hrefFieldError(link))));
  const selectedArea: Area | null = selectedKey?.startsWith("header:") ? { kind: "header" }
    : selectedKey ? (() => { const column = draft.footer.find(item => item.links.some(link => `footer:${link.id}` === selectedKey)); return column ? { kind: "column" as const, columnId: column.id } : null; })() : null;
  const selectedLink = selectedArea?.kind === "header" ? draft.header.find(link => `header:${link.id}` === selectedKey)
    : selectedArea?.kind === "column" ? draft.footer.find(column => column.id === selectedArea.columnId)?.links.find(link => `footer:${link.id}` === selectedKey) : undefined;

  return (
    <Panel className="admin-settings-panel settings-public-panel" aria-labelledby="site-navigation-heading">
      <div className="panel-heading">
        <div>
          <h2 tabIndex={-1} id="site-navigation-heading">Site navigation</h2>
          <p>The header links and footer link columns on every public page.</p>
        </div>
      </div>

      <form className="admin-settings-form site-nav-settings settings-section-layout" onSubmit={saveDraft}>
        <div className="settings-section-fields">
        <p aria-atomic="true" aria-live="polite" className="sr-only" role="status">
          {announcement} {reorder.announcement}
        </p>

        <p id={reorder.helpId} className="sr-only">{reorder.instructions}</p>
        {pagesFailed ? (
          <InlineMessage tone="warning">
            Published custom pages could not be loaded. Built-in pages are still available.
          </InlineMessage>
        ) : null}

        <fieldset className="site-nav-area settings-card">
          <legend>Header links</legend>
          <p className="muted">
            {siteNavigationHeaderNote(draft.header.length, SITE_NAVIGATION_HEADER_MAX_ITEMS)}
          </p>
          <ol className="site-nav-list">
            {draft.header.map((link, index) =>
              renderLink({ kind: "header" }, link, index, draft.header.length))}
          </ol>
          <ActionControl action="add-item"
            label="Add header link"
            disabled={disabled || draft.header.length >= SITE_NAVIGATION_HEADER_MAX_ITEMS}
            onClick={() => addLink({ kind: "header" })}
            ref={focusRef("add:header")}
           accessibleName="Add header link" />
        </fieldset>

        <details className="settings-card" open={footerOpen || footerHasErrors} onToggle={event => {
          if (footerHasErrors && !event.currentTarget.open) event.currentTarget.open = true;
          setFooterOpen(event.currentTarget.open);
        }}>
          <summary>Footer columns · {draft.footer.length} {draft.footer.length === 1 ? "column" : "columns"}</summary>
        <fieldset className="site-nav-area">
          <legend className="sr-only">Footer columns</legend>
          <p className="muted">
            {siteNavigationFooterNote(draft.footer.length, SITE_NAVIGATION_FOOTER_MAX_COLUMNS, SITE_NAVIGATION_COLUMN_MAX_LINKS)}
          </p>
          <ol className="site-nav-columns">
            {draft.footer.map((column, index) => {
              const holdsLocked = column.links.some(({ id }) => LOCKED_LINK_IDS.has(id));
              const headingBytes = utf8Bytes(column.heading.trim());
              const headingError = !column.heading.trim()
                ? "Enter a heading."
                : headingBytes > SITE_NAVIGATION_HEADING_BYTES
                  ? `Use no more than ${SITE_NAVIGATION_HEADING_BYTES} bytes.`
                  : draft.footer.some((other) => other.id !== column.id &&
                      other.heading.trim().replace(/\s+/g, " ").toLowerCase() ===
                      column.heading.trim().replace(/\s+/g, " ").toLowerCase())
                    ? "Use a different heading for each footer column."
                    : null;
              const base = `site-nav-column-${column.id}`;
              const area: Area = { kind: "column", columnId: column.id };
              return (
                <li className="site-nav-column" key={column.id}>
                  <div className="site-nav-column-head">
                    <div className="site-nav-field" ref={inputFocusRef(`column:${column.id}:heading`)}>
                      <label className="editor-field-label" htmlFor={`${base}-heading`}>Column heading</label>
                      <TextInput
                        aria-describedby={describedBy(`${base}-heading-count`, headingError && `${base}-heading-error`)}
                        aria-invalid={headingError ? "true" : undefined}
                        className="field-control"
                        disabled={disabled}
                        id={`${base}-heading`}
                        onChange={(event) =>
                          update((current) => ({
                            ...current,
                            footer: current.footer.map((item) =>
                              item.id === column.id ? { ...item, heading: event.target.value } : item),
                          }))}
                        value={column.heading}
                      />
                      <small className="muted" id={`${base}-heading-count`}>
                        {headingBytes} of {SITE_NAVIGATION_HEADING_BYTES} bytes used.
                      </small>
                      {headingError ? (
                        <small className="field-error" id={`${base}-heading-error`}>{headingError}</small>
                      ) : null}
                    </div>
                    <div
                      className="site-nav-item-actions"
                      role="group"
                      aria-label={`Arrange the ${column.heading.trim() || "untitled"} column`}
                    >
                      <ActionControl action="move-up"
                        accessibleName={`Move up, ${column.heading.trim() || "untitled"} column`}
                        disabled={disabled || index === 0}
                        onClick={() => moveColumn(index, -1)}
                        ref={focusRef(`column:${column.id}:up`)}
                        variant="ghost"
                       />
                      <ActionControl action="move-down"
                        accessibleName={`Move down, ${column.heading.trim() || "untitled"} column`}
                        disabled={disabled || index === draft.footer.length - 1}
                        onClick={() => moveColumn(index, 1)}
                        ref={focusRef(`column:${column.id}:down`)}
                        variant="ghost"
                       />
                      <ActionControl action="remove-item"
                        label="Remove column"
                        aria-describedby={holdsLocked ? `${base}-locked` : undefined}
                        accessibleName={`Remove column, ${column.heading.trim() || "untitled"}`}
                        disabled={disabled || holdsLocked}
                        onClick={() => removeColumn(column.id)}
                        variant="danger-quiet"
                       />
                    </div>
                    {holdsLocked ? (
                      <p className="muted site-nav-lock" id={`${base}-locked`}>
                        This column holds the Contact link. Move Contact to another column before you remove it.
                      </p>
                    ) : null}
                  </div>
                  <ol className="site-nav-list">
                    {column.links.map((link, linkIndex) =>
                      renderLink(area, link, linkIndex, column.links.length))}
                  </ol>
                  <ActionControl action="add-item"
                    label={`Add link to ${column.heading.trim() || "this column"}`}
                    disabled={disabled || column.links.length >= SITE_NAVIGATION_COLUMN_MAX_LINKS}
                    onClick={() => addLink(area)}
                    ref={focusRef(`add:${column.id}`)}
                   accessibleName={`Add link to ${column.heading.trim() || "this column"}`} />
                </li>
              );
            })}
          </ol>
          <ActionControl action="add-item"
            label="Add footer column"
            disabled={disabled || draft.footer.length >= SITE_NAVIGATION_FOOTER_MAX_COLUMNS}
            onClick={addColumn}
            ref={focusRef("add:column")}
           accessibleName="Add footer column" />
        </fieldset>

        </details>
        <PostsBrowseEditor value={draft.postsBrowse} disabled={disabled} loadVocabulary={loadVocabulary} onChange={postsBrowse => update(current => ({ ...current, postsBrowse }))} />
        <section className="site-nav-required settings-card" aria-labelledby="site-nav-required-heading">
          <h3 id="site-nav-required-heading">Required links</h3>
          <p>
            These links appear on every page and cannot be edited here. FCC rules require the public inspection file links on every page. The station's captioning and ADA obligations require the closed captioning, accessibility and contact paths.
          </p>
          <dl>
            <div>
              <dt>FCC public inspection file</dt>
              <dd>{REQUIRED_FCC_LINKS.join(", ")}</dd>
            </div>
            <div>
              <dt>Legal row</dt>
              <dd>{REQUIRED_LEGAL_LINKS.join(", ")}</dd>
            </div>
          </dl>
        </section>

        </div>
        <SettingsInspector label="Selected link and publication">
          <EditorFrameHeader scope="panel" title="Link settings" />
          {selectedLink && selectedArea ? renderLinkFields(selectedArea, selectedLink) : <p>Select a link to edit its label and destination.</p>}
        <section className="site-nav-preview-section" aria-labelledby="site-nav-preview-heading">
          <div className="site-nav-preview-toolbar">
            <h3 id="site-nav-preview-heading">Preview</h3>
            <div role="group" aria-label="Preview width">
              <Button
                aria-pressed={previewWidth === "desktop"}
                onClick={() => setPreviewWidth("desktop")}
                variant={previewWidth === "desktop" ? "primary" : "secondary"}
              >
                Desktop
              </Button>
              <Button
                aria-pressed={previewWidth === "phone"}
                onClick={() => setPreviewWidth("phone")}
                variant={previewWidth === "phone" ? "primary" : "secondary"}
              >
                Phone
              </Button>
            </div>
          </div>
          {preview ? (
            <div className="site-nav-preview" data-width={previewWidth}>
              <div className="site-nav-preview-header">
                <span className="site-nav-preview-brand">NJ PBS</span>
                <ul aria-label="Header preview">
                  {preview.header.map((link) => (
                    <li key={link.id}>
                      {link.label}
                      {link.opensInNewTab ? <span aria-label=" (opens in new tab)"> ↗</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="site-nav-preview-footer">
                {preview.footer.map((column) => (
                  <div key={column.id}>
                    <strong>{column.heading}</strong>
                    <ul aria-label={`${column.heading} preview`}>
                      {column.links.map((link) => (
                        <li key={link.id}>
                          {link.label}
                          {link.opensInNewTab ? <span aria-label=" (opens in new tab)"> ↗</span> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="muted">Fix the problem above to update the preview.</p>
          )}
        </section>

        {validationError ? (
          <p className="field-error" role="alert">{describeNavigationError(validationError)}</p>
        ) : null}

        <dl className="public-banner-status" aria-label="Site navigation status">
          <div>
            <dt>Edit state</dt>
            <dd>{dirty ? "Unsaved changes" : "No unsaved changes"}</dd>
          </div>
          <div>
            <dt>Saved draft</dt>
            <dd>{loadState.version === null ? "Draft not saved" : `Saved draft version ${loadState.version}`}</dd>
          </div>
          <div>
            <dt>Published</dt>
            <dd><PublishedStatus published={loadState.published} /></dd>
          </div>
        </dl>

        {actionState.type === "saved" && !successNotice.available ? (
          <InlineMessage tone="success">Site navigation draft saved.</InlineMessage>
        ) : null}
        {actionState.type === "conflict" ? (
          <InlineMessage tone="error">
            <p>This setting changed after you opened it.</p>
            <Button type="button" onClick={() => setAttempt((value) => value + 1)}>
              Reload saved navigation
            </Button>
          </InlineMessage>
        ) : null}
        {actionState.type === "save-error" ? (
          <InlineMessage tone="error">The site navigation draft could not be saved. Try again.</InlineMessage>
        ) : null}
        {actionState.type === "publish-error" ? (
          <InlineMessage tone="error">{actionState.message ?? "The site navigation could not be published. Try again."}</InlineMessage>
        ) : null}
        <SettingsPublicationStatus publication={publication} retry={retry} retrying={retrying} refresh={refresh} needsRefresh={needsRefresh} disabled={pending !== null} />

      </SettingsInspector>
      <div className="settings-section-actions">
        <p className="admin-settings-save-note">
          Save draft keeps your changes as a draft. The public site does not change. Publish updates the public site from the saved draft.
        </p>
        <div className="admin-settings-actions">
          <AsyncActionButton
            disabled={disabled || !valid || !dirty}
            label="Save draft"
            pending={pending === "save"}
            pendingAnnouncement="Saving site navigation draft."
            pendingLabel="Saving…"
            type="submit"
            variant="secondary"
          />
          <AsyncActionButton
            disabled={disabled || retrying || !canPublish}
            label="Publish"
            onClick={() => void publishDraft()}
            pending={pending === "publish"}
            pendingAnnouncement="Starting site navigation publication."
            pendingLabel="Starting…"
            type="button"
            variant="primary"
          />
        </div>
      </div>
      </form>
    </Panel>
  );
}
