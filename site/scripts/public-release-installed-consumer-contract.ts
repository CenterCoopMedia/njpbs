import type { InstalledConsumerProbe } from "../../functions/lib/public-release-installed-consumers";
import consumers from "../../functions/lib/public-release-installed-consumers.js";
import protocol from "../../functions/lib/public-release-pair.js";
import { exact } from "./public-release-pair-reader-contract";
function refuse(): never { throw new Error("Installed consumer probe differs"); }
export function parseInstalledConsumerProbe(raw: unknown, nonce: string): InstalledConsumerProbe {
  const value = exact(raw, ["schemaVersion", "kind", "nonce", "revision", "files", "sourceDigest", "flags"]);
  if (!/^[a-f0-9]{64}$/.test(nonce) || value.schemaVersion !== 2 || value.kind !== "public-release-installed-consumers" ||
      value.nonce !== nonce || typeof value.revision !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(value.revision) ||
      !Array.isArray(value.files) || value.files.length !== consumers.INSTALLED_CONSUMER_FILES.length) refuse();
  const files = value.files.map((raw, index) => {
    const file = exact(raw, ["path", "sha256"]);
    if (typeof file.path !== "string" || file.path !== consumers.INSTALLED_CONSUMER_FILES[index] ||
        typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) refuse();
    return { path: file.path, sha256: file.sha256 };
  });
  const flags = exact(value.flags, [...consumers.FLAGS]);
  if (typeof flags.PUBLIC_RELEASE_READERS_ENABLED !== "boolean" || typeof flags.PUBLIC_RELEASE_COMPOSED_READERS_ENABLED !== "boolean" ||
      value.sourceDigest !== protocol.publicReleaseDigest(files)) refuse();
  return Object.freeze({ schemaVersion: 2, kind: "public-release-installed-consumers", nonce, revision: value.revision,
    files: Object.freeze(files), sourceDigest: protocol.publicReleaseDigest(files), flags: Object.freeze({
      PUBLIC_RELEASE_READERS_ENABLED: flags.PUBLIC_RELEASE_READERS_ENABLED,
      PUBLIC_RELEASE_COMPOSED_READERS_ENABLED: flags.PUBLIC_RELEASE_COMPOSED_READERS_ENABLED }) });
}
