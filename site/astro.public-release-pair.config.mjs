import publicConfig from "./astro.public-post.config.mjs";
import compiledRendererAdapter from "./scripts/compiled-renderer-adapter.mjs";
// An explicit private build; public configs never select the replay entry.
export default { ...publicConfig,
  adapter: compiledRendererAdapter({ publicPostsOnly: true, publicPages: true, publicRecords: true, pairReplay: true }) };
