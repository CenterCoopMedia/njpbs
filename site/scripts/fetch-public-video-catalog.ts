import { buildProgram, type AssetAttributes, type EpisodeAttributes, type MediaManagerRecord,
  type RawShow, type SeasonAttributes, type ShowAttributes } from "../src/lib/media-manager-catalog.ts";
import { mediaManagerWindowAt } from "../src/lib/media-manager-gating.ts";
import { reportMediaCoverage } from "../src/lib/media-manager-coverage.ts";
import { catalogCaptionLanguage, catalogDate, catalogRecord, catalogSlug, isCatalogImage, MAX_CATALOG_BYTES, MAX_CATALOG_VIDEOS,
  readPublicVideoCatalog, type PublicVideo, type PublicVideoCatalog } from "../src/lib/public-video-catalog.ts";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_FETCH_BYTES = 128 * 1024 * 1024;
const MAX_REQUESTS = 100;
const SHOWS_PER_REQUEST = 20;
const PAGE_SIZE = 50;

export class PublicVideoCatalogError extends Error {}

type Resource = MediaManagerRecord<Record<string, unknown>>;
type Show = RawShow["show"] & { image?: string };
type Season = RawShow["seasons"][number];
type CatalogSource = { raw: RawShow & { show: Show }; seasons: Map<string, Season>; videos: Map<string, Omit<PublicVideo,
  "slug" | "title" | "description" | "episodeNumber" | "premieredOn" | "playerSrc" | "hasCaptions" | "captionLanguages">> };

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().slice(0, 2_000) || undefined : undefined;
}

function resource(value: unknown, type?: string): Resource {
  const row = catalogRecord(value);
  const attributes = catalogRecord(row?.attributes);
  if (!row || !attributes || typeof row.type !== "string" || (type && row.type !== type) ||
      typeof row.id !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(row.id)) {
    throw new PublicVideoCatalogError("Invalid Media Manager resource");
  }
  return { id: row.id, type: row.type, attributes };
}

/** Keep credentials on the exact collection and query selected by the adapter. */
function nextPage(value: unknown, first: URL, page: number): URL | null {
  if (value === null) return null;
  if (typeof value !== "string" || /[\\\u0000-\u0020\u007f]/.test(value)) throw new PublicVideoCatalogError("Incomplete Media Manager pagination");
  const next = new URL(value, first);
  if (next.origin !== first.origin || next.pathname !== first.pathname || next.username || next.password || next.hash ||
      next.searchParams.getAll("page").length !== 1 || next.searchParams.get("page") !== `${page + 1}`) {
    throw new PublicVideoCatalogError("Invalid Media Manager pagination target");
  }
  const filters = new URLSearchParams(next.search);
  filters.delete("page");
  filters.sort();
  const expected = new URLSearchParams(first.search);
  expected.sort();
  if (filters.toString() !== expected.toString()) throw new PublicVideoCatalogError("Media Manager pagination changed filters");
  return next;
}

function createCollectionReader(authorization: string, fetchImpl: typeof fetch) {
  const deadline = AbortSignal.timeout(90_000);
  let requests = 0;
  let totalBytes = 0;
  return async function* readCollection(first: URL, type: string) {
    const ids = new Set<string>();
    let url: URL | null = first;
    for (let page = 1; url; page += 1) {
      deadline.throwIfAborted();
      if (++requests > MAX_REQUESTS) throw new PublicVideoCatalogError("Media Manager request limit exceeded");
      const response = await fetchImpl(url, { redirect: "error", headers: { Accept: "application/json", Authorization: authorization },
        signal: AbortSignal.any([deadline, AbortSignal.timeout(20_000)]) });
      if (!response.ok || response.redirected || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw new PublicVideoCatalogError("Media Manager collection unavailable");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          totalBytes += value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES || totalBytes > MAX_FETCH_BYTES) throw new PublicVideoCatalogError("Media Manager response limit exceeded");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      deadline.throwIfAborted();
      const payload = catalogRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
      const data: unknown = payload?.data;
      url = nextPage(catalogRecord(payload?.links)?.next, first, page);
      if (!Array.isArray(data) || data.length > PAGE_SIZE || (url && data.length === 0) || (page > 1 && data.length === 0)) {
        throw new PublicVideoCatalogError("Incomplete Media Manager collection");
      }
      for (const value of data as unknown[]) {
        const row = resource(value, type);
        if (ids.has(row.id)) throw new PublicVideoCatalogError("Duplicate Media Manager resource in collection");
        ids.add(row.id);
        yield row;
      }
    }
  };
}

function uniqueSlugs<T extends { slug: string }>(rows: T[]): T[] {
  const slugs = new Map<string, number>();
  for (const { slug } of rows) slugs.set(slug, (slugs.get(slug) ?? 0) + 1);
  return rows.filter(({ slug }) => slugs.get(slug) === 1).sort((a, b) => a.slug.localeCompare(b.slug, "en"));
}

function catalogImage(attributes: Record<string, unknown>, profile: RegExp): string | undefined {
  const images: unknown[] = Array.isArray(attributes.images) ? attributes.images : [];
  for (const value of images) {
    const image = catalogRecord(value);
    if (typeof image?.profile === "string" && profile.test(image.profile) && isCatalogImage(image.image)) return image.image;
  }
  return [attributes.mezzanine_image, attributes.image, attributes.thumbnail].find(isCatalogImage);
}

function catalogShow(row: Resource): Show | null {
  const attrs = row.attributes;
  const title = text(attrs.title);
  if (!title || !catalogSlug(attrs.slug) || /\bnjtv\b|\btest$|nj spotlight news/i.test(title)) return null;
  return { ...row, image: catalogImage(attrs, /^show-mezzanine-?16x9$/), attributes: { title, slug: attrs.slug, description_short: text(attrs.description_short),
    description_long: text(attrs.description_long), genre: { title: text(catalogRecord(attrs.genre)?.title) } } };
}

function addPublicAsset(sources: Map<string, CatalogSource>, asset: Resource, now: Date) {
  const attributes = asset.attributes;
  const window = catalogRecord(catalogRecord(attributes.availabilities)?.public);
  if (attributes.object_type !== "full_length" || !window || mediaManagerWindowAt(window, now) !== "open" ||
      [attributes.availability_window, attributes.playable_window].some(value => value !== undefined && value !== "public")) return false;

  const parent = resource(attributes.parent_tree);
  if (parent.type !== "episode" && parent.type !== "special") throw new PublicVideoCatalogError("Invalid Media Manager video parent");
  const episode = parent.type === "episode";
  const season = episode || parent.attributes.season ? resource(parent.attributes.season, "season") : null;
  const show = resource(season?.attributes.show ?? parent.attributes.show, "show");
  const source = sources.get(show.id);
  if (!source) throw new PublicVideoCatalogError("Media Manager video is outside the requested programs");

  const title = text(parent.attributes.title) ?? text(attributes.title);
  // The public asset has the stable video slug even when the parent tree is abbreviated.
  const slug = catalogSlug(attributes.slug) ? attributes.slug : parent.attributes.slug;
  if (!title || !catalogSlug(slug)) return true;
  if (source.videos.has(parent.id)) throw new PublicVideoCatalogError("Duplicate Media Manager full-length video");
  const edition = { ...parent, attributes: { title, slug,
    description_short: text(parent.attributes.description_short) ?? text(attributes.description_short),
    description_long: text(parent.attributes.description_long) ?? text(attributes.description_long),
    premiered_on: parent.attributes.premiered_on ?? attributes.premiered_on, ordinal: parent.attributes.ordinal } as EpisodeAttributes };
  const assetRecord = { ...asset, attributes: attributes as AssetAttributes };
  const seasonTitle = text(season?.attributes.title) ?? null;
  const seasonNumber = Number(season?.attributes.ordinal) || null;
  source.videos.set(parent.id, { kind: parent.type, seasonTitle, seasonNumber: positiveOrdinal(seasonNumber),
    image: catalogImage(attributes, /^asset-mezzanine-16x9$/),
    window: { start: (window.start ?? null) as string | null, end: (window.end ?? null) as string | null } });
  if (!episode) {
    source.raw.specials!.push({ special: edition, assets: [assetRecord] });
    return true;
  }
  let target = source.seasons.get(season!.id);
  if (!target) {
    target = { season: { ...season!, attributes: { ordinal: seasonNumber } satisfies SeasonAttributes }, episodes: [] };
    source.seasons.set(season!.id, target);
    source.raw.seasons.push(target);
  }
  target.episodes.push({ episode: edition, assets: [assetRecord] });
  return true;
}

function positiveOrdinal(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Read only published, public full-length assets for station-scoped shows. */
export async function fetchPublicVideoCatalog(config: { url: URL; authorization: string },
    fetchImpl: typeof fetch, now: Date): Promise<PublicVideoCatalog> {
  const read = createCollectionReader(config.authorization, fetchImpl);
  const showUrl = new URL(config.url);
  showUrl.searchParams.set("page-size", `${PAGE_SIZE}`);
  showUrl.searchParams.set("platform-slug", "partnerplayer");
  const showsBySlug = [];
  for await (const row of read(showUrl, "show")) {
    const show = catalogShow(row);
    if (show) showsBySlug.push({ slug: show.attributes.slug!, show });
  }
  const shows = uniqueSlugs(showsBySlug).map(({ show }) => show);
  if (shows.length === 0) throw new PublicVideoCatalogError("No routable Media Manager programs");
  const sources = new Map<string, CatalogSource>(shows.map(show => [show.id,
    { raw: { show, seasons: [], specials: [] }, seasons: new Map(), videos: new Map() }]));
  let videoCount = 0;
  let hasPublicAsset = false;
  for (let offset = 0; offset < shows.length; offset += SHOWS_PER_REQUEST) {
    const batch = new Map(shows.slice(offset, offset + SHOWS_PER_REQUEST).map(({ id }) => [id, sources.get(id)!]));
    const url = new URL("../assets/", showUrl);
    url.search = new URLSearchParams({ available: "public", type: "full_length", "platform-slug": "partnerplayer", "page-size": `${PAGE_SIZE}` }).toString();
    for (const id of batch.keys()) url.searchParams.append("show-id", id);
    for await (const asset of read(url, "asset")) {
      if (++videoCount > MAX_CATALOG_VIDEOS) throw new PublicVideoCatalogError("Media Manager video limit exceeded");
      if (addPublicAsset(batch, asset, now)) hasPublicAsset = true;
    }
  }

  const coverage = [];
  const programs = [];
  for (const { raw, videos } of sources.values()) {
    const program = buildProgram(raw);
    const episodes = uniqueSlugs(program.episodes.filter(({ playback }) => playback.partnerPlayerSrc !== null));
    if (!episodes.length) continue;
    coverage.push({ ...program, episodes });
    programs.push({ slug: program.slug, title: program.title, description: program.description,
      image: raw.show.image, genre: program.genre,
      episodes: episodes.map(({ id, slug, title, description, episodeNumber, premieredOn, playback }) => ({
        ...videos.get(id)!, slug, title, description, episodeNumber: positiveOrdinal(episodeNumber),
        premieredOn: catalogDate(premieredOn) ? premieredOn : null, playerSrc: playback.partnerPlayerSrc!, hasCaptions: playback.hasCaptions,
        captionLanguages: [...new Set(playback.captions.map(track => track.language).filter(catalogCaptionLanguage))].sort().slice(0, 20),
      })) });
  }
  const result = { checkedAt: now.toISOString(), programs };
  if (hasPublicAsset && programs.length === 0) throw new PublicVideoCatalogError("No routable public Media Manager videos");
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_CATALOG_BYTES) throw new PublicVideoCatalogError("Media Manager snapshot limit exceeded");
  readPublicVideoCatalog(result);
  reportMediaCoverage(coverage);
  return result;
}
