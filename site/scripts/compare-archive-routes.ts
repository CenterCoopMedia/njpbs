import { isDeepStrictEqual } from "node:util";
import { archiveHtmlMetadata } from "../src/lib/post-html-comparison";

const usage = "Usage: npm run compare:archive -- BEFORE_ORIGIN AFTER_ORIGIN /path/ [/other-path/ ...]";

function origin(input: string): string {
  const url = URL.parse(input);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.href !== `${url.origin}/`) {
    throw new Error(usage);
  }
  return url.origin;
}

interface Observation {
  status: number | null;
  location: string | null;
  robotsHeader: string | null;
  metadata: ReturnType<typeof archiveHtmlMetadata> | null;
  error: string | null;
}

async function probe(base: string, path: string): Promise<Observation> {
  const observation: Observation = {
    status: null, location: null, robotsHeader: null, metadata: null, error: null,
  };
  try {
    const response = await fetch(new URL(path, base), {
      redirect: "manual", signal: AbortSignal.timeout(15_000),
    });
    observation.status = response.status;
    observation.location = response.headers.get("location");
    observation.robotsHeader = response.headers.get("x-robots-tag");
    if (response.status !== 200 || !/^text\/html(?:;|$)/i.test(response.headers.get("content-type") ?? "")) {
      await response.body?.cancel();
      observation.error = response.status === 200 ? "Expected an HTML document" : null;
      return observation;
    }
    const html = await response.text();
    try {
      observation.metadata = archiveHtmlMetadata(html);
    } catch {
      observation.error = "Could not read HTML metadata and structured data";
    }
  } catch {
    observation.error = "Could not read the HTTP response";
  }
  return observation;
}

const [beforeArg, afterArg, ...paths] = process.argv.slice(2);
if (!beforeArg || !afterArg || paths.length === 0 ||
    paths.some(path => !/^\/(?!\/)[^\\#\s]*$/.test(path))) {
  throw new Error(usage);
}
const beforeOrigin = origin(beforeArg);
const afterOrigin = origin(afterArg);
for (const path of paths) {
  const [before, after] = await Promise.all([probe(beforeOrigin, path), probe(afterOrigin, path)]);
  const differences = (Object.keys(before) as (keyof Observation)[])
    .filter(key => !isDeepStrictEqual(before[key], after[key]));
  console.log(JSON.stringify({ path, before, after, differences }));
  if (differences.length || before.error || after.error) process.exitCode = 1;
}
