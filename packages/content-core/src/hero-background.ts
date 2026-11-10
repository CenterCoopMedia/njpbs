import type { HeroBackgroundMetadata } from "./content-model";

/** Read only the two authored hero fields, for published and private preview projections. */
export function heroBackgroundMetadata(value: Record<string, unknown>): HeroBackgroundMetadata {
  if (value.heroBackgroundImage !== undefined && typeof value.heroBackgroundImage !== "string") {
    throw new Error("heroBackgroundImage must be a string");
  }
  const position = value.heroBackgroundPosition;
  if (position !== undefined && position !== "" && position !== "center" && position !== "top" && position !== "bottom") {
    throw new Error("heroBackgroundPosition must be center, top, or bottom");
  }
  return {
    ...(typeof value.heroBackgroundImage === "string" ? { heroBackgroundImage: value.heroBackgroundImage } : {}),
    ...(position ? { heroBackgroundPosition: position } : {}),
  };
}
