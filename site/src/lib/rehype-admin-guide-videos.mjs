const ADMIN_GUIDE = "https://admin.njpbs.org";

function text(value) {
  return typeof value === "string" ? value : "";
}

export function rewriteGuideHtml(value) {
  return value
    .replaceAll('href="/guide/', 'href="https://admin.njpbs.org/guide/')
    .replace(
      /<video\b[^>]*\bsrc="\/guide-content\/videos\/[a-z0-9-]+\.mp4"[^>]*>[\s\S]*?<\/video>/g,
      '<a href="https://admin.njpbs.org/guide/video-tutorials">Open this video in the Boardwalk guide</a>',
    );
}

function rewrite(node) {
  if (!node) return;
  if (node.type === "raw" && typeof node.value === "string") {
    node.value = rewriteGuideHtml(node.value);
    return;
  }
  if (node.type !== "element") return;
  if (node.tagName === "a" && text(node.properties?.href).startsWith("/guide/")) {
    node.properties.href = `${ADMIN_GUIDE}${node.properties.href}`;
  }
  if (node.tagName === "video") {
    const src = text(node.properties?.src);
    if (/^\/guide-content\/videos\/[a-z0-9-]+\.mp4$/.test(src)) {
      node.tagName = "a";
      node.properties = { href: `${ADMIN_GUIDE}/guide/video-tutorials` };
      node.children = [{ type: "text", value: "Open this video in the Boardwalk guide" }];
    }
  }
  for (const child of node.children ?? []) rewrite(child);
}

/** The internal Astro guide does not serve Admin video bytes. Point those players at the staff host. */
export function rehypeAdminGuideVideos() {
  return (tree) => {
    for (const child of tree.children ?? []) rewrite(child);
  };
}
