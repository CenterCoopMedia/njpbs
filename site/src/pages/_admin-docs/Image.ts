import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { APIRoute, GetStaticPaths } from "astro";

const sourceDirectory = path.join(process.cwd(), "src", "internal", "admin-guide");
const IMAGE_NAME = /^[a-z0-9-]+$/;

export const prerender = true;

export const getStaticPaths: GetStaticPaths = async () =>
  (await readdir(sourceDirectory))
    .filter((file) => IMAGE_NAME.test(path.basename(file, ".webp")) &&
      path.extname(file) === ".webp")
    .map((file) => ({
      params: { image: path.basename(file, ".webp") },
    }));

export const GET: APIRoute = async ({ params }) => {
  const image = params.image ?? "";
  if (!IMAGE_NAME.test(image)) return new Response("Not found", { status: 404 });
  try {
    const bytes = await readFile(path.join(sourceDirectory, `${image}.webp`));
    return new Response(bytes, {
      headers: {
        "cache-control": "private, no-store",
        "content-type": "image/webp",
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex, nofollow, noarchive",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
};
