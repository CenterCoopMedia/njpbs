import { postSlugForPath } from "./public-content-routes";

export interface PostShareInput {
  title: string;
  url: string;
}

export interface PostShareLinks {
  title: string;
  email: string;
  facebook: string;
  x: string;
  linkedin: string;
}

function readableShareTitle(value: string): string {
  const title = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  if (title.length === 0) throw new Error("A published Post title is required");
  return title;
}

function canonicalPostUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("A canonical NJ PBS Post URL is required");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "njpbs.org" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !postSlugForPath(url.pathname)
  ) {
    throw new Error("A canonical NJ PBS Post URL is required");
  }
  return url;
}

export function buildPostShareLinks(input: PostShareInput): PostShareLinks {
  const title = readableShareTitle(input.title);
  const url = canonicalPostUrl(input.url).toString();
  const encodedTitle = encodeURIComponent(title);
  const encodedUrl = encodeURIComponent(url);

  return {
    title,
    email: `mailto:?subject=${encodedTitle}&body=${encodedUrl}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
    x: `https://x.com/intent/tweet?text=${encodedTitle}&url=${encodedUrl}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`,
  };
}
