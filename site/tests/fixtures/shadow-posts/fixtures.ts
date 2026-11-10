import prose from "./post.json";
export { prose };
export const spotlight = [false, true].map(spotlightNews => ({
  ...prose,
  document: { ...prose.document, spotlightNews: !spotlightNews,
    published: { ...prose.document.published,
      metadata: { ...prose.document.published.metadata,
        slug: `shadow-spotlight-${spotlightNews ? "on" : "off"}`, spotlightNews },
    },
  },
}));
export const videoUrl = `https://media.njpbs.org/cms-media/video/fixture-video/${"a".repeat(64)}.mp4`;
export const video = { ...prose, document: { ...prose.document, published: { ...prose.document.published,
  metadata: { ...prose.document.published.metadata, slug: "shadow-video" },
  blocks: [...prose.document.published.blocks, {
    id: "video", type: "video", visible: true, order: 1,
    data: { sourceId: "video-library", assetId: "fixture-video", title: "Fixture video",
      public: { url: videoUrl,
        posterUrl: `https://media.njpbs.org/cms-media/video/fixture-video/${"b".repeat(64)}.jpg`,
        width: 640, height: 360, mimeType: "video/mp4" } },
  }],
} } };

// Ada's current public profile comes from posts-authors.e2e.test.ts. The Post's
// frozen name differs so the approved current-name rule has an independent oracle.
export const authorId = `au_${"1".repeat(32)}`;
export const registeredAuthor = { ...prose, document: { ...prose.document, id: "registered-fixture",
  published: { ...prose.document.published, metadata: { ...prose.document.published.metadata,
    slug: "registered-fixture", credits: [
      { kind: "registered", authorId, displayName: "Ada when published", slug: "a-reporter" },
      { kind: "custom", name: "Guest writer" },
    ] },
  } }, authors: [{ id: authorId, authorId, slug: "ada-reporter", previousSlugs: ["a-reporter"],
    displayName: "Ada Reporter", jobTitle: "Statehouse reporter", bio: "Covers the Legislature for NJ PBS.",
    photo: null, links: { x: { handle: "adareporter", url: "https://x.com/adareporter" } },
    pinnedPostId: null, hiddenPostIds: [], snapshotVersion: 2 }] };
export const withdrawnAuthor = { ...registeredAuthor, document: { ...registeredAuthor.document, id: "withdrawn-author-fixture",
  published: { ...registeredAuthor.document.published, metadata: { ...registeredAuthor.document.published.metadata,
    slug: "withdrawn-author-fixture" } } }, authors: [] };


export const uploadedImageUrl = "https://media.njpbs.org/cms-media/news/uploaded-image/hash.webp";
export const uploadedImages = ["standard", "special-report", "multimedia", "interactive"].flatMap(presentation =>
  ["legacy", "current", "cleared"].map(creditState => ({
    ...prose,
    document: { ...prose.document, id: `uploaded-${presentation}-${creditState}`, heroImageCaption: "Private draft caption",
      published: { ...prose.document.published,
        metadata: { ...prose.document.published.metadata, slug: `uploaded-${presentation}-${creditState}`,
          tags: presentation === "standard" ? [] : [`format:${presentation}`], heroImage: "upload",
          heroImageAlt: "Residents on the platform", heroImageCaption: "Frozen lead caption",
          social: { imageAssetId: "upload" }, seo: { title: "Upload SEO", description: "Upload summary" } },
        blocks: [
          { id: "chapters", type: "prose", visible: true, order: 0, data: { content: { type: "doc", content: [
            { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "First chapter" }] },
            { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Second chapter" }] },
          ] } } },
          { id: "image", type: "image", visible: true, order: 1,
            data: { assetId: "upload", alt: "Contextual body alt", caption: "Frozen body caption" } },
          { id: "decorative", type: "image", visible: true, order: 2,
            data: { assetId: "upload", alt: "", altDecorative: true, caption: "" } },
          ...(presentation === "interactive" ? [{ id: "map", type: "embed", visible: true, order: 3,
            data: { url: "https://example.org/map", caption: "Explore the statewide map" } }] : []),
        ],
      },
    },
    assets: [{ id: "upload", url: uploadedImageUrl, mimeType: "image/webp", width: 1600, height: 900,
      ...(creditState === "current" ? { credit: "Current <photographer> & NJ PBS" } : {}) }],
  })),
);

// The same current image crosses the public author DTO boundary in both states.
const uploadedCurrent = uploadedImages.find(read => read.document.published.metadata.slug === "uploaded-standard-current")!;
export const uploadedAuthors = [registeredAuthor, withdrawnAuthor].map(author => ({
  ...uploadedCurrent,
  document: { ...uploadedCurrent.document, id: `uploaded-${author.document.id}`, published: {
    ...uploadedCurrent.document.published,
    metadata: { ...uploadedCurrent.document.published.metadata,
      slug: `uploaded-${author.document.published.metadata.slug}`, credits: author.document.published.metadata.credits },
  } }, authors: author.authors,
}));
