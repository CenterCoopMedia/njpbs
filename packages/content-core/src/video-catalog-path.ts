export const videoCatalogPath = "/watch/programs/";

export function isVideoCatalogPath(path: string): boolean {
  return path === "/watch/programs" || path.startsWith(videoCatalogPath);
}
