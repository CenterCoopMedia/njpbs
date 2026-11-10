import type { IconName } from "../components/ui/Icon";

export type IconControlId =
  | "refresh"
  | "revision-history"
  | "focus-writing"
  | "change-density"
  | "video-checks"
  | "edit"
  | "arrange"
  | "outline"
  | "preview"
  | "add-item"
  | "remove-item"
  | "table-add-row"
  | "table-add-column"
  | "table-remove-row"
  | "table-remove-column"
  | "upload-csv"
  | "export-csv"
  | "float-toolbar"
  | "pin-toolbar"
  | "move-toolbar"
  | "paragraph"
  | "code-block"
  | "horizontal-rule"
  | "clear-formatting"
  | "indent-list"
  | "outdent-list"
  | "select-all"
  | "add-block"
  | "bold"
  | "bulleted-list"
  | "close"
  | "close-menu"
  | "collapse"
  | "expand"
  | "heading"
  | "hide"
  | "inline-code"
  | "inspector-close"
  | "inspector-open"
  | "italic"
  | "link"
  | "move-down"
  | "move-main"
  | "move-side"
  | "move-up"
  | "move-content"
  | "next-page"
  | "numbered-list"
  | "open-menu"
  | "previous-page"
  | "quote"
  | "redo"
  | "settings"
  | "show"
  | "sidebar-collapse"
  | "sidebar-expand"
  | "undo"
  | "view-options"
  | "media-display"
  | "media-more"
  | "media-transcript"
  | "media-clip"
  | "media-copy-link"
  | "media-favorite"
  | "media-collect"
  | "media-select";

interface IconControlSpec {
  alwaysIcon?: boolean;
  iconEligible: true;
  label: string;
  icon?: IconName;
  glyph?: string;
  risk: "low";
  state: "action" | "disclosure" | "toggle";
}

export const ICON_CONTROL_REGISTRY: Record<IconControlId, IconControlSpec> = {
  refresh: { iconEligible: true, label: "Refresh", icon: "refresh", risk: "low", state: "action" },
  "revision-history": { iconEligible: true, label: "Revision history", icon: "history", risk: "low", state: "disclosure" },
  "focus-writing": { iconEligible: true, label: "Focus writing", icon: "maximize", risk: "low", state: "toggle" },
  "change-density": { iconEligible: true, label: "Density", icon: "list", risk: "low", state: "action" },
  "video-checks": { iconEligible: true, label: "Video checks", icon: "check-square", risk: "low", state: "disclosure" },
  edit: { iconEligible: true, label: "Edit", icon: "pencil", risk: "low", state: "action" },
  arrange: { iconEligible: true, label: "Arrange", icon: "stack", risk: "low", state: "toggle" },
  outline: { iconEligible: true, label: "Outline", icon: "outline", risk: "low", state: "disclosure" },
  preview: { iconEligible: true, label: "Preview", icon: "monitor", risk: "low", state: "action" },
  "move-content": { iconEligible: true, label: "Move to…", icon: "sort", risk: "low", state: "disclosure" },
  // Context comes from the adjacent field/list. These edit a draft or selection;
  // they must never stand in for deleting a stored record, publishing, or uploading.
  "add-item": { iconEligible: true, label: "Add item", icon: "plus", risk: "low", state: "action" },
  "remove-item": { iconEligible: true, label: "Remove item", icon: "close", risk: "low", state: "action" },
  "table-add-row": { iconEligible: true, label: "Add row", icon: "table-row", risk: "low", state: "action" },
  "table-add-column": { iconEligible: true, label: "Add column", icon: "table-column", risk: "low", state: "action" },
  "table-remove-row": { iconEligible: true, label: "Remove row", icon: "trash", risk: "low", state: "action" },
  "table-remove-column": { iconEligible: true, label: "Remove column", icon: "trash", risk: "low", state: "action" },
  "upload-csv": {
    iconEligible: true,
    label: "Upload CSV",
    icon: "upload",
    risk: "low",
    state: "action",
  },
  "export-csv": {
    iconEligible: true,
    label: "Export CSV",
    icon: "download",
    risk: "low",
    state: "action",
  },
  "float-toolbar": {
    iconEligible: true,
    label: "Float toolbar",
    icon: "external-link",
    risk: "low",
    state: "action",
  },
  "pin-toolbar": {
    iconEligible: true,
    label: "Pin toolbar",
    icon: "lock",
    risk: "low",
    state: "action",
  },
  "move-toolbar": {
    iconEligible: true,
    label: "Move toolbar",
    icon: "grip",
    risk: "low",
    state: "action",
  },
  "paragraph": {
    iconEligible: true,
    label: "Paragraph",
    glyph: "P",
    risk: "low",
    state: "toggle",
  },
  "code-block": {
    iconEligible: true,
    label: "Code block",
    glyph: "{}",
    risk: "low",
    state: "toggle",
  },
  "horizontal-rule": {
    iconEligible: true,
    label: "Horizontal rule",
    icon: "remove",
    risk: "low",
    state: "action",
  },
  "clear-formatting": {
    iconEligible: true,
    label: "Clear formatting",
    glyph: "Tx",
    risk: "low",
    state: "action",
  },
  "indent-list": {
    iconEligible: true,
    label: "Indent list",
    icon: "arrow-right",
    risk: "low",
    state: "action",
  },
  "outdent-list": {
    iconEligible: true,
    label: "Outdent list",
    icon: "arrow-left",
    risk: "low",
    state: "action",
  },
  "select-all": {
    iconEligible: true,
    label: "Select all",
    glyph: "A",
    risk: "low",
    state: "action",
  },
  "add-block": {
    iconEligible: true,
    label: "Add block",
    icon: "plus",
    risk: "low",
    state: "disclosure",
  },
  bold: {
    iconEligible: true,
    label: "Bold",
    icon: "bold",
    risk: "low",
    state: "toggle",
  },
  "bulleted-list": {
    iconEligible: true,
    label: "Bulleted list",
    icon: "list",
    risk: "low",
    state: "toggle",
  },
  close: {
    alwaysIcon: true,
    iconEligible: true,
    label: "Close",
    icon: "close",
    risk: "low",
    state: "action",
  },
  "close-menu": {
    iconEligible: true,
    label: "Close menu",
    icon: "close",
    risk: "low",
    state: "disclosure",
  },
  collapse: {
    alwaysIcon: true,
    iconEligible: true,
    label: "Collapse",
    icon: "chevron-up",
    risk: "low",
    state: "disclosure",
  },
  expand: {
    alwaysIcon: true,
    iconEligible: true,
    label: "Expand",
    icon: "chevron-down",
    risk: "low",
    state: "disclosure",
  },
  heading: {
    iconEligible: true,
    label: "Heading",
    glyph: "H",
    risk: "low",
    state: "toggle",
  },
  hide: {
    iconEligible: true,
    label: "Hide from page",
    icon: "eye-off",
    risk: "low",
    state: "action",
  },
  "inline-code": {
    iconEligible: true,
    label: "Inline code",
    icon: "code",
    risk: "low",
    state: "toggle",
  },
  "inspector-close": {
    alwaysIcon: true,
    iconEligible: true,
    label: "Hide settings panel",
    icon: "panel-right",
    risk: "low",
    state: "disclosure",
  },
  "inspector-open": {
    alwaysIcon: true,
    iconEligible: true,
    label: "Show settings panel",
    icon: "panel-left",
    risk: "low",
    state: "disclosure",
  },
  italic: {
    iconEligible: true,
    label: "Italic",
    icon: "italic",
    risk: "low",
    state: "toggle",
  },
  link: {
    iconEligible: true,
    label: "Link",
    icon: "link",
    risk: "low",
    state: "disclosure",
  },
  "move-down": {
    alwaysIcon: true,
    iconEligible: true,
    label: "Move down",
    icon: "arrow-down",
    risk: "low",
    state: "action",
  },
  "move-main": {
    iconEligible: true,
    label: "Move to main",
    icon: "arrow-left",
    risk: "low",
    state: "action",
  },
  "move-side": {
    iconEligible: true,
    label: "Move to side",
    icon: "arrow-right",
    risk: "low",
    state: "action",
  },
  "move-up": {
    alwaysIcon: true,
    iconEligible: true,
    label: "Move up",
    icon: "arrow-up",
    risk: "low",
    state: "action",
  },
  "next-page": {
    iconEligible: true,
    label: "Next page",
    icon: "arrow-right",
    risk: "low",
    state: "action",
  },
  "numbered-list": {
    iconEligible: true,
    label: "Numbered list",
    icon: "list-ordered",
    risk: "low",
    state: "toggle",
  },
  "open-menu": {
    iconEligible: true,
    label: "Open menu",
    icon: "menu",
    risk: "low",
    state: "disclosure",
  },
  "previous-page": {
    iconEligible: true,
    label: "Previous page",
    icon: "arrow-left",
    risk: "low",
    state: "action",
  },
  quote: {
    iconEligible: true,
    label: "Quote",
    icon: "quote",
    risk: "low",
    state: "toggle",
  },
  redo: {
    iconEligible: true,
    label: "Redo",
    icon: "redo",
    risk: "low",
    state: "action",
  },
  settings: {
    iconEligible: true,
    label: "Settings",
    icon: "settings",
    risk: "low",
    state: "disclosure",
  },
  show: {
    iconEligible: true,
    label: "Show on page",
    icon: "eye",
    risk: "low",
    state: "action",
  },
  "sidebar-collapse": {
    iconEligible: true,
    label: "Collapse primary navigation",
    icon: "panel-left",
    risk: "low",
    state: "disclosure",
  },
  "sidebar-expand": {
    iconEligible: true,
    label: "Expand primary navigation",
    icon: "panel-left",
    risk: "low",
    state: "disclosure",
  },
  undo: {
    iconEligible: true,
    label: "Undo",
    icon: "undo",
    risk: "low",
    state: "action",
  },
  "view-options": {
    iconEligible: true,
    label: "View options",
    icon: "sliders",
    risk: "low",
    state: "disclosure",
  },
  // The media toolbar's Display popover trigger (layout, size, density, sort and fields).
  "media-display": {
    iconEligible: true,
    label: "Display",
    icon: "sliders",
    risk: "low",
    state: "disclosure",
  },
  // Media card quick actions and the card's More menu trigger. They stay icons in every
  // presentation because a card has no room for text labels.
  "media-more": {
    alwaysIcon: true,
    iconEligible: true,
    label: "More actions",
    icon: "ellipsis",
    risk: "low",
    state: "disclosure",
  },
  "media-transcript": { iconEligible: true, label: "Transcript", icon: "content", risk: "low", state: "disclosure" },
  "media-clip": { iconEligible: true, label: "Create clip", icon: "video", risk: "low", state: "disclosure" },
  "media-copy-link": { iconEligible: true, label: "Copy link", icon: "link", risk: "low", state: "action" },
  "media-favorite": {
    alwaysIcon: true,
    iconEligible: true,
    label: "Favorite",
    icon: "heart",
    risk: "low",
    state: "toggle",
  },
  "media-collect": {
    alwaysIcon: true,
    iconEligible: true,
    label: "Add to collection",
    icon: "folder-plus",
    risk: "low",
    state: "action",
  },
  "media-select": {
    alwaysIcon: true,
    iconEligible: true,
    label: "Select",
    icon: "check-square",
    risk: "low",
    state: "toggle",
  },
};
