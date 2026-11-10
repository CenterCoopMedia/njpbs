import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export const GUIDE_VIDEO_FILES = [
  { directory: "videos", extension: "mp4", contentType: "video/mp4" },
  { directory: "posters", extension: "jpg", contentType: "image/jpeg" },
  { directory: "chapters", extension: "vtt", contentType: "text/vtt; charset=utf-8" },
];

export function guideTranscriptFiles(markdown, videos) {
  return videos.map((video) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(video?.id ?? "")) {
      throw new Error("The guide video catalog is invalid.");
    }
    const marker = `<details><summary>Transcript: ${video.title}</summary>`;
    const start = markdown.indexOf(marker);
    const end = markdown.indexOf("</details>", start);
    if (start < 0 || end < 0 || markdown.indexOf(marker, start + marker.length) !== -1) {
      throw new Error(`Missing or duplicate guide transcript: ${video.id}`);
    }
    const entities = { quot: '"', apos: "'", amp: "&", lt: "<", gt: ">", nbsp: " " };
    const text = markdown.slice(start + marker.length, end)
      .replace(/<\/(?:p|li|ul)>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&(#\d+|#x[\da-f]+|[a-z][a-z0-9]+);/gi, (_match, entity) => {
        if (entity.startsWith("#")) {
          const point = entity.toLowerCase().startsWith("#x")
            ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
          if (!Number.isInteger(point) || point <= 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
            throw new Error(`Invalid numeric entity in the guide transcript: &${entity};`);
          }
          return String.fromCodePoint(point);
        }
        if (!Object.hasOwn(entities, entity.toLowerCase())) {
          throw new Error(`Use literal Unicode in the guide transcript instead of &${entity};`);
        }
        return entities[entity.toLowerCase()];
      })
      .replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) throw new Error(`Empty guide transcript: ${video.id}`);
    const body = `${video.title}\n\n${text}\n`;
    return {
      key: `videos/${video.id}.txt`, body,
      contentType: "text/plain; charset=utf-8",
      size: Buffer.byteLength(body),
      sha256: createHash("sha256").update(body).digest("hex"),
    };
  });
}

function archiveName(name) {
  return String(name).replaceAll("\\", "/").replace(/^\.\//, "");
}

function directoryEntry(name) {
  return name === "./" || name.endsWith("/") || archiveName(name) === "";
}

function unsafeArchiveName(name) {
  if (!name || name.startsWith("-")) return true;
  return name.split("/").some((part) => part === "" || part === "." || part === ".." || part.startsWith("-"));
}

export function planGuideVideoUpload(memberNames, videos) {
  if (!Array.isArray(videos) || videos.length === 0) {
    throw new Error("The guide video catalog is empty.");
  }
  const names = new Map();
  for (const name of memberNames) {
    if (directoryEntry(name)) continue;
    const normalized = archiveName(name);
    if (unsafeArchiveName(normalized)) {
      throw new Error("The archive contains an unsafe path.");
    }
    names.set(normalized, name);
  }
  const plan = [];
  const missing = [];
  for (const video of videos) {
    if (!video?.id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(video.id)) {
      throw new Error("The guide video catalog is invalid.");
    }
    for (const kind of GUIDE_VIDEO_FILES) {
      const suffix = `${kind.directory}/${video.id}.${kind.extension}`;
      const matches = [...names.keys()].filter((name) => name === suffix || name.endsWith(`/${suffix}`));
      if (matches.length !== 1) {
        missing.push(suffix);
        continue;
      }
      plan.push({
        member: names.get(matches[0]),
        key: `videos/${video.id}.${kind.extension}`,
        contentType: kind.contentType,
      });
    }
  }
  if (missing.length > 0) {
    throw new Error(`The archive is missing guide video files: ${missing.join(", ")}`);
  }
  return plan;
}

export function tarExtractArgs(archive, directory, members) {
  return ["-xzf", archive, "-C", directory, "--", ...members];
}

export async function containedGuideFile(root, member) {
  const directory = await realpath(root);
  const candidate = path.resolve(directory, member);
  const info = await lstat(candidate);
  if (!info.isFile()) throw new Error(`Guide video file is not a regular file: ${member}`);
  const resolved = await realpath(candidate);
  const prefix = directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`;
  if (resolved !== directory && !resolved.startsWith(prefix)) {
    throw new Error(`Guide video file escapes the archive directory: ${member}`);
  }
  return resolved;
}

export function guideVideoObjectMatches(existing, size, sha256) {
  return Boolean(existing) && existing.size === size && existing.sha256 === sha256;
}

export function guideVideoReleaseId(files) {
  return createHash("sha256")
    .update(files.map((file) => `${file.key} ${file.sha256}`).sort().join("\n"))
    .digest("hex")
    .slice(0, 16);
}

export function versionedGuideVideoKey(release, key) {
  const name = key.startsWith("videos/") ? key.slice("videos/".length) : "";
  if (!/^[a-f0-9]{16}$/.test(release) || !/^[a-z0-9-]+\.(mp4|jpg|vtt|txt)$/.test(name)) {
    throw new Error("The guide video key is invalid.");
  }
  return `videos/r/${release}/${name}`;
}

export async function publishGuideVideoRelease(files, client) {
  const release = guideVideoReleaseId(files);
  for (const file of files) {
    const key = versionedGuideVideoKey(release, file.key);
    const existing = await client.head(key);
    if (guideVideoObjectMatches(existing, file.size, file.sha256)) continue;
    await client.put({ ...file, key });
    const confirmed = await client.head(key);
    if (!guideVideoObjectMatches(confirmed, file.size, file.sha256)) {
      throw new Error(`Guide video release was not activated. ${key} did not verify.`);
    }
  }
  const digest = createHash("sha256").update(release).digest("hex");
  const current = await client.head("videos/current");
  if (!guideVideoObjectMatches(current, release.length, digest)) {
    await client.put({
      key: "videos/current",
      body: release,
      size: release.length,
      sha256: digest,
      contentType: "text/plain; charset=utf-8",
    });
    const confirmed = await client.head("videos/current");
    if (!guideVideoObjectMatches(confirmed, release.length, digest)) {
      throw new Error("Guide video release was not activated. The pointer did not verify.");
    }
  }
  return release;
}

export async function putGuideVideoObjects(files, client) {
  const uploaded = [];
  const skipped = [];
  for (const file of files) {
    const existing = await client.head(file.key);
    if (guideVideoObjectMatches(existing, file.size, file.sha256)) {
      skipped.push(file.key);
      continue;
    }
    await client.put(file);
    const confirmed = await client.head(file.key);
    if (!guideVideoObjectMatches(confirmed, file.size, file.sha256)) {
      throw new Error(`Guide video upload did not verify: ${file.key}`);
    }
    uploaded.push(file.key);
  }
  return { uploaded, skipped };
}
