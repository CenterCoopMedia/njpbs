import type { EditorField, EditorFieldGroup } from "../../../packages/content-core/src/editor-admin";
import { publicPostTopics } from "../../../packages/content-core/src/post-formats";
import type { ReactNode } from "react";
import type { BylineAuthorOption } from "../lib/functions";
import type { BentoPanel } from "./EditorBento";
import { Icon } from "./ui/Icon";

export function renderPostStoryMetadata(
  record: Record<string, unknown>,
  bylineAuthors: readonly BylineAuthorOption[] | undefined,
  inPostWorkspace: boolean,
  storyMetaLink: (key: string) => void,
) {
  const byline = Array.isArray(record.credits) ? record.credits.map(credit => {
    if (!credit || typeof credit !== "object") return "";
    const value = credit as Record<string, unknown>;
    return value.kind === "custom" ? String(value.name ?? "")
      : value.kind === "registered" ? bylineAuthors?.find(author => author.authorId === value.authorId)?.displayName ?? (typeof value.displayName === "string" ? value.displayName : "Author no longer listed")
      : "Credit needs review";
  }).filter(Boolean).join(", ") : "";
  const parsedEditorialDate = typeof record.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.date) ? new Date(`${record.date}T12:00:00Z`) : null;
  const editorialDate = parsedEditorialDate && Number.isFinite(parsedEditorialDate.getTime()) && parsedEditorialDate.toISOString().slice(0, 10) === record.date
    ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(parsedEditorialDate)
    : typeof record.date === "string" && record.date.trim() ? record.date : "Date not set";
  const storyMeta = inPostWorkspace ? <div className="post-story-meta" aria-label="Story metadata">
    <a href="#record-post-credits" onClick={event => { event.preventDefault(); storyMetaLink("credits"); }}><Icon name="users" />{byline || "Add a byline"}</a>
    <a href="#record-post-date" onClick={event => { event.preventDefault(); storyMetaLink("date"); }}><Icon name="calendar" />{editorialDate}</a>
    <a href="#record-post-categories" onClick={event => { event.preventDefault(); storyMetaLink("categories"); }}><Icon name="tag" />{Array.isArray(record.categories) && record.categories.length ? record.categories.join(" · ") : "Add categories"}</a>
  </div> : null;
  return { editorialDate, storyMeta };
}

interface PostMetadataPanelOptions {
  groups: readonly EditorFieldGroup[];
  inPostWorkspace: boolean;
  isPostWritingField: (field: EditorField) => boolean;
  record: Record<string, unknown>;
  postTags: string[];
  editorialDate: string;
  interactionLocked: boolean;
  renderFieldGroup: (group: EditorFieldGroup, fields: readonly EditorField[], headless: boolean) => ReactNode;
}

export function buildPostMetadataPanels({
  groups,
  inPostWorkspace,
  isPostWritingField,
  record,
  postTags,
  editorialDate,
  interactionLocked,
  renderFieldGroup,
}: PostMetadataPanelOptions): BentoPanel[] {
  return groups.flatMap<BentoPanel>((group) => {
    if (inPostWorkspace && ["social", "excerpt"].includes(group.id)) return [];
    let groupFields = group.fields.filter(field => !isPostWritingField(field));
    if (inPostWorkspace && group.id === "hero-image") groupFields = groupFields.filter(field => ["heroBackgroundImage", "heroImage"].includes(field.key));
    if (inPostWorkspace && group.id === "search") groupFields = [...groupFields, ...(groups.find(group => group.id === "social")?.fields ?? [])];
    if (inPostWorkspace && group.id === "details") groupFields = [...groupFields, ...(groups.find(group => group.id === "excerpt")?.fields ?? [])];
    if (groupFields.length === 0) return [];
    const organizationSummary = (key: "categories" | "tags", label: string) => <div className="editor-organization-summary"><span>{label}</span><span className="editor-organization-chips">{
      Array.isArray(record[key]) ? (key === "tags" ? publicPostTopics(postTags) : record[key] as unknown[]).map((value, index) => <span className="post-metadata-chip" data-primary={index === 0 || undefined} key={index}>{typeof value === "string" ? value : "Saved value needs review"}</span>)
      : record[key] == null ? "Not set" : "Saved value needs review"
    }</span></div>;
    return [{
      id: group.id,
      title: inPostWorkspace && group.id === "search" ? "Search & sharing" : group.label,
      subtitle: group.help,
      collapsible: inPostWorkspace && ["basics", "hero-image", "organization"].includes(group.id) ? false : undefined,
      aside: inPostWorkspace && group.id === "dates" ? <span className="editor-inspector-date">{editorialDate}</span> : undefined,
      defaultZone: "side",
      defaultCollapsed: !(inPostWorkspace ? ["basics", "hero-image", "organization"] : ["organization", "hero-image"]).includes(group.id),
      body: inPostWorkspace && group.id === "organization" ? <details className="editor-organization-details"><summary aria-label={interactionLocked ? "View organization" : "Edit organization"}>
        {organizationSummary("categories", "Categories · primary first")}{organizationSummary("tags", "Tags · displayed tags first")}<Icon name="pencil" />
      </summary><div>{renderFieldGroup(group, groupFields, true)}</div></details> : <>{renderFieldGroup(group, groupFields, true)}
        {inPostWorkspace && group.id === "hero-image" ? <p className="editor-image-role-note">Header background and lead media are set separately; changing one does not change the other.</p> : null}</>,
    }];
  });
}
