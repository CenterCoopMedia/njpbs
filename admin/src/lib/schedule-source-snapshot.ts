import { fetchStaffSiteRead } from "./staff-site-read";
import { readScheduleSourceSnapshot } from "../../../packages/content-core/src/schedule-source-snapshot";
import { publicSiteOrigin } from "./dev-origins";

export async function loadScheduleSourceSnapshot(signal: AbortSignal) {
  const nonce = Date.now().toString(36);
  const read = async (path: string) => {
    const response = await fetchStaffSiteRead(`${publicSiteOrigin}/${path}?cms-schedule=${nonce}${path === "_publication.json" ? "&cms-context=code" : ""}`, {
      signal, credentials: "omit", cache: "no-store",
    });
    if (!response.ok) throw new Error("The published schedule could not be loaded.");
    const bytes = await response.text();
    if (bytes.length > 2_000_000) throw new Error("The schedule source response is too large.");
    return JSON.parse(bytes) as unknown;
  };
  const [source, publication] = await Promise.all([read("_schedule-sources.json"), read("_publication.json")]);
  return readScheduleSourceSnapshot(source, publication);
}
