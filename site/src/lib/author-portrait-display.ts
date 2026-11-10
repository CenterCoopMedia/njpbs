type PortraitPhoto = { url: string; displayUrl?: string };

type AuthorWithPortrait<T extends { photo?: PortraitPhoto | null }> =
  T extends { photo: infer Photo }
    ? Photo extends PortraitPhoto
      ? Omit<T, "photo"> & { photo: Photo & { displayUrl: string } }
      : T
    : T;

/** Retained public bundles stored only the original photo address. */
export function withAuthorPortraitDisplay<T extends {
  photo?: PortraitPhoto | null;
}>(author: T): AuthorWithPortrait<T> {
  const photo = author.photo;
  if (!photo || photo.displayUrl) return author as AuthorWithPortrait<T>;
  return {
    ...author,
    photo: { ...photo, displayUrl: photo.url },
  } as AuthorWithPortrait<T>;
}
