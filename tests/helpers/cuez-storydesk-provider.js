// Deterministic network fixture based on the October 29 live response shapes.
// Update response shapes remain unverified; the client must use read-back evidence.
export function storydeskProvider({ sse = false } = {}) {
  const calls = [];
  const objects = { stories: [], sections: [], assets: [], briefs: [] };
  let nextId = 0;
  let revision = 0;
  let failure = null;
  const failNext = value => { failure = value; };
  const fetch = async (url, init) => {
    const rpc = JSON.parse(init.body);
    const { name, arguments: args } = rpc.params;
    calls.push({ url, name, args });
    const mode = failure?.tool === name ? failure : null;
    if (mode) failure = null;
    if (mode?.mode === "drop-before") throw new Error(mode.message ?? "Transport dropped");
    if (mode?.mode === "http") return new Response(mode.message ?? "Rejected", { status: mode.status });
    if (mode?.mode === "rpc-error") return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id,
      error: { code: mode.code, message: mode.message ?? "Rejected" } }));
    const id = () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;
    const time = () => new Date(Date.UTC(2026, 9, 29, 12, 0, ++revision)).toISOString();
    let data;
    switch (name) {
    case "stories_create": {
      const story = { id: id(), breaking: false, title: args.title, description: args.description,
        scheduledDate: null, sourceUrl: null, topic: null, topicId: null, departmentId: null,
        creator: null, lastModifier: null, createdAt: time(), updatedAt: time(), link: "https://storydesk.example.test/story" };
      objects.stories.push(story);
      data = { data: { id: story.id, title: story.title, scheduledDate: null, link: story.link, message: "Created" } }; break;
    }
    case "sections_create": {
      const section = { id: id(), storyId: args.storyId, title: args.title, content: args.content, createdAt: time() };
      objects.sections.push(section);
      data = { data: { id: section.id, title: section.title, content: section.content, message: "Created" } }; break;
    }
    case "assets_import_from_url": {
      const asset = { id: id(), storyId: args.storyId }; objects.assets.push(asset);
      data = { data: { assetId: asset.id, storyId: args.storyId, message: "Imported" } }; break;
    }
    case "stories_update": {
      const story = objects.stories.find(item => item.id === args.storyId);
      Object.assign(story, { title: args.title, description: args.description, updatedAt: time() });
      data = { data: { message: "Updated" } }; break;
    }
    case "sections_update": {
      const section = objects.sections.find(item => item.storyId === args.storyId && item.id === args.sectionId);
      Object.assign(section, { title: args.title, content: args.content });
      data = { data: { message: "Updated" } }; break;
    }
    case "stories_list": {
      const matches = objects.stories.filter(item => item.description.includes(args.search ?? ""));
      const page = args.page ?? 1, limit = args.limit ?? 100;
      data = { data: matches.slice((page - 1) * limit, page * limit).map(({ id, breaking, title, description, scheduledDate, topicId, departmentId, link }) =>
        ({ id, breaking, title, description, scheduledDate, topicId, departmentId, link })),
      meta: { page, limit, total: matches.length, totalPages: Math.ceil(matches.length / limit) } }; break;
    }
    case "stories_get": {
      const story = objects.stories.find(item => item.id === args.storyId);
      if (!story) return new Response("Unavailable", { status: 404 });
      const { id, breaking, title, description, scheduledDate, sourceUrl, topic, departmentId, creator, lastModifier, createdAt, updatedAt, link } = story;
      data = { data: { id, breaking, title, description, scheduledDate, sourceUrl, topic, departmentId, creator, lastModifier, createdAt, updatedAt, link } }; break;
    }
    case "sections_list":
      data = { data: objects.sections.filter(item => item.storyId === args.storyId)
        .map(({ id, title, content, createdAt }) => ({ id, title, content, createdAt })) }; break;
    case "assets_list_for_story":
      data = { data: objects.assets.filter(item => item.storyId === args.storyId).map(({ id }) => ({ id })) }; break;
    case "script_get": {
      const brief = objects.briefs.find(item => item.storyId === args.storyId);
      data = brief ? { text: brief.text, html: brief.html, contentHash: brief.contentHash }
        : { text: "Test Brief", html: "<p>Test Brief</p>", contentHash: "test-content-hash" }; break;
    }
    case "assets_search": data = { assets: [], hasMore: false }; break;
    default: throw new Error("Unsupported fixture tool");
    }
    if (mode?.mode === "drop-after") throw new Error(mode.message ?? "Response lost");
    if (mode?.mode === "timeout-after") return new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("Request aborted")), { once: true });
    });
    if (mode?.mode === "malformed-after") return new Response("Unexpected response");
    const envelope = { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(data) }] } };
    return new Response(sse ? `: heartbeat\n\nevent: message\ndata: ${JSON.stringify(envelope)}\n\n` : JSON.stringify(envelope), {
      headers: { "content-type": sse ? "text/event-stream" : "application/json" },
    });
  };
  return { fetch, calls, objects, failNext };
}
