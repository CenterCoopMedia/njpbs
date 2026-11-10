/** Local synthetic fixture. No authentication, CMS writes or publication. */
import { createRoot } from "react-dom/client";
import { RecordForm } from "../components/RecordForm";
import { ContentShelfSources } from "../components/ContentShelfPicker";
import { HomePreviewFrame } from "../components/HomePreviewFrame";
import { renderHomeEditorialHero } from "../../../packages/content-core/src/home-editorial-render";
import { resolveHomeHero, type HomeHeroCatalogItem, type HomeHeroConfig } from "../../../packages/content-core/src/home-hero";
import "../styles.css";
import "../cms-workspace.css";

const params = new URLSearchParams(location.search);
const cards: HomeHeroCatalogItem[] = [
  { id: "newest", source: "cms_posts", title: "New Jersey communities share their latest stories", summary: "The newest reporting from around the state.", href: "/posts/newest/", categories: [], tags: ["home"] },
  { id: "older", source: "cms_posts", title: "Explore the places and people that make New Jersey home", summary: "Meet neighbors making a difference in their communities.", href: "/posts/older/", categories: [], tags: ["home"] },
  { id: "contact", source: "cms_pages", title: "Connect with NJ PBS", summary: "Find the right contact for your question about NJ PBS.", href: "/contact/", categories: [], tags: [] },
  { id: "outside", source: "cms_posts", title: "A closer look at public television across the Garden State", summary: "Stories and programs for New Jersey.", href: "/posts/outside/", categories: [], tags: [] },
];
const count = Number(params.get("pins") ?? 1);
const hero: HomeHeroConfig = { mode: "tag", source: "cms_posts", value: "home", presentation: "editorial", limit: 4,
  pins: count === 0 ? [] : [{ source: "cms_pages", sourceId: "contact" }, ...(count === 3 ? [
    { source: "cms_posts" as const, sourceId: "outside" }, { source: "cms_posts" as const, sourceId: "older" },
  ] : [])] };
const sources = {
  loadPages: async () => [{ id: "contact", title: "PRIVATE draft", path: "/contact/", published: true, livePath: "/contact/", liveTitle: "Connect with NJ PBS", liveSourceVersion: 1 }],
  loadLibrarySelection: async () => ({ records: cards.filter(card => card.source === "cms_posts").map(card => ({ id: card.id, kind: "post" as const, title: card.title, status: "published", liveSourceVersion: 1 })),
    page: 1, pageCount: 1, total: 3, allCount: 3, mineCount: 0, assignedCount: 0,
    statusCounts: { draft: 0, scheduled: 0, in_review: 0, approved: 0, published: 3, archived: 0 } }),
  loadRecord: async (_kind: string, id: string) => {
    const card = cards.find(card => card.id === id)!;
    return { status: "ready" as const, record: { title: "PRIVATE draft", publiclyVisible: true, version: 2, publicSourceVersion: 1,
      published: { sourceVersion: 1, metadata: { title: card.title, slug: id, categories: card.categories, tags: card.tags } } } };
  },
};
function Specimen() {
  if (params.get("view") === "public") return <HomePreviewFrame title="Public Home hero" html={renderHomeEditorialHero(resolveHomeHero(hero, cards), hero)} />;
  return <main className="content-studio" style={{ padding: "1rem" }}><ContentShelfSources.Provider value={sources}>
    <RecordForm kind="page" pageId="home" canSave initial={{ title: "Home", homeHeroTitle: "NJ PBS", homeHeroSubtitle: "Stories from New Jersey", homeHero: hero }}
      onSave={async record => ({ kind: "record-save-receipt", document: { ...record, id: "home", version: 2 }, mintedIds: {} })} />
  </ContentShelfSources.Provider></main>;
}
if (import.meta.env.DEV) createRoot(document.getElementById("home-hero-pins-root")!).render(<Specimen />);
