import { relative, resolve } from "node:path";
import { Window } from "happy-dom";
import { cssImportValues } from "./kids-coppa-css-lex";

export const KIDS_ORIGIN = "https://njpbs.org";
export const KIDS_PAGE_URL = `${KIDS_ORIGIN}/kids/`;

export type SourceKind = "html" | "script" | "style";
export type GuardrailSource = {
  name: string;
  text: string;
  url: string;
  kind: SourceKind;
};

export type UrlReference = {
  raw: string;
  url: string | null;
  origin: string | null;
  hostname: string | null;
  error: string | null;
};

export type ResourceReference = {
  kind: "script" | "style";
  ref: string;
  baseUrl: string;
};

export type ResolvedResource = {
  ref: string;
  url: string | null;
  file: string | null;
  external: boolean;
  error: string | null;
};

const AUTO_FETCHED_ATTRS = new Set([
  "src",
  "srcset",
  "imagesrcset",
  "data",
  "poster",
]);

const POSTING_ATTRS = new Set(["action", "formaction", "ping"]);

const NON_NETWORK_NAVIGATION_PROTOCOLS = new Set(["mailto:", "tel:"]);

const DECLARED_LINK_RELS = new Set([
  "canonical",
  "alternate",
  "author",
  "license",
  "next",
  "prev",
  "help",
  "me",
]);

const HTML_WINDOW = new Window();
const HTML_PARSER = new HTML_WINDOW.DOMParser();
type HtmlDocument = ReturnType<typeof HTML_PARSER.parseFromString>;
type HtmlElement = NonNullable<ReturnType<HtmlDocument["querySelector"]>>;

function parseHtmlDocument(html: string): HtmlDocument {
  return HTML_PARSER.parseFromString(String(html), "text/html");
}

/** Decode the same named, numeric, and semicolon-optional references as HTML. */
export function decodeHtml(value: string): string {
  const textarea = HTML_WINDOW.document.createElement("textarea");
  textarea.innerHTML = String(value);
  return textarea.textContent ?? "";
}

function trimUrlCandidate(candidate: string): string {
  return candidate.replace(/[.,;!?]+$/g, "");
}

export function parseUrlReference(
  raw: string,
  baseUrl = KIDS_PAGE_URL,
): UrlReference {
  const decoded = decodeHtml(raw.trim()).replaceAll("\\/", "/");
  try {
    const parsed = new URL(decoded, baseUrl);
    if (NON_NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol)) {
      return {
        raw,
        url: parsed.href,
        origin: null,
        hostname: null,
        error: null,
      };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        raw,
        url: parsed.href,
        origin: null,
        hostname: null,
        error: `unsupported URL protocol: ${parsed.protocol}`,
      };
    }
    return {
      raw,
      url: parsed.href,
      origin: parsed.origin,
      hostname: parsed.hostname.toLowerCase(),
      error: null,
    };
  } catch (error) {
    return {
      raw,
      url: null,
      origin: null,
      hostname: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function absoluteUrlReferences(
  text: string,
  baseUrl = KIDS_PAGE_URL,
): UrlReference[] {
  const flat = decodeHtml(text).replaceAll("\\/", "/");
  const found = new Map<string, UrlReference>();
  for (const match of flat.matchAll(
    /(?:https?:[\\/]{2}|[\\/]{2})[^\s"'`<>{}\[\])]+/gi,
  )) {
    const raw = trimUrlCandidate(match[0]);
    if (!raw) continue;
    const parsed = parseUrlReference(raw, baseUrl);
    found.set(`${raw}\0${parsed.error ?? ""}`, parsed);
  }
  return [...found.values()];
}

function elementAttributes(element: HtmlElement): Map<string, string> {
  // DOM parsing follows the HTML rule that the first duplicate attribute wins.
  return new Map(
    [...element.attributes].map((attribute) => [
      attribute.name.toLowerCase(),
      attribute.value ?? "",
    ]),
  );
}

function effectiveDocumentBase(document: HtmlDocument, fallback: string): string {
  const base = document.querySelector("base[href]")?.getAttribute("href");
  if (!base) return fallback;
  try {
    return new URL(base, fallback).href;
  } catch {
    return fallback;
  }
}

function urlCandidates(name: string, value: string): string[] {
  if (name === "ping") return value.trim().split(/\s+/).filter(Boolean);
  if (name === "srcset" || name === "imagesrcset") {
    const candidates: string[] = [];
    for (const part of value.split(",")) {
      const candidate = part.trim().split(/\s+/, 1)[0];
      if (candidate && !candidate.toLowerCase().startsWith("data:")) {
        candidates.push(candidate);
      }
    }
    return candidates;
  }
  return value.trim() ? [value.trim()] : [];
}

function refreshTarget(content: string): string | null {
  const match = content.match(/(?:^|;)\s*url\s*=\s*(.+?)\s*$/i);
  if (!match) return null;
  return match[1].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2").trim();
}

export function markupUrlSurface(
  html: string,
  baseUrl = KIDS_PAGE_URL,
): {
  fetched: UrlReference[];
  linked: UrlReference[];
  posted: UrlReference[];
} {
  const document = parseHtmlDocument(html);
  const effectiveBase = effectiveDocumentBase(document, baseUrl);
  const fetched: UrlReference[] = [];
  const linked: UrlReference[] = [];
  const posted: UrlReference[] = [];

  for (const element of document.querySelectorAll("*")) {
    const tag = element.localName.toLowerCase();
    const attributes = elementAttributes(element);
    const relValues = (attributes.get("rel") ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const hrefIsDestination =
      tag === "a" ||
      tag === "area" ||
      (tag === "link" &&
        relValues.length > 0 &&
        relValues.every((value) => DECLARED_LINK_RELS.has(value)));
    const isMetaRefresh =
      tag === "meta" &&
      (attributes.get("http-equiv") ?? "").trim().toLowerCase() === "refresh";

    for (const [name, value] of attributes) {
      if (!value || (isMetaRefresh && name === "content")) continue;
      if (
        /^on[a-z]/i.test(name) ||
        value.trimStart().toLowerCase().startsWith("javascript:") ||
        name === "style"
      ) {
        continue;
      }

      if (POSTING_ATTRS.has(name)) {
        posted.push(
          ...urlCandidates(name, value).map((candidate) =>
            parseUrlReference(candidate, effectiveBase),
          ),
        );
        continue;
      }

      if (AUTO_FETCHED_ATTRS.has(name) || (name === "href" && !hrefIsDestination)) {
        fetched.push(
          ...urlCandidates(name, value).map((candidate) =>
            parseUrlReference(candidate, effectiveBase),
          ),
        );
      } else if (name === "href") {
        linked.push(parseUrlReference(value, effectiveBase));
      } else {
        linked.push(...absoluteUrlReferences(value, effectiveBase));
      }
    }

    if (isMetaRefresh) {
      const target = refreshTarget(attributes.get("content") ?? "");
      if (target) fetched.push(parseUrlReference(target, effectiveBase));
    }
  }

  const textDocument = parseHtmlDocument(html);
  for (const element of textDocument.querySelectorAll("script, style, template")) {
    const type = element.getAttribute("type")?.toLowerCase() ?? "";
    if (element.localName === "script" && /^(?:application\/)?(?:ld\+)?json$/.test(type)) {
      linked.push(...absoluteUrlReferences(element.textContent ?? "", effectiveBase));
    }
    element.remove();
  }
  linked.push(
    ...absoluteUrlReferences(textDocument.documentElement.textContent ?? "", effectiveBase),
  );

  return { fetched, linked, posted };
}

export function executableUnits(source: GuardrailSource): GuardrailSource[] {
  if (source.kind === "script") return [source];
  if (source.kind !== "html") return [];

  const document = parseHtmlDocument(source.text);
  const units: GuardrailSource[] = [];
  let scriptIndex = 0;
  for (const script of document.querySelectorAll("script")) {
    scriptIndex += 1;
    const type = script.getAttribute("type")?.trim().toLowerCase() ?? "";
    if (type === "application/ld+json" || type === "application/json") continue;
    const text = script.textContent ?? "";
    if (text.trim()) {
      units.push({
        name: `${source.name} script ${scriptIndex}`,
        text,
        url: source.url,
        kind: "script",
      });
    }
  }

  let handlerIndex = 0;
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value ?? "";
      const isHandler = /^on[a-z]/i.test(name);
      const isJavascriptUrl = value
        .trimStart()
        .toLowerCase()
        .startsWith("javascript:");
      if (!isHandler && !isJavascriptUrl) continue;
      handlerIndex += 1;
      units.push({
        name: `${source.name} ${element.localName}[${name}] ${handlerIndex}`,
        text: isJavascriptUrl ? value.replace(/^\s*javascript:/i, "") : value,
        url: source.url,
        kind: "script",
      });
    }
  }

  return units;
}

export function styleUnits(source: GuardrailSource): GuardrailSource[] {
  if (source.kind === "style") return [source];
  if (source.kind !== "html") return [];

  const document = parseHtmlDocument(source.text);
  const units: GuardrailSource[] = [];
  let index = 0;
  for (const style of document.querySelectorAll("style")) {
    const text = style.textContent ?? "";
    if (!text.trim()) continue;
    index += 1;
    units.push({
      name: `${source.name} style ${index}`,
      text,
      url: source.url,
      kind: "style",
    });
  }
  for (const element of document.querySelectorAll("[style]")) {
    const text = element.getAttribute("style") ?? "";
    if (!text.trim()) continue;
    index += 1;
    units.push({
      name: `${source.name} ${element.localName}[style] ${index}`,
      text,
      url: source.url,
      kind: "style",
    });
  }
  return units;
}

export function htmlResourceReferences(
  html: string,
  baseUrl = KIDS_PAGE_URL,
): ResourceReference[] {
  const document = parseHtmlDocument(html);
  const effectiveBase = effectiveDocumentBase(document, baseUrl);
  const refs: ResourceReference[] = [];
  for (const element of document.querySelectorAll("script[src], link[href]")) {
    const tag = element.localName.toLowerCase();
    if (tag === "script") {
      refs.push({
        kind: "script",
        ref: element.getAttribute("src") ?? "",
        baseUrl: effectiveBase,
      });
      continue;
    }
    const rel = (element.getAttribute("rel") ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const href = element.getAttribute("href");
    if (
      href &&
      (rel.includes("stylesheet") || href.split(/[?#]/, 1)[0].endsWith(".css"))
    ) {
      refs.push({ kind: "style", ref: href, baseUrl: effectiveBase });
    }
  }
  return refs;
}

export function cssImportReferences(
  css: string,
  baseUrl: string,
): ResourceReference[] {
  return cssImportValues(css).map((ref) => ({ kind: "style", ref, baseUrl }));
}

export function resolveResourceReference(
  distDir: string,
  reference: ResourceReference,
): ResolvedResource {
  let parsed: URL;
  try {
    parsed = new URL(decodeHtml(reference.ref).replaceAll("\\/", "/"), reference.baseUrl);
  } catch (error) {
    return {
      ref: reference.ref,
      url: null,
      file: null,
      external: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ref: reference.ref,
      url: parsed.href,
      file: null,
      external: true,
      error: `unsupported resource protocol: ${parsed.protocol}`,
    };
  }
  if (parsed.origin !== KIDS_ORIGIN) {
    return {
      ref: reference.ref,
      url: parsed.href,
      file: null,
      external: true,
      error: null,
    };
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch (error) {
    return {
      ref: reference.ref,
      url: parsed.href,
      file: null,
      external: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const file = resolve(distDir, `.${pathname}`);
  const rel = relative(distDir, file).replace(/\\/g, "/");
  if (rel === ".." || rel.startsWith("../")) {
    return {
      ref: reference.ref,
      url: parsed.href,
      file: null,
      external: false,
      error: "resolved outside dist",
    };
  }

  return {
    ref: reference.ref,
    url: parsed.href,
    file,
    external: false,
    error: null,
  };
}
