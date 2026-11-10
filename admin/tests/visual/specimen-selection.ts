import type { VisualSpecimenPair } from "../../src/lib/visual-specimens";

// Keep shared control states in both modes and sizes, plus representative staff tasks.
export const specimenCapturePairs: VisualSpecimenPair[] = [
  { id: "control-roles", title: "control-roles", width: 1280, presentation: "text" },
  { id: "control-roles", title: "control-roles", width: 1280, presentation: "icons" },
  { id: "control-roles", title: "control-roles", width: 320, presentation: "text" },
  { id: "control-roles", title: "control-roles", width: 320, presentation: "icons" },
  { id: "auth-loading", title: "auth-loading", width: 320, presentation: "text" },
  { id: "shell-home", title: "shell-home", width: 1280, presentation: "icons" },
  { id: "shell-home", title: "shell-home", width: 320, presentation: "text" },
  { id: "content-library", title: "content-library", width: 1280, presentation: "icons" },
  { id: "content-library", title: "content-library", width: 320, presentation: "text" },
  { id: "shell-editor", title: "shell-editor", width: 1280, presentation: "icons" },
  { id: "shell-editor", title: "shell-editor", width: 320, presentation: "text" },
  { id: "post-metadata", title: "post-metadata", width: 1280, presentation: "icons" },
  { id: "post-metadata", title: "post-metadata", width: 320, presentation: "text" },
  { id: "users", title: "users", width: 1280, presentation: "icons" },
  { id: "users", title: "users", width: 320, presentation: "text" },
  { id: "navigation-preferences", title: "navigation-preferences", width: 320, presentation: "text" },
  { id: "admin-settings-public-site-chrome", title: "admin-settings-public-site-chrome", width: 1280, presentation: "icons" },
  { id: "admin-settings-public-site-chrome", title: "admin-settings-public-site-chrome", width: 320, presentation: "text" },
  { id: "media-toolbar", title: "media-toolbar", width: 1280, presentation: "icons" },
  { id: "media-toolbar", title: "media-toolbar", width: 320, presentation: "text" },
  { id: "media-inspector-bulk", title: "media-inspector-bulk", width: 320, presentation: "text" },
  { id: "media-full-viewer-video", title: "media-full-viewer-video", width: 1280, presentation: "icons" },
  { id: "media-full-viewer-video", title: "media-full-viewer-video", width: 320, presentation: "text" },
];
