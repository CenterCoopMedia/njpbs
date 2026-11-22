import { afterEach, expect, it, vi } from "vitest";
import { postFunction } from "../src/lib/functions";
import { clearMediaSessionCache, mediaCacheIdentityRevision, setMediaCachePrincipal } from "../src/lib/media-session-cache";
import { loadSharedMediaTags } from "../src/lib/shared-media-tags";

vi.mock("../src/lib/functions", () => ({ postFunction: vi.fn() }));
afterEach(clearMediaSessionCache);

it("shares one sample per identity and discards results from revoked access", async () => {
  let reply!: (value: { tags: string[] }) => void;
  const image = new Promise<{ tags: string[] }>(resolve => { reply = resolve; });
  vi.mocked(postFunction).mockImplementation(endpoint =>
    (endpoint === "cmsListMedia" ? image : Promise.reject(new Error("Denied"))) as ReturnType<typeof postFunction>,
  );
  setMediaCachePrincipal("editor-one", "contributor");
  const getToken = async () => "fixture-token";
  const fromContributor = loadSharedMediaTags(getToken, mediaCacheIdentityRevision());
  expect(loadSharedMediaTags(getToken, mediaCacheIdentityRevision())).toBe(fromContributor);
  await Promise.resolve();
  expect(postFunction).toHaveBeenCalledTimes(2);

  setMediaCachePrincipal("editor-one", "viewer");
  reply({ tags: ["Prior access"] });
  expect(await fromContributor).toEqual([]);
  vi.mocked(postFunction).mockImplementation(endpoint => endpoint === "cmsListMedia"
    ? Promise.reject(new Error("Denied"))
    : Promise.resolve({ tags: ["Video tag"] }) as ReturnType<typeof postFunction>);
  expect(await loadSharedMediaTags(getToken, mediaCacheIdentityRevision())).toEqual(["Video tag"]);
});
