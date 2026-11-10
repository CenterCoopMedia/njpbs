import { isServerMintableSlugShape } from "../../../packages/content-core/src/post-slugs.ts";
import { publicRouteBaseForRecordKind } from "../../../packages/content-core/src/public-record-kinds.ts";

// The public Post route base and the exact slug shape the server can mint.
//
// The build must accept every slug the writer can mint. A stricter list here
// would let the server permanently reserve a slug the build later refuses,
// blocking every strict publish build with no safe recovery path -- which is
// exactly what a post titled "New" used to do.
//
// So the shape is not restated here. It comes from
// `packages/content-core/src/post-slugs.ts`, which the save boundary imports
// too: one module owns both the strict rule the writer mints by and the
// permissive rule the build routes by, and a parity test proves everything
// mintable is routable. Two predicates that merely happened to agree is the
// arrangement that broke.

// Both bases come from the shared routed-kind contract rather than being typed
// here, for the same reason the slug shape does: the Admin decides whether to
// show Publish now from that module, the publish snapshot writer decides what it
// may freeze from that module, and a base restated here could drift from the one
// those two agreed on.

/** The public route base for Posts. */
export const POST_PUBLIC_ROUTE_BASE = publicRouteBaseForRecordKind("post")!;

/** The public route base for Programs. */
export const PROGRAM_PUBLIC_ROUTE_BASE = publicRouteBaseForRecordKind("program")!;
export const EVENT_PUBLIC_ROUTE_BASE = publicRouteBaseForRecordKind("event")!;

// The author base is not redeclared here. `packages/content-core` owns author
// slug minting, reserved words, redirects, and `authorPublicPath`; the Post
// contract is intentionally independent because its server writer is different.

/** A lowercase, hyphen-joined slug the Post writer can mint. */
export function isPublicContentSlug(value: unknown): value is string {
  return isServerMintableSlugShape(value);
}

function publicPath(base: string, slug: string): string {
  if (!isPublicContentSlug(slug)) {
    throw new Error(`${base}{slug}/ requires a server-mintable slug`);
  }
  return `${base}${slug}/`;
}

/** `/posts/{slug}/` for a server-mintable slug. Throws for anything else. */
export function postPublicPath(slug: string): string {
  return publicPath(POST_PUBLIC_ROUTE_BASE, slug);
}

/** `/programs/{slug}/` for a server-mintable slug. Throws for anything else. */
export function programPublicPath(slug: string): string {
  return publicPath(PROGRAM_PUBLIC_ROUTE_BASE, slug);
}

/** `/events/{slug}/` for a server-mintable slug. */
export function eventPublicPath(slug: string): string {
  return publicPath(EVENT_PUBLIC_ROUTE_BASE, slug);
}
