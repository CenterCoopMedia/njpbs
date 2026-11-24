import { repositoryIdentity } from "./repository-identity.mjs";
import { operatorRefused } from "./public-release-operator-io.mjs";

// API JSON responses for the development settle operators stay under 256 KiB.
export const JSON_LIMIT = 256 * 1024;

// Names the size and the cap; carries no response content.
function tooLarge(response, limit) {
  const length = Number(response.headers?.get?.("content-length"));
  const bytes = Number.isSafeInteger(length) && length > limit ? length : `>${limit}`;
  throw Object.assign(new Error(`GitHub api response is ${bytes} bytes; cap is ${limit}`),
    { refusalDetail: { reason: "github_response_too_large", kind: "api", bytes, capBytes: limit } });
}

async function boundedBytes(response, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) tooLarge(response, limit);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Fixed GitHub origin, bounded JSON reads and no raw API output. */
export function devSettlementGithub(token, request = fetch, env = process.env) {
  const { repository: repo } = repositoryIdentity(env);
  return async suffix => {
    const response = await request(`https://api.github.com/repos/${repo}/${suffix}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      redirect: "manual", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) operatorRefused();
    return JSON.parse((await boundedBytes(response, JSON_LIMIT)).toString("utf8"));
  };
}
