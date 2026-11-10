// Resolve registered names and links from the current public profiles.
// A missing or withdrawn profile keeps the published name without a link.
// Guests keep their published text and never join a profile by name.

export interface PublishedCreditLinkInput {
  name: string;
  authorId?: string;
  slug?: string;
}

export interface PublicAuthorLinkInput {
  authorId: string;
  displayName: string;
  slug: string;
}

export interface PublicCreditLink {
  name: string;
  authorId?: string;
  slug?: string;
}

export function resolvePublicCreditLinks(
  credits: readonly PublishedCreditLinkInput[],
  authors: readonly PublicAuthorLinkInput[],
): PublicCreditLink[] {
  const currentAuthors = new Map(
    authors.map((author) => [author.authorId, author]),
  );

  return credits.map((credit) => {
    if (!credit.authorId) return { name: credit.name };
    const current = currentAuthors.get(credit.authorId);
    return {
      name: current?.displayName ?? credit.name,
      authorId: credit.authorId,
      ...(current?.slug ? { slug: current.slug } : {}),
    };
  });
}
