import type { CmsProgramBuildData } from "./cms-programs-loader";

/** Public card data from an admitted, published Program snapshot. */
export function programCardData(snapshot: CmsProgramBuildData) {
  const summary = snapshot.description.content
    ?.map((node) => node.content?.map((child) => child.text ?? "").join("") ?? "")
    .join(" ").replace(/\s+/g, " ").trim().slice(0, 180) ?? "";
  return {
    title: snapshot.title,
    url: snapshot.path,
    art: snapshot.keyArt,
    alt: snapshot.keyArtDecorative ? "" : snapshot.keyArtAlt,
    genre: snapshot.genre,
    summary,
  };
}
