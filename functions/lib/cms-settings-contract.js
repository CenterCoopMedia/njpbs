"use strict";
const { validatePostsBrowse } = require("./posts-browse-contract");

// Deployable mirror of packages/content-core/src/cms-settings.ts. Firebase
// deploys functions/ alone, so the parity suite covers success and failure paths.

const { isMediaAssetId } = require("./media-library");

const MAX_CMS_SETTINGS_FIELDS = 50;
const MAX_CMS_SETTINGS_FIELD_NAME_BYTES = 128;
const MAX_CMS_SETTINGS_STRING_BYTES = 65_536;
const MAX_CMS_SETTINGS_ASSET_LIST_ITEMS = 200;
// Working and published copies total at most 800 KB of JSON. The write boundary
// also measures the complete Firestore document before persistence.
const MAX_CMS_SETTINGS_VALUES_JSON_BYTES = 400_000;
const NEWSROOM_HOME_SETTINGS_ID = "newsroom-home";
const NEWSROOM_MILESTONE_SETTINGS_ID = "newsroom-milestone";
const NJ_DECIDES_SETTINGS_ID = "nj-decides-brand";
const COVERAGE_LABELS_SETTINGS_ID = "coverage-labels";
const MAX_COVERAGE_LABELS = 100;
function isCoverageLabelId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}
function validateCoverageLabels(value) {
  if (!Array.isArray(value) || value.length > MAX_COVERAGE_LABELS) return "Coverage labels must be a list of at most 100 labels.";
  const ids = /* @__PURE__ */ new Set();
  for (const label of value) {
    if (!plainObject(label) || Object.keys(label).some((key) => !["id", "name", "textColor", "backgroundColor", "href", "retired"].includes(key)) || !isCoverageLabelId(label.id) || ids.has(label.id)) return "Each coverage label needs a unique valid id.";
    ids.add(label.id);
    // eslint-disable-next-line no-control-regex -- Label names cannot contain controls.
    if (typeof label.name !== "string" || !label.name || label.name.trim() !== label.name || utf8Bytes(label.name) > 80 || /[\u0000-\u001f\u007f]/.test(label.name)) return "Coverage label names must be nonempty, trimmed text of at most 80 bytes.";
    if (typeof label.retired !== "boolean") return "Coverage label retired must be a boolean.";
    if (![label.textColor, label.backgroundColor].every((color) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color))) return "Coverage label colors must use six-digit hex values.";
    if (contrastRatio(label.textColor, label.backgroundColor) < 4.5) return "Coverage label text must have at least 4.5:1 contrast against its background.";
    if (label.href !== void 0) {
      // eslint-disable-next-line no-control-regex -- Reject controls and whitespace in links.
      if (typeof label.href !== "string" || utf8Bytes(label.href) > 2048 || safeHref(label.href) !== label.href || /[\\\u0000-\u0020\u007f]/.test(label.href) || !/^(?:https?:\/\/|\/(?!\/))/i.test(label.href)) return "Coverage label links must be safe web addresses or paths starting with /.";
      try {
        const url = new URL(label.href, "https://njpbs.org");
        if (url.username || url.password) return "Coverage label links cannot contain credentials.";
      } catch {
        return "Coverage label links must be valid web addresses.";
      }
    }
  }
  return null;
}

const PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID = "public-homepage-banner";
const SITE_NAVIGATION_SETTINGS_ID = "site-navigation";
const PUBLIC_SITE_CHROME_SETTINGS_ID = "public-site-chrome";
const SITE_NAVIGATION_ROUTE_KEYS = Object.freeze(["postsIndex", "inTheNews"]);
const SITE_NAVIGATION_LAUNCH_KEYS = Object.freeze([
  "pbsVideo",
  "donate",
  "passportLearnMore",
]);
const MAX_SITE_NAVIGATION_ID_BYTES = 64;
const MAX_SITE_NAVIGATION_PAGE_ID_BYTES = 80;
const MAX_SITE_NAVIGATION_LOCKED_LINKS = 20;
const DEFAULT_NEWSROOM_BANNER_HEADING =
  "Admin interface and user experience";
const DEFAULT_NEWSROOM_MILESTONE_NUMBER = 16;
// An omitted logoAssetId selects the bundled NJ_DECIDES_LOGO. Admin also uses
// this object for reset, so the stored defaults stay independent of an asset id.
const DEFAULT_NJ_DECIDES_SETTINGS = Object.freeze({
  backgroundColor: "#e9eaee",
  textColor: "#011375",
  linkColor: "#011375",
  ruleColor: "#8B0000",
  accentColor: "#011375",
  flagEnabled: true,
});
// Admin uses this only when it seeds the settings document. The public build
// reads the detached published snapshot and does not fall back to this value.
const DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS = Object.freeze({
  enabled: false,
  message: "Montclair State University will acquire NJ Spotlight.",
  linkLabel: "Read the announcement",
  linkHref:
    "https://inside.montclair.edu/news/montclair-state-university-acquire-nj-spotlight-commits-continuing-its-watchdog-journalism-through",
});

/**
 * @typedef {object} CmsSettingsSchemaShape
 * @property {number} schemaVersion
 * @property {Readonly<Record<string, Readonly<Record<string, unknown>>>>} fields
 */

/**
 * @typedef {object} CmsSettingsSchemaHistoryShape
 * @property {number} currentVersion
 * @property {Readonly<Record<number, CmsSettingsSchemaShape>>} versions
 */

/** @typedef {Readonly<Record<string, CmsSettingsSchemaHistoryShape>>} CmsSettingsSchemaCatalog */

// Deployable mirror of the approved product-owned settings catalog. The parity
// suite compares this complete object with packages/content-core.
const CMS_SETTINGS_SCHEMAS = Object.freeze({
  [COVERAGE_LABELS_SETTINGS_ID]: Object.freeze({ currentVersion: 1, versions: Object.freeze({
    1: Object.freeze({ schemaVersion: 1, fields: Object.freeze({ labels: Object.freeze({ kind: "coverageLabels", required: true }) }) }),
  }) }),

  [NEWSROOM_HOME_SETTINGS_ID]: Object.freeze({
    currentVersion: 1,
    versions: Object.freeze({
      1: Object.freeze({
        schemaVersion: 1,
        fields: Object.freeze({
          bannerHeading: Object.freeze({
            kind: "string",
            required: true,
            maxBytes: 160,
          }),
        }),
      }),
    }),
  }),
  [NEWSROOM_MILESTONE_SETTINGS_ID]: Object.freeze({
    currentVersion: 1,
    versions: Object.freeze({
      1: Object.freeze({
        schemaVersion: 1,
        fields: Object.freeze({
          milestoneNumber: Object.freeze({
            kind: "integer",
            required: true,
            minimum: 1,
            maximum: 10_000,
          }),
        }),
      }),
    }),
  }),
  [NJ_DECIDES_SETTINGS_ID]: Object.freeze({
    currentVersion: 1,
    versions: Object.freeze({
      1: Object.freeze({
        schemaVersion: 1,
        valueContract: "njDecidesBrandV1",
        fields: Object.freeze({
          backgroundColor: Object.freeze({
            kind: "string",
            required: true,
            maxBytes: 7,
            format: "hexColor",
          }),
          textColor: Object.freeze({
            kind: "string",
            required: true,
            maxBytes: 7,
            format: "hexColor",
          }),
          linkColor: Object.freeze({
            kind: "string",
            required: true,
            maxBytes: 7,
            format: "hexColor",
          }),
          ruleColor: Object.freeze({
            kind: "string",
            required: true,
            maxBytes: 7,
            format: "hexColor",
          }),
          accentColor: Object.freeze({
            kind: "string",
            required: true,
            maxBytes: 7,
            format: "hexColor",
          }),
          flagEnabled: Object.freeze({
            kind: "boolean",
            required: true,
          }),
          logoAssetId: Object.freeze({ kind: "assetId" }),
          logoAlt: Object.freeze({ kind: "string", maxBytes: 500 }),
          backgroundAssetId: Object.freeze({ kind: "assetId" }),
        }),
      }),
    }),
  }),
  [PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID]: Object.freeze({
    currentVersion: 4,
    versions: Object.freeze({
      1: Object.freeze({
        schemaVersion: 1,
        fields: Object.freeze({
          enabled: Object.freeze({
            kind: "boolean",
            required: true,
          }),
          message: Object.freeze({
            kind: "string",
            required: true,
            maxBytes: 240,
          }),
          linkLabel: Object.freeze({
            kind: "string",
            maxBytes: 80,
            pairedWith: "linkHref",
          }),
          linkHref: Object.freeze({
            kind: "safeHref",
            maxBytes: 2_048,
            pairedWith: "linkLabel",
          }),
        }),
      }),
      2: Object.freeze({
        schemaVersion: 2,
        valueContract: "publicHomepageBannerV2",
        fields: Object.freeze({
          enabled: Object.freeze({
            kind: "boolean",
            required: true,
          }),
          message: Object.freeze({
            kind: "string",
            required: true,
            allowEmpty: true,
            maxBytes: 240,
          }),
          linkLabel: Object.freeze({
            kind: "string",
            maxBytes: 80,
            pairedWith: "linkHref",
          }),
          linkHref: Object.freeze({
            kind: "safeHref",
            maxBytes: 2_048,
            pairedWith: "linkLabel",
          }),
          njDecides: Object.freeze({ kind: "boolean" }),
          liveLabel: Object.freeze({ kind: "string", maxBytes: 24 }),
          startsAt: Object.freeze({
            kind: "string",
            maxBytes: 64,
            format: "canonicalUtcInstant",
          }),
          endsAt: Object.freeze({
            kind: "string",
            maxBytes: 64,
            format: "canonicalUtcInstant",
          }),
        }),
      }),
      3: Object.freeze({
        schemaVersion: 3,
        valueContract: "publicHomepageBannerV2",
        fields: Object.freeze({
          enabled: Object.freeze({
            kind: "boolean",
            required: true,
          }),
          message: Object.freeze({
            kind: "string",
            required: true,
            allowEmpty: true,
            maxBytes: 240,
          }),
          linkLabel: Object.freeze({
            kind: "string",
            maxBytes: 80,
            pairedWith: "linkHref",
          }),
          linkHref: Object.freeze({
            kind: "safeHref",
            maxBytes: 2_048,
            pairedWith: "linkLabel",
          }),
          njDecides: Object.freeze({ kind: "boolean" }),
          liveLabel: Object.freeze({ kind: "string", maxBytes: 24 }),
          startsAt: Object.freeze({
            kind: "string",
            maxBytes: 64,
            format: "canonicalUtcInstant",
          }),
          endsAt: Object.freeze({
            kind: "string",
            maxBytes: 64,
            format: "canonicalUtcInstant",
          }),
          excludedPaths: Object.freeze({ kind: "canonicalPathList", maxItems: 50, maxBytes: 512 }),
        }),
      }),
      4: Object.freeze({
        schemaVersion: 4,
        valueContract: "publicHomepageBannerV4",
        fields: Object.freeze({
          enabled: Object.freeze({
            kind: "boolean",
            required: true,
          }),
          message: Object.freeze({
            kind: "string",
            required: true,
            allowEmpty: true,
            maxBytes: 240,
          }),
          linkLabel: Object.freeze({
            kind: "string",
            maxBytes: 80,
            pairedWith: "linkHref",
          }),
          linkHref: Object.freeze({
            kind: "safeHref",
            maxBytes: 2_048,
            pairedWith: "linkLabel",
          }),
          secondLinkLabel: Object.freeze({ kind: "string", maxBytes: 80, pairedWith: "secondLinkHref" }),
          secondLinkHref: Object.freeze({ kind: "safeHref", maxBytes: 2_048, pairedWith: "secondLinkLabel" }),
          njDecides: Object.freeze({ kind: "boolean" }),
          liveLabel: Object.freeze({ kind: "string", maxBytes: 24 }),
          startsAt: Object.freeze({
            kind: "string",
            maxBytes: 64,
            format: "canonicalUtcInstant",
          }),
          endsAt: Object.freeze({
            kind: "string",
            maxBytes: 64,
            format: "canonicalUtcInstant",
          }),
          excludedPaths: Object.freeze({ kind: "canonicalPathList", maxItems: 50, maxBytes: 512 }),
        }),
      }),
    }),
  }),
  [SITE_NAVIGATION_SETTINGS_ID]: Object.freeze({
    currentVersion: 2,
    versions: Object.freeze({
      1: Object.freeze({
        schemaVersion: 1,
        fields: Object.freeze({
          header: Object.freeze({
            kind: "navigationLinks",
            required: true,
            maxItems: 12,
            labelMaxBytes: 80,
            hrefMaxBytes: 2_048,
          }),
          // Contact is the captioning and accessibility contact path. It can
          // move and be renamed, but it cannot be removed or retargeted.
          footer: Object.freeze({
            kind: "navigationColumns",
            required: true,
            maxItems: 6,
            headingMaxBytes: 40,
            maxLinks: 10,
            labelMaxBytes: 80,
            hrefMaxBytes: 2_048,
            lockedLinks: Object.freeze([
              Object.freeze({
                id: "contact",
                target: Object.freeze({ type: "page", pageId: "contact" }),
              }),
            ]),
          }),
        }),
      }),
      2: Object.freeze({
        schemaVersion: 2,
        fields: Object.freeze({
          postsBrowse: Object.freeze({ kind: "postsBrowse" }),
          header: Object.freeze({
            kind: "navigationLinks",
            required: true,
            maxItems: 12,
            labelMaxBytes: 80,
            hrefMaxBytes: 2_048,
          }),
          // Contact is the captioning and accessibility contact path. It can
          // move and be renamed, but it cannot be removed or retargeted.
          footer: Object.freeze({
            kind: "navigationColumns",
            required: true,
            maxItems: 6,
            headingMaxBytes: 40,
            maxLinks: 10,
            labelMaxBytes: 80,
            hrefMaxBytes: 2_048,
            lockedLinks: Object.freeze([
              Object.freeze({
                id: "contact",
                target: Object.freeze({ type: "page", pageId: "contact" }),
              }),
            ]),
          }),
        }),
      }),
    }),
  }),
  [PUBLIC_SITE_CHROME_SETTINGS_ID]: Object.freeze({
    currentVersion: 1,
    versions: Object.freeze({
      1: Object.freeze({
        schemaVersion: 1,
        fields: Object.freeze({
          newsletterEnabled: Object.freeze({
            kind: "boolean",
            required: true,
          }),
          newsletterLabel: Object.freeze({
            kind: "string",
            required: true,
            maxBytes: 80,
          }),
          newsletterHref: Object.freeze({
            kind: "safeHref",
            required: true,
            maxBytes: 2_048,
            absoluteOrRootRelative: true,
          }),
          newsletterOpensInNewTab: Object.freeze({
            kind: "boolean",
            required: true,
          }),
        }),
      }),
    }),
  }),
});

// Version 1 allowed duplicate footer headings before the uniqueness rule was
// added. Management reads retain those values so staff can correct them. New
// saves, publication and public rendering still use CMS_SETTINGS_SCHEMAS.
const navigationSchemaV1 = CMS_SETTINGS_SCHEMAS[SITE_NAVIGATION_SETTINGS_ID].versions[1];
const CMS_SETTINGS_READ_SCHEMAS = Object.freeze({
  ...CMS_SETTINGS_SCHEMAS,
  [SITE_NAVIGATION_SETTINGS_ID]: Object.freeze({
    ...CMS_SETTINGS_SCHEMAS[SITE_NAVIGATION_SETTINGS_ID],
    versions: Object.freeze({
      ...CMS_SETTINGS_SCHEMAS[SITE_NAVIGATION_SETTINGS_ID].versions,
      1: Object.freeze({
        ...navigationSchemaV1,
        fields: Object.freeze({
          ...navigationSchemaV1.fields,
          footer: Object.freeze({ ...navigationSchemaV1.fields.footer, uniqueHeadings: false }),
        }),
      }),
    }),
  }),
});

class CmsSettingsContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "CmsSettingsContractError";
  }
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

function positiveVersion(value) {
  return Number.isSafeInteger(value) && value > 0;
}

const SAFE_HREF_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

function safeHref(raw) {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex -- Strip ASCII controls from user-supplied links.
  const href = raw.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (href.length === 0) return null;
  if (href.replace(/\\/g, "/").startsWith("//")) return null;
  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i);
  const protocol = scheme?.[1].toLowerCase();
  if (protocol && !SAFE_HREF_SCHEMES.has(protocol)) return null;
  if (protocol === "http" || protocol === "https") {
    try {
      const url = new URL(href);
      if (url.username || url.password) return null;
    } catch {
      return null;
    }
  }
  return href;
}

// Navigation renders on every page, so a relative address such as `schedule`,
// `../contact`, `?ref=1` or `#hours` would resolve differently on each page. A
// navigation web address must be an http(s), mailto: or tel: URL, or a path
// that starts with one "/". It must also pass the shared safe-link rule.
function safeNavigationHref(raw) {
  if (typeof raw !== "string" || safeHref(raw) !== raw) return null;
  return /^(?:https?:\/\/|mailto:|tel:)/i.test(raw) || /^\/(?![/\\])/.test(raw)
    ? raw
    : null;
}

const SITE_NAVIGATION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SITE_NAVIGATION_HASH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const LINK_FIELDS = new Set(["id", "label", "target", "external"]);
const COLUMN_FIELDS = new Set(["id", "heading", "links"]);
const PAGE_TARGET_FIELDS = new Set(["type", "pageId", "hash"]);
const KEY_TARGET_FIELDS = new Set(["type", "key"]);
const HREF_TARGET_FIELDS = new Set(["type", "href"]);

function hasOnlyFields(value, fields) {
  return Object.keys(value).every((key) => fields.has(key));
}

function navigationId(value, maxBytes = MAX_SITE_NAVIGATION_ID_BYTES) {
  return (
    typeof value === "string" &&
    utf8Bytes(value) <= maxBytes &&
    SITE_NAVIGATION_ID_PATTERN.test(value)
  );
}

function boundedByteLimit(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_CMS_SETTINGS_STRING_BYTES
  );
}

function boundedItemLimit(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_CMS_SETTINGS_ASSET_LIST_ITEMS
  );
}

function navigationTargetError(target, hrefMaxBytes) {
  if (!plainObject(target)) return "target is invalid";
  switch (target.type) {
    case "page":
      if (!hasOnlyFields(target, PAGE_TARGET_FIELDS)) return "target is invalid";
      if (!navigationId(target.pageId, MAX_SITE_NAVIGATION_PAGE_ID_BYTES)) {
        return "target must name a public page";
      }
      if (
        target.hash !== undefined &&
        (typeof target.hash !== "string" ||
          !SITE_NAVIGATION_HASH_PATTERN.test(target.hash))
      ) {
        return "target section anchor is invalid";
      }
      return null;
    case "route":
      return hasOnlyFields(target, KEY_TARGET_FIELDS) &&
        SITE_NAVIGATION_ROUTE_KEYS.includes(target.key)
        ? null
        : "target is invalid";
    case "launch":
      return hasOnlyFields(target, KEY_TARGET_FIELDS) &&
        SITE_NAVIGATION_LAUNCH_KEYS.includes(target.key)
        ? null
        : "target is invalid";
    case "href":
      if (!hasOnlyFields(target, HREF_TARGET_FIELDS) || typeof target.href !== "string") {
        return "target is invalid";
      }
      if (utf8Bytes(target.href) > hrefMaxBytes) {
        return `target link can be at most ${hrefMaxBytes} bytes`;
      }
      return safeNavigationHref(target.href) === target.href
        ? null
        : "target must contain a safe link";
    default:
      return "target is invalid";
  }
}

function sameNavigationTarget(left, right) {
  if (!plainObject(left) || !plainObject(right)) return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => left[key] === right[key]);
}

function navigationLinkError(link, path, labelMaxBytes, hrefMaxBytes) {
  if (
    !plainObject(link) ||
    !hasOnlyFields(link, LINK_FIELDS) ||
    !Object.hasOwn(link, "target")
  ) {
    return `${path} must be a link`;
  }
  if (!navigationId(link.id)) return `${path}.id is invalid`;
  if (typeof link.label !== "string" || link.label.trim() === "") {
    return `${path}.label is required`;
  }
  if (utf8Bytes(link.label) > labelMaxBytes) {
    return `${path}.label can be at most ${labelMaxBytes} bytes`;
  }
  if (typeof link.external !== "boolean") {
    return `${path}.external must be a boolean`;
  }
  const targetError = navigationTargetError(link.target, hrefMaxBytes);
  return targetError ? `${path}.${targetError}` : null;
}

function navigationLinksError(field, definition, value) {
  if (!Array.isArray(value)) return `${field} must be an array of links`;
  if (value.length === 0) return `${field} must contain at least one link`;
  if (value.length > definition.maxItems) {
    return `${field} can contain at most ${definition.maxItems} links`;
  }
  const ids = new Set();
  for (const [index, link] of value.entries()) {
    const error = navigationLinkError(
      link,
      `${field}[${index}]`,
      definition.labelMaxBytes,
      definition.hrefMaxBytes,
    );
    if (error) return error;
    if (ids.has(link.id)) return `${field} ids must be unique`;
    ids.add(link.id);
  }
  return null;
}

// Column and link ids share one namespace so every footer item has one
// stable identity, including the locked links the schema names.
function navigationColumnsError(field, definition, value) {
  if (!Array.isArray(value)) return `${field} must be an array of columns`;
  if (value.length === 0) return `${field} must contain at least one column`;
  if (value.length > definition.maxItems) {
    return `${field} can contain at most ${definition.maxItems} columns`;
  }
  const ids = new Set();
  const headings = new Set();
  const links = new Map();
  for (const [index, column] of value.entries()) {
    const path = `${field}[${index}]`;
    if (
      !plainObject(column) ||
      !hasOnlyFields(column, COLUMN_FIELDS) ||
      !Object.hasOwn(column, "links")
    ) {
      return `${path} must be a column`;
    }
    if (!navigationId(column.id)) return `${path}.id is invalid`;
    if (typeof column.heading !== "string" || column.heading.trim() === "") {
      return `${path}.heading is required`;
    }
    if (utf8Bytes(column.heading) > definition.headingMaxBytes) {
      return `${path}.heading can be at most ${definition.headingMaxBytes} bytes`;
    }
    const heading = column.heading.trim().replace(/\s+/g, " ").toLowerCase();
    if (definition.uniqueHeadings !== false && headings.has(heading)) {
      return `${path}.heading must be unique`;
    }
    headings.add(heading);
    if (!Array.isArray(column.links)) return `${path}.links must be an array of links`;
    if (column.links.length === 0) return `${path}.links must contain at least one link`;
    if (column.links.length > definition.maxLinks) {
      return `${path}.links can contain at most ${definition.maxLinks} links`;
    }
    if (ids.has(column.id)) return `${field} ids must be unique`;
    ids.add(column.id);
    for (const [linkIndex, link] of column.links.entries()) {
      const error = navigationLinkError(
        link,
        `${path}.links[${linkIndex}]`,
        definition.labelMaxBytes,
        definition.hrefMaxBytes,
      );
      if (error) return error;
      if (ids.has(link.id)) return `${field} ids must be unique`;
      ids.add(link.id);
      links.set(link.id, link);
    }
  }
  for (const locked of definition.lockedLinks ?? []) {
    const link = links.get(locked.id);
    if (!link) return `${field} must keep the ${locked.id} link`;
    if (!sameNavigationTarget(link.target, locked.target)) {
      return `${field} link ${locked.id} cannot change its target`;
    }
  }
  return null;
}

function lockedLinksDefinitionValid(value, hrefMaxBytes) {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > MAX_SITE_NAVIGATION_LOCKED_LINKS) {
    return false;
  }
  const ids = new Set();
  for (const locked of value) {
    if (
      !plainObject(locked) ||
      Object.keys(locked).length !== 2 ||
      !navigationId(locked.id) ||
      ids.has(locked.id) ||
      navigationTargetError(locked.target, hrefMaxBytes) !== null
    ) {
      return false;
    }
    ids.add(locked.id);
  }
  return true;
}

function cloneNavigationTarget(target) {
  switch (target.type) {
    case "page":
      return {
        type: "page",
        pageId: target.pageId,
        ...(target.hash !== undefined ? { hash: target.hash } : {}),
      };
    case "href":
      return { type: "href", href: target.href };
    default:
      return { type: target.type, key: target.key };
  }
}

function navigationTargetAllowsNewTab(target) {
  return target.type === "launch" ||
    (target.type === "href" && /^https?:\/\//i.test(target.href.trim()));
}

function cloneNavigationLink(link) {
  return {
    id: link.id,
    label: link.label,
    target: cloneNavigationTarget(link.target),
    external: link.external && navigationTargetAllowsNewTab(link.target),
  };
}

function cloneSettingsValue(definition, value) {
  if (definition.kind === "postsBrowse") return JSON.parse(JSON.stringify(value));
  if (definition.kind === "coverageLabels" && Array.isArray(value)) return value.map(label => ({ ...label }));
  if (definition.kind === "navigationLinks" && Array.isArray(value)) {
    return value.map(cloneNavigationLink);
  }
  if (definition.kind === "navigationColumns" && Array.isArray(value)) {
    return value.map((column) => ({
      id: column.id,
      heading: column.heading,
      links: column.links.map(cloneNavigationLink),
    }));
  }
  return Array.isArray(value) ? [...value] : value;
}

function schemaError(schema) {
  if (
    !plainObject(schema) ||
    !positiveVersion(schema.schemaVersion) ||
    !plainObject(schema.fields) ||
    Object.keys(schema).some(
      (key) => key !== "schemaVersion" && key !== "fields" && key !== "valueContract",
    ) ||
    (schema.valueContract !== undefined &&
      schema.valueContract !== "njDecidesBrandV1" &&
      schema.valueContract !== "publicHomepageBannerV2" &&
      schema.valueContract !== "publicHomepageBannerV4") ||
    Object.keys(schema.fields).length > MAX_CMS_SETTINGS_FIELDS
  ) {
    return "The CMS settings schema is invalid";
  }
  for (const [field, definition] of Object.entries(schema.fields)) {
    if (
      !field ||
      utf8Bytes(field) > MAX_CMS_SETTINGS_FIELD_NAME_BYTES ||
      !plainObject(definition) ||
      typeof definition.kind !== "string"
    ) {
      return "The CMS settings schema is invalid";
    }
    if (
      definition.required !== undefined &&
      typeof definition.required !== "boolean"
    ) {
      return "The CMS settings schema is invalid";
    }
    const keys = new Set(Object.keys(definition));
    keys.delete("kind");
    keys.delete("required");
    if (definition.kind === "string" || definition.kind === "safeHref") {
      keys.delete("maxBytes");
      keys.delete("pairedWith");
      if (definition.kind === "string") {
        keys.delete("allowEmpty");
        keys.delete("format");
      }
      if (definition.kind === "safeHref") keys.delete("absoluteOrRootRelative");
      if (
        (definition.kind === "string" &&
          definition.format !== undefined &&
          definition.format !== "hexColor" &&
          definition.format !== "canonicalUtcInstant") ||
        (definition.kind === "string" &&
          definition.allowEmpty !== undefined &&
          typeof definition.allowEmpty !== "boolean") ||
        (definition.absoluteOrRootRelative !== undefined &&
          typeof definition.absoluteOrRootRelative !== "boolean") ||
        !Number.isSafeInteger(definition.maxBytes) ||
        definition.maxBytes < 1 ||
        definition.maxBytes > MAX_CMS_SETTINGS_STRING_BYTES
      ) {
        return "The CMS settings schema is invalid";
      }
      if (
        definition.pairedWith !== undefined &&
        (typeof definition.pairedWith !== "string" ||
          definition.pairedWith.length === 0 ||
          utf8Bytes(definition.pairedWith) > MAX_CMS_SETTINGS_FIELD_NAME_BYTES)
      ) {
        return "The CMS settings schema is invalid";
      }
    } else if (definition.kind === "integer") {
      keys.delete("minimum");
      keys.delete("maximum");
      if (
        !Number.isSafeInteger(definition.minimum) ||
        !Number.isSafeInteger(definition.maximum) ||
        definition.minimum > definition.maximum
      ) {
        return "The CMS settings schema is invalid";
      }
    } else if (definition.kind === "stringList") {
      keys.delete("maxItems");
      keys.delete("allowedValues");
      keys.delete("unique");
      if (
        !Number.isSafeInteger(definition.maxItems) ||
        definition.maxItems < 1 ||
        definition.maxItems > MAX_CMS_SETTINGS_ASSET_LIST_ITEMS ||
        !Array.isArray(definition.allowedValues) ||
        definition.allowedValues.length === 0 ||
        definition.allowedValues.length > MAX_CMS_SETTINGS_ASSET_LIST_ITEMS ||
        definition.allowedValues.some(
          (item) =>
            typeof item !== "string" ||
            item.length === 0 ||
            utf8Bytes(item) > MAX_CMS_SETTINGS_FIELD_NAME_BYTES,
        ) ||
        new Set(definition.allowedValues).size !== definition.allowedValues.length ||
        (definition.unique !== undefined && typeof definition.unique !== "boolean")
      ) {
        return "The CMS settings schema is invalid";
      }
    } else if (definition.kind === "canonicalPathList") {
      keys.delete("maxItems"); keys.delete("maxBytes");
      if (!Number.isSafeInteger(definition.maxItems) || definition.maxItems < 1 ||
          definition.maxItems > MAX_CMS_SETTINGS_ASSET_LIST_ITEMS ||
          !Number.isSafeInteger(definition.maxBytes) || definition.maxBytes < 1 ||
          definition.maxBytes > MAX_CMS_SETTINGS_STRING_BYTES) return "The CMS settings schema is invalid";
    } else if (definition.kind === "assetIdList") {
      keys.delete("maxItems");
      if (
        !Number.isSafeInteger(definition.maxItems) ||
        definition.maxItems < 1 ||
        definition.maxItems > MAX_CMS_SETTINGS_ASSET_LIST_ITEMS
      ) {
        return "The CMS settings schema is invalid";
      }
    } else if (definition.kind === "navigationLinks") {
      keys.delete("maxItems");
      keys.delete("labelMaxBytes");
      keys.delete("hrefMaxBytes");
      if (
        !boundedItemLimit(definition.maxItems) ||
        !boundedByteLimit(definition.labelMaxBytes) ||
        !boundedByteLimit(definition.hrefMaxBytes)
      ) {
        return "The CMS settings schema is invalid";
      }
    } else if (definition.kind === "navigationColumns") {
      for (const key of [
        "maxItems",
        "headingMaxBytes",
        "uniqueHeadings",
        "maxLinks",
        "labelMaxBytes",
        "hrefMaxBytes",
        "lockedLinks",
      ]) {
        keys.delete(key);
      }
      if (
        !boundedItemLimit(definition.maxItems) ||
        !boundedByteLimit(definition.headingMaxBytes) ||
        (definition.uniqueHeadings !== undefined && typeof definition.uniqueHeadings !== "boolean") ||
        !boundedItemLimit(definition.maxLinks) ||
        !boundedByteLimit(definition.labelMaxBytes) ||
        !boundedByteLimit(definition.hrefMaxBytes) ||
        !lockedLinksDefinitionValid(definition.lockedLinks, definition.hrefMaxBytes)
      ) {
        return "The CMS settings schema is invalid";
      }
    } else if (definition.kind !== "boolean" && definition.kind !== "assetId" && definition.kind !== "coverageLabels" && definition.kind !== "postsBrowse") {
      return "The CMS settings schema is invalid";
    }
    if (keys.size > 0) return "The CMS settings schema is invalid";
  }
  for (const [field, definition] of Object.entries(schema.fields)) {
    if (
      (definition.kind === "string" || definition.kind === "safeHref") &&
      definition.pairedWith !== undefined
    ) {
      const paired = schema.fields[definition.pairedWith];
      if (
        definition.pairedWith === field ||
        !paired ||
        (paired.kind !== "string" && paired.kind !== "safeHref") ||
        paired.pairedWith !== field
      ) {
        return "The CMS settings schema is invalid";
      }
    }
  }
  return null;
}

function schemaHistoryFor(documentId, schemas) {
  if (
    typeof documentId !== "string" ||
    documentId.length === 0 ||
    !plainObject(schemas) ||
    !Object.hasOwn(schemas, documentId)
  ) {
    return null;
  }
  const history = schemas[documentId];
  if (
    !plainObject(history) ||
    !positiveVersion(history.currentVersion) ||
    !plainObject(history.versions) ||
    Object.keys(history).some(
      (key) => key !== "currentVersion" && key !== "versions",
    )
  ) {
    return null;
  }
  const versions = Object.entries(history.versions);
  if (versions.length === 0) return null;
  for (const [key, schema] of versions) {
    const version = Number(key);
    if (
      !positiveVersion(version) ||
      String(version) !== key ||
      schemaError(schema) !== null ||
      schema.schemaVersion !== version
    ) {
      return null;
    }
  }
  if (!Object.hasOwn(history.versions, history.currentVersion)) return null;
  return history;
}

/**
 * @param {unknown} documentId
 * @param {unknown} schemaVersion
 * @param {CmsSettingsSchemaCatalog} [schemas]
 */
function cmsSettingsSchemaFor(
  documentId,
  schemaVersion,
  schemas = CMS_SETTINGS_SCHEMAS,
) {
  if (!positiveVersion(schemaVersion)) return null;
  const history = schemaHistoryFor(documentId, schemas);
  if (!history || !Object.hasOwn(history.versions, schemaVersion)) return null;
  return history.versions[schemaVersion] ?? null;
}

/**
 * @param {unknown} documentId
 * @param {CmsSettingsSchemaCatalog} [schemas]
 */
function currentCmsSettingsSchemaFor(
  documentId,
  schemas = CMS_SETTINGS_SCHEMAS,
) {
  const history = schemaHistoryFor(documentId, schemas);
  if (!history) return null;
  return history.versions[history.currentVersion] ?? null;
}

function cloneSettingsValues(schema, values) {
  return Object.fromEntries(
    Object.keys(schema.fields)
      .filter((field) => values[field] !== undefined)
      .map((field) => [
        field,
        cloneSettingsValue(schema.fields[field], values[field]),
      ]),
  );
}

function validateCmsSettingsValues(schema, values) {
  const invalidSchema = schemaError(schema);
  if (invalidSchema) return invalidSchema;
  if (!plainObject(values)) return "CMS settings values must be an object";

  for (const field of Object.keys(values)) {
    if (!Object.hasOwn(schema.fields, field)) {
      return `Unknown settings field ${field}`;
    }
  }

  for (const [field, definition] of Object.entries(schema.fields)) {
    const value = values[field];
    if (value === null && definition.kind === "postsBrowse") return "Posts browsing must be an arrangement, not null.";
    if (value === null && definition.kind === "canonicalPathList") return `${field} must be an array of canonical site paths`;
    if (value === undefined || value === null) {
      if (definition.required === true) return `${field} is required`;
      continue;
    }
    switch (definition.kind) {
      case "postsBrowse": {
        const error = validatePostsBrowse(value);
        if (error) return error;
        break;
      }
      case "coverageLabels": { const error = validateCoverageLabels(value); if (error) return error; break; }
      case "boolean":
        if (typeof value !== "boolean") return `${field} must be a boolean`;
        break;
      case "integer":
        if (
          !Number.isSafeInteger(value) ||
          value < definition.minimum ||
          value > definition.maximum
        ) {
          return `${field} must be an integer from ${definition.minimum} to ${definition.maximum}`;
        }
        break;
      case "string":
        if (typeof value !== "string") return `${field} must be a string`;
        if (
          definition.required === true &&
          definition.allowEmpty !== true &&
          value.trim() === ""
        ) {
          return `${field} is required`;
        }
        if (utf8Bytes(value) > definition.maxBytes) {
          return `${field} can be at most ${definition.maxBytes} bytes`;
        }
        if (definition.format === "hexColor" && !/^#[0-9A-Fa-f]{6}$/.test(value)) {
          return `${field} must use #RRGGBB`;
        }
        if (definition.format === "canonicalUtcInstant" && !canonicalInstant(value)) {
          return `${field} must be a canonical UTC instant`;
        }
        break;
      case "safeHref":
        if (typeof value !== "string") return `${field} must be a string`;
        if (value === "" && definition.required !== true) break;
        if (definition.required === true && value.trim() === "") {
          return `${field} is required`;
        }
        if (utf8Bytes(value) > definition.maxBytes) {
          return `${field} can be at most ${definition.maxBytes} bytes`;
        }
        if (safeHref(value) !== value) {
          return `${field} must contain a safe link`;
        }
        if (definition.absoluteOrRootRelative === true && safeNavigationHref(value) !== value) {
          return `${field} must be a web, email or phone address, or a path that starts with /`;
        }
        break;
      case "stringList":
        if (!Array.isArray(value)) return `${field} must be an array of strings`;
        if (value.length > definition.maxItems) {
          return `${field} can contain at most ${definition.maxItems} items`;
        }
        if (value.some((item) => typeof item !== "string")) {
          return `${field} must contain only strings`;
        }
        if (value.some((item) => !definition.allowedValues.includes(item))) {
          return `${field} contains an unsupported value`;
        }
        if (definition.unique === true && new Set(value).size !== value.length) {
          return `${field} must not contain duplicate values`;
        }
        break;
      case "canonicalPathList":
        if (!Array.isArray(value)) return `${field} must be an array of canonical site paths`;
        if (value.length > definition.maxItems) return `${field} can contain at most ${definition.maxItems} paths`;
        if (value.some(path => typeof path !== "string" || utf8Bytes(path) > definition.maxBytes ||
            !/^(?:\/|\/(?:[a-z0-9][a-z0-9_-]*\/)+)$/.test(path))) {
          return `${field} must contain canonical site paths`;
        }
        if (new Set(value).size !== value.length) return `${field} must not contain duplicate paths`;
        break;
      case "assetId":
        if (value === "" && definition.required !== true) break;
        if (!isMediaAssetId(value)) {
          return `${field} must contain a valid media asset id`;
        }
        break;
      case "assetIdList":
        if (!Array.isArray(value)) {
          return `${field} must be an array of media asset ids`;
        }
        if (value.length > definition.maxItems) {
          return `${field} can contain at most ${definition.maxItems} items`;
        }
        if (value.some((item) => !isMediaAssetId(item))) {
          return `${field} must contain valid media asset ids`;
        }
        break;
      case "navigationLinks": {
        const error = navigationLinksError(field, definition, value);
        if (error) return error;
        break;
      }
      case "navigationColumns": {
        const error = navigationColumnsError(field, definition, value);
        if (error) return error;
        break;
      }
    }
  }

  for (const [field, definition] of Object.entries(schema.fields)) {
    if (
      (definition.kind === "string" || definition.kind === "safeHref") &&
      definition.pairedWith !== undefined
    ) {
      const value = values[field];
      const pairedValue = values[definition.pairedWith];
      const present = typeof value === "string" && value.trim().length > 0;
      const pairedPresent =
        typeof pairedValue === "string" && pairedValue.trim().length > 0;
      if (present !== pairedPresent) {
        return `${field} and ${definition.pairedWith} must be provided together`;
      }
    }
  }

  const valueContractError = validateValueContract(schema.valueContract, values);
  if (valueContractError) return valueContractError;

  const canonicalValues = cloneSettingsValues(schema, values);
  if (utf8Bytes(JSON.stringify(canonicalValues)) > MAX_CMS_SETTINGS_VALUES_JSON_BYTES) {
    return `CMS settings values can be at most ${MAX_CMS_SETTINGS_VALUES_JSON_BYTES} bytes`;
  }
  return null;
}

function relativeLuminance(hex) {
  const channel = (offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function validateValueContract(contract, values) {
  if (contract === "publicHomepageBannerV2" || contract === "publicHomepageBannerV4") {
    const startsAt = values.startsAt;
    const endsAt = values.endsAt;
    if (
      typeof startsAt === "string" &&
      typeof endsAt === "string" &&
      new Date(startsAt).getTime() >= new Date(endsAt).getTime()
    ) {
      return "startsAt must be before endsAt";
    }
    if (
      values.njDecides !== true &&
      typeof values.message === "string" &&
      values.message.trim() === ""
    ) {
      return "message is required unless NJ Decides mode is enabled";
    }
    if (values.njDecides === true) {
      for (const field of contract === "publicHomepageBannerV4" ? ["linkHref", "secondLinkHref"] : ["linkHref"]) {
        const href = values[field];
        if (typeof href === "string" && href.trim() !== "" && safeNavigationHref(href) !== href) {
          return `${field} must be an absolute address or a path that starts with / for NJ Decides`;
        }
      }
    }
    if (contract === "publicHomepageBannerV4" &&
      typeof values.secondLinkLabel === "string" && values.secondLinkLabel.trim() !== "" &&
      !(typeof values.linkLabel === "string" && values.linkLabel.trim() !== "")) {
      return "secondLinkLabel requires the first link";
    }
    return null;
  }
  if (contract !== "njDecidesBrandV1") return null;
  if (
    typeof values.logoAssetId === "string" &&
    values.logoAssetId !== "" &&
    (typeof values.logoAlt !== "string" || values.logoAlt.trim() === "")
  ) {
    return "logoAlt is required when logoAssetId is set";
  }
  const background = values.backgroundColor;
  for (const field of ["textColor", "linkColor"]) {
    if (contrastRatio(values[field], background) < 4.5) {
      return `${field === "textColor" ? "Text" : "Link"} color must have at least 4.5:1 contrast against the background color.`;
    }
  }
  return null;
}

function collectCmsSettingsAssetOccurrences(schema, values) {
  const error = validateCmsSettingsValues(schema, values);
  if (error) throw new CmsSettingsContractError(error);
  const occurrences = [];
  for (const [field, definition] of Object.entries(schema.fields)) {
    const value = values[field];
    if (definition.kind === "assetId" && typeof value === "string" && value !== "") {
      occurrences.push(value);
    } else if (definition.kind === "assetIdList" && Array.isArray(value)) {
      occurrences.push(...value);
    }
  }
  return occurrences;
}

function canonicalInstant(value) {
  if (typeof value !== "string" || value.length > 64) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function createCmsSettingsPublishedSnapshot({
  schema,
  values,
  sourceVersion,
  publishedAt,
}) {
  const error = validateCmsSettingsValues(schema, values);
  if (error) throw new CmsSettingsContractError(error);
  if (!positiveVersion(sourceVersion)) {
    throw new CmsSettingsContractError("The CMS settings source version is invalid");
  }
  if (!canonicalInstant(publishedAt)) {
    throw new CmsSettingsContractError("The CMS settings publish time is invalid");
  }
  return {
    schemaVersion: schema.schemaVersion,
    values: cloneSettingsValues(schema, values),
    sourceVersion,
    publishedAt,
  };
}

/**
 * @param {{
 *   documentId: unknown,
 *   schemas?: CmsSettingsSchemaCatalog,
 *   document: unknown,
 * }} input
 */
function projectPublishedCmsSettings({
  documentId,
  schemas = CMS_SETTINGS_SCHEMAS,
  document,
}) {
  if (!plainObject(document)) {
    throw new CmsSettingsContractError("The CMS settings document is invalid");
  }
  if (!positiveVersion(document.version)) {
    throw new CmsSettingsContractError("The CMS settings document version is invalid");
  }
  if (document.published === undefined) return null;
  if (!plainObject(document.published)) {
    throw new CmsSettingsContractError("The CMS settings published snapshot is invalid");
  }
  const allowed = new Set([
    "schemaVersion",
    "values",
    "sourceVersion",
    "publishedAt",
  ]);
  if (
    Object.keys(document.published).some((field) => !allowed.has(field)) ||
    !Object.hasOwn(document.published, "schemaVersion") ||
    !Object.hasOwn(document.published, "values") ||
    !Object.hasOwn(document.published, "sourceVersion") ||
    !Object.hasOwn(document.published, "publishedAt")
  ) {
    throw new CmsSettingsContractError("The CMS settings published snapshot is invalid");
  }
  if (
    !positiveVersion(document.published.sourceVersion) ||
    document.published.sourceVersion > document.version
  ) {
    throw new CmsSettingsContractError("The CMS settings source version is invalid");
  }
  const schema = cmsSettingsSchemaFor(
    documentId,
    document.published.schemaVersion,
    schemas,
  );
  if (!schema) {
    throw new CmsSettingsContractError(
      "The CMS settings published schema is not available",
    );
  }
  return createCmsSettingsPublishedSnapshot({
    schema,
    values: document.published.values,
    sourceVersion: document.published.sourceVersion,
    publishedAt: document.published.publishedAt,
  });
}

module.exports = {
  COVERAGE_LABELS_SETTINGS_ID, MAX_COVERAGE_LABELS, isCoverageLabelId, validateCoverageLabels,
  CMS_SETTINGS_READ_SCHEMAS,
  CMS_SETTINGS_SCHEMAS,
  DEFAULT_NEWSROOM_BANNER_HEADING,
  DEFAULT_NEWSROOM_MILESTONE_NUMBER,
  DEFAULT_NJ_DECIDES_SETTINGS,
  DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS,
  MAX_CMS_SETTINGS_ASSET_LIST_ITEMS,
  MAX_CMS_SETTINGS_FIELD_NAME_BYTES,
  MAX_CMS_SETTINGS_FIELDS,
  MAX_CMS_SETTINGS_STRING_BYTES,
  MAX_CMS_SETTINGS_VALUES_JSON_BYTES,
  NEWSROOM_HOME_SETTINGS_ID,
  NEWSROOM_MILESTONE_SETTINGS_ID,
  NJ_DECIDES_SETTINGS_ID,
  PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
  PUBLIC_SITE_CHROME_SETTINGS_ID,
  SITE_NAVIGATION_LAUNCH_KEYS,
  SITE_NAVIGATION_ROUTE_KEYS,
  SITE_NAVIGATION_SETTINGS_ID,
  CmsSettingsContractError,
  cloneSettingsValues,
  navigationTargetAllowsNewTab,
  cmsSettingsSchemaFor,
  collectCmsSettingsAssetOccurrences,
  createCmsSettingsPublishedSnapshot,
  currentCmsSettingsSchemaFor,
  projectPublishedCmsSettings,
  safeNavigationHref,
  validateCmsSettingsValues,
};
