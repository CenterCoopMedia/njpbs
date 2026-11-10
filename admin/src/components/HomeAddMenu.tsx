import { useState } from "react";
import type { BlockType } from "../../../packages/content-core/src/content-model";
import { BLOCK_LABELS, SECTION_BLOCK_TOTAL_MAX } from "../../../packages/content-core/src/editor-admin";
import type { HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render";
import type { HomeSelectionReceipt } from "../../../packages/content-core/src/home-source-selection";
import type { AdminBlock } from "../lib/block-factory";
import { contentPlacementReason, type ContentDestination } from "../lib/content-row-editing";
import { BLOCK_TYPE_ICONS } from "./ContentPicker";
import { useHomePostSectionControl } from "./HomePostSectionControl";
import { Menu, type MenuItem } from "./ui/Menu";
import type { IconName } from "./ui/Icon";
import "./home-add-menu.css";

export type OptionalHomeSection = "home-newsletter" | "home-newscast" | "home-donor";
const OPTIONAL_SECTIONS: { section: OptionalHomeSection; title: string; icon: IconName }[] = [
  { section: "home-newsletter", title: "Newsletter signup", icon: "check-square" },
  { section: "home-newscast", title: "Newscast", icon: "microphone" },
  { section: "home-donor", title: "Donor-advised giving", icon: "users" },
];
const RESTORABLE_SECTIONS = [
  ["home-featured", "Featured programs", "video"], ["home-passport-copy", "Passport", "lock"],
  ["home-more", "More to watch", "external-link"], ["home-spotlight", "NJ Spotlight News", "flag"],
] as const;
const HOME_MENU_BLOCK_ICONS: Readonly<Record<BlockType, IconName>> = {
  ...BLOCK_TYPE_ICONS, image_gallery: "table-row",
};

export function HomeAddMenu({ variant = "secondary", blocks, palette, allowRows, readOnly, destination, loadSources, onAddSection, onRestore, onAddPosts, onInsert }: {
  variant?: "secondary" | "ghost";
  blocks: AdminBlock[];
  palette: readonly BlockType[];
  allowRows: boolean;
  readOnly: boolean;
  destination: ContentDestination;
  loadSources?: (signal: AbortSignal) => Promise<HomeSourceSnapshot>;
  onAddSection: (section: OptionalHomeSection) => void;
  onRestore: (id: string) => void;
  onAddPosts: (receipt: HomeSelectionReceipt) => void;
  onInsert: (type: BlockType, destination: ContentDestination) => string | null;
}) {
  const [insertError, setInsertError] = useState("");
  const insert = (type: BlockType) => {
    if (readOnly) return;
    setInsertError(onInsert(type, destination) ? "" : "This content could not be added. Choose an existing position and try again.");
  };
  const posts = blocks.find(block => block.section === "home-posts");
  const atLimit = blocks.length >= SECTION_BLOCK_TOTAL_MAX.home;
  const postControl = useHomePostSectionControl({ exists: Boolean(posts), hidden: posts?.visible === false,
    disabled: readOnly || !posts && atLimit, loadSources, onAdd: onAddPosts,
    onRestore: () => { if (posts) onRestore(posts.id); } });
  const items: MenuItem[] = [
    { key: "home-posts", label: "NJ PBS Post section", description: posts ? "Restore hidden section" : undefined, icon: "content", group: "Home sections",
      hidden: posts?.visible === true || !posts && atLimit, onSelect: () => { void postControl.add(); } },
    ...OPTIONAL_SECTIONS.map(({ section, title, icon }) => {
      const block = blocks.find(block => block.section === section);
      return { key: section, label: title, description: block ? "Restore hidden section" : undefined, icon, group: "Home sections",
        hidden: block?.visible === true || !block && atLimit, onSelect: () => onAddSection(section) };
    }),
    ...RESTORABLE_SECTIONS.map(([section, title, icon]) => {
      const block = blocks.find(block => block.section === section);
      return { key: section, label: title, description: "Restore hidden section", icon, group: "Home sections",
        hidden: !block || block.visible, onSelect: () => { if (block) onRestore(block.id); } };
    }),
    ...palette.map(type => ({ key: `block-${type}`, label: BLOCK_LABELS[type][0].toLocaleUpperCase() + BLOCK_LABELS[type].slice(1), icon: HOME_MENU_BLOCK_ICONS[type], group: "Content blocks",
      hidden: atLimit || Boolean(contentPlacementReason(blocks, type, destination)), onSelect: () => insert(type) })),
    { key: "block-row", label: "Row", icon: HOME_MENU_BLOCK_ICONS.row, group: "Content blocks",
      hidden: !allowRows || atLimit || Boolean(destination.layout), onSelect: () => insert("row") },
  ];
  return <div className="home-add-toolbar">
    <Menu variant={variant} label="Add" icon="plus" showGroupLabels fitBelow items={items} disabled={readOnly || postControl.busy}>
      {postControl.busy ? "Adding section…" : "Add"}
    </Menu>
    {destination.layout ? <span className="muted">Adding to row {blocks.filter(block => block.type === "row").findIndex(block => block.id === destination.layout!.rowId) + 1}, column {destination.layout.column + 1}</span> : null}
    {atLimit ? <span className="muted">Remove a plank to make room for new content.</span> : null}
    {postControl.error ? <p role="alert">{postControl.error}</p> : null}
    {insertError ? <p role="alert">{insertError}</p> : null}
  </div>;
}
