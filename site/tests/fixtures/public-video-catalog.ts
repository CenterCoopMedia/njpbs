const show = (id: string, slug: string, title = "River stories") => ({ id, type: "show", attributes: { slug, title } });

export const riverShow = show("show-river", "river-stories");
export const coastShow = show("show-coast", "coast-stories", "Coast stories");
export const duplicateCoastShow = show("show-coast-duplicate", "coast-stories");

export function catalogAsset(slug: string, { parentShow = riverShow, special = false,
  title = "The river crossing", attributes = {} }: {
  parentShow?: typeof riverShow; special?: boolean; title?: string; attributes?: Record<string, unknown>;
} = {}) {
  return {
    id: `asset-${slug}`, type: "asset", attributes: {
      object_type: "full_length", availabilities: { public: { start: null, end: null } },
      player_code: '<iframe src="//player.pbs.org/partnerplayer/EXAMPLE==?autoplay=false"></iframe>',
      captions_language: [{ url: "https://example.org/captions-en.vtt", language: "en" }],
      transcript: "https://example.org/transcript.txt",
      description_short: "A documentary about a river crossing.",
      parent_tree: { id: `edition-${slug}`, type: special ? "special" : "episode", attributes: {
        title, slug, ...(special ? { show: parentShow } : { ordinal: "3", season: { id: "season-two", type: "season",
          attributes: { ordinal: "2", title: "Waterways", show: parentShow } } }),
      } }, ...attributes,
    },
  };
}
