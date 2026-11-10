import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPublicOnlyBuild } from "../src/lib/build-target";
import {
  KIDS_ORIGIN,
  KIDS_PAGE_URL,
  absoluteUrlReferences,
  cssImportReferences,
  executableUnits,
  htmlResourceReferences,
  markupUrlSurface,
  resolveResourceReference,
  styleUnits,
  type GuardrailSource,
  type ResourceReference,
} from "./kids-coppa-url-guard";
import { cssUrlReferences } from "./kids-coppa-css-guard";
import {
  analyzeClientCode,
  analyzeModuleDependencies,
  storagePolicyViolations,
} from "./kids-coppa-client-guard";

// Post-build COPPA guardrail for the real /kids/ route (#251). The route is
// emitted by src/pages/[...slug].astro from launch-fallback data, not by the
// draft src/content/pages/kids.md placeholder. This therefore checks the built
// page that staff and children can actually reach, plus every same-origin script
// and stylesheet it loads.
//
// The rule is intentionally fail-closed. Child-directed output may link to a
// short reviewed list of destinations, but it may not fetch, execute, store, or
// POST anything except the finite first-party reduce-motion preference. There is
// no KNOWN_OPEN escape hatch: the shared report form is now omitted from paths
// ending in /kids/, so Turnstile, optional email capture, and report submission
// cannot become an inherited exception (#860, #862).

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
const kidsPage = fileURLToPath(
  new URL("../dist/kids/index.html", import.meta.url),
);
const publicOnly = isPublicOnlyBuild(process.env);

const ALLOWED_LINK_HOSTS = new Set([
  "njpbs.org",
  "watch.njpbs.org",
  "www.pbs.org",
  "pbskids.org",
  "publicfiles.fcc.gov",
  "www.njspotlightnews.org",
  "www.nj.gov",
  "montclair.wd1.myworkdayjobs.com",
  // Vocabulary URL in JSON-LD. It is named, never fetched.
  "schema.org",
]);

const ALLOWED_NON_NETWORK_LINKS = new Set([
  // Kids routes use the reviewed email fallback instead of mounting the shared
  // report dialog, Turnstile, or submission endpoint.
  "mailto:njpbs@montclair.edu?subject=Website%20problem%20report",
]);

const ALLOWED_STORAGE = new Map([
  // The site-wide accessibility switch records only this finite preference.
  ["njpbs-motion", new Set(["on", "off"])],
]);

type LoadedSources = {
  sources: GuardrailSource[];
  resourceErrors: string[];
};

function loadKidsSources(): LoadedSources {
  if (!existsSync(kidsPage)) return { sources: [], resourceErrors: [] };

  const html = readFileSync(kidsPage, "utf8");
  const sources: GuardrailSource[] = [
    {
      name: "dist/kids/index.html",
      text: html,
      url: KIDS_PAGE_URL,
      kind: "html",
    },
  ];
  const queue: ResourceReference[] = htmlResourceReferences(html, KIDS_PAGE_URL);
  const visited = new Set<string>();
  const resourceErrors: string[] = [];

  const enqueueDependencies = (source: GuardrailSource): void => {
    for (const unit of executableUnits(source)) {
      const dependencies = analyzeModuleDependencies(unit.text);
      queue.push(
        ...dependencies.specifiers.map((ref) => ({
          kind: "script" as const,
          ref,
          baseUrl: unit.url,
        })),
      );
      resourceErrors.push(
        ...dependencies.unresolved.map(
          (expression) => `${unit.name}: unresolved module import ${expression}`,
        ),
      );
    }
    for (const unit of styleUnits(source)) {
      queue.push(...cssImportReferences(unit.text, unit.url));
    }
  };

  enqueueDependencies(sources[0]);

  while (queue.length > 0) {
    const reference = queue.shift() as ResourceReference;
    const resolved = resolveResourceReference(distDir, reference);
    if (resolved.error) {
      resourceErrors.push(`${reference.ref}: ${resolved.error}`);
      continue;
    }
    // An off-site script or stylesheet is already reported by the fetched-host
    // assertion. It must never be downloaded and inspected as trusted input.
    if (resolved.external) continue;
    if (!resolved.url || !resolved.file) {
      resourceErrors.push(`${reference.ref}: did not resolve to a built file`);
      continue;
    }
    if (visited.has(resolved.url)) continue;
    visited.add(resolved.url);
    if (!existsSync(resolved.file)) {
      resourceErrors.push(
        `${reference.ref}: ${resolved.url} is referenced but ${resolved.file} is missing`,
      );
      continue;
    }

    const text = readFileSync(resolved.file, "utf8");
    const source: GuardrailSource = {
      name: resolved.url.replace(KIDS_ORIGIN, ""),
      text,
      url: resolved.url,
      kind: reference.kind,
    };
    sources.push(source);
    enqueueDependencies(source);
  }

  return { sources, resourceErrors };
}

function externalOrMalformed(
  references: ReturnType<typeof absoluteUrlReferences>,
  context: string,
): string[] {
  const offenders: string[] = [];
  for (const reference of references) {
    if (reference.error || !reference.origin) {
      offenders.push(
        `${context}: malformed URL ${JSON.stringify(reference.raw)} (${reference.error ?? "no origin"})`,
      );
      continue;
    }
    if (reference.origin !== KIDS_ORIGIN) {
      offenders.push(`${context}: ${reference.origin}`);
    }
  }
  return offenders;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

describe("the kids route carries no tracker, embed, collection, or identifier (#251)", () => {
  it("dist/ exists, so the guard never passes by scanning nothing", () => {
    expect(existsSync(distDir)).toBe(true);
  });

  it("matches the build mode: present in a full build and absent in PUBLIC_ONLY", () => {
    if (publicOnly) {
      expect(
        existsSync(kidsPage),
        "PUBLIC_ONLY emitted /kids/. Public root routes must remain absent from the coming-soon rollback.",
      ).toBe(false);
      return;
    }
    expect(
      existsSync(kidsPage),
      "A full build did not emit dist/kids/index.html. Point this guard at the new path in the same commit that moves the route.",
    ).toBe(true);
  });

  it.runIf(!publicOnly)(
    "follows every same-origin script and stylesheet the page can execute or load",
    () => {
      expect(
        loadKidsSources().resourceErrors,
        "A relative or same-origin resource could not be parsed or read. Skipping it would leave executable output outside the guard.",
      ).toEqual([]);
    },
  );

  it.runIf(!publicOnly)("embeds no third-party player or document", () => {
    const html = readFileSync(kidsPage, "utf8");
    for (const tag of ["iframe", "embed", "object", "video"]) {
      expect(
        html.match(new RegExp(`<${tag}[\\s>]`, "gi")) ?? [],
        `/kids/ contains a <${tag}> element instead of a link handoff.`,
      ).toEqual([]);
    }
  });

  it.runIf(!publicOnly)("omits the staff hint and editor action on Kids and its descendants (#3145)", () => {
    const directory = join(distDir, "kids");
    const pages = readdirSync(directory, { recursive: true }).filter(file => String(file).endsWith(".html"));
    expect(pages.length).toBeGreaterThan(0);
    for (const file of pages) {
      const html = readFileSync(join(directory, String(file)), "utf8");
      expect(html, String(file)).not.toContain("data-boardwalk-edit");
      expect(html, String(file)).not.toContain("bw_staff");
    }
  });

  it.runIf(!publicOnly)(
    "loads and calls no external host while keeping links on the reviewed list",
    () => {
      const { sources } = loadKidsSources();
      const automatic: string[] = [];
      const linked: string[] = [];

      for (const source of sources) {
        if (source.kind === "html") {
          const surface = markupUrlSurface(source.text, source.url);
          automatic.push(
            ...externalOrMalformed(
              surface.fetched,
              `${source.name} automatic request`,
            ),
          );
          for (const reference of surface.linked) {
            if (reference.error) {
              linked.push(
                `${source.name}: malformed link ${JSON.stringify(reference.raw)} (${reference.error})`,
              );
            } else if (reference.hostname) {
              if (!ALLOWED_LINK_HOSTS.has(reference.hostname)) {
                linked.push(`${source.name}: ${reference.hostname}`);
              }
            } else if (
              !reference.url ||
              !ALLOWED_NON_NETWORK_LINKS.has(reference.url)
            ) {
              linked.push(
                `${source.name}: disallowed non-network link ${JSON.stringify(reference.raw)}`,
              );
            }
          }
        }

        for (const unit of executableUnits(source)) {
          automatic.push(
            ...externalOrMalformed(
              absoluteUrlReferences(unit.text, unit.url),
              `${unit.name} executable code`,
            ),
          );
        }
        for (const unit of styleUnits(source)) {
          automatic.push(
            ...externalOrMalformed(
              cssUrlReferences(unit.text, unit.url),
              `${unit.name} CSS request`,
            ),
          );
        }
      }

      expect(
        unique(automatic),
        "A child-directed page made or declared an automatic off-site request. Approved handoff hosts are links only; they are not fetch allowlists.",
      ).toEqual([]);
      expect(
        unique(linked),
        "A new external destination appeared on /kids/. Review the destination rather than broadening the list by pattern.",
      ).toEqual([]);
    },
  );

  it.runIf(!publicOnly)(
    "keeps the PBS Kids experience as a chosen link handoff",
    () => {
      expect(readFileSync(kidsPage, "utf8")).toContain(
        'href="https://pbskids.org/"',
      );
    },
  );

  it.runIf(!publicOnly)(
    "omits the shared report form, Turnstile, and in-page email field",
    () => {
      const html = readFileSync(kidsPage, "utf8");
      expect(html).not.toContain("data-report-dialog");
      expect(html).not.toContain("data-report-form");
      expect(html).not.toContain("data-report-email");
      expect(html).not.toContain("challenges.cloudflare.com");
      expect(html).not.toContain("report.njpbs.org");
      expect(html).not.toContain("intake.njpbs.org");
      expect(html).not.toContain("data-share");
      expect(html).not.toContain("ShareSubmission");
    },
  );

  it.runIf(!publicOnly)(
    "uses no forbidden browser API and persists only the finite motion preference",
    () => {
      const { sources } = loadKidsSources();
      const forbidden: string[] = [];
      const storage: string[] = [];

      for (const source of sources) {
        for (const unit of executableUnits(source)) {
          const analysis = analyzeClientCode(unit.text);
          forbidden.push(
            ...analysis.forbiddenApis.map((api) => `${unit.name}: ${api}`),
          );
          storage.push(
            ...storagePolicyViolations(
              analysis.storageAccesses,
              ALLOWED_STORAGE,
            ).map((violation) => `${unit.name}: ${violation}`),
          );
        }
      }

      expect(unique(forbidden)).toEqual([]);
      expect(
        unique(storage),
        "A storage access uses an unreviewed key, an unresolved value, or a value outside the motion toggle's on/off domain.",
      ).toEqual([]);
    },
  );

  it.runIf(!publicOnly)(
    "sends no POST, PUT, PATCH, DELETE, XHR write, or beacon from emitted code",
    () => {
      const { sources } = loadKidsSources();
      const writes: string[] = [];
      for (const source of sources) {
        for (const unit of executableUnits(source)) {
          const analysis = analyzeClientCode(unit.text);
          writes.push(
            ...analysis.networkWrites.map(
              (write) =>
                `${unit.name}: ${write.api} ${write.methods?.join("|") ?? "unresolved method"} to ${write.targets?.join("|") ?? "unresolved target"}: ${write.expression}`,
            ),
          );
        }
      }
      expect(
        unique(writes),
        "The kids route collects data through executable code. First-party and relative endpoints count just as much as third-party hosts.",
      ).toEqual([]);
    },
  );

  it.runIf(!publicOnly)("declares no HTML posting target", () => {
    const { sources } = loadKidsSources();
    const postingTargets: string[] = [];
    for (const source of sources) {
      if (source.kind !== "html") continue;
      for (const reference of markupUrlSurface(source.text, source.url).posted) {
        postingTargets.push(
          `${source.name}: ${reference.url ?? reference.raw}${reference.error ? ` (${reference.error})` : ""}`,
        );
      }
    }
    expect(
      unique(postingTargets),
      "The kids route declares an action, formaction, or ping endpoint. Relative and first-party collection targets are forbidden too.",
    ).toEqual([]);

    const html = readFileSync(kidsPage, "utf8");
    for (const form of html.match(/<form\b[^>]*>/gi) ?? []) {
      expect(form).toMatch(/method="dialog"/i);
    }
  });
});
