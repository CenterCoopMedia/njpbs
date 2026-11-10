import { describe, expect, it } from "vitest";
import {
  KIDS_PAGE_URL,
  absoluteUrlReferences,
  cssImportReferences,
  executableUnits,
  htmlResourceReferences,
  markupUrlSurface,
  parseUrlReference,
  resolveResourceReference,
  styleUnits,
} from "../scripts/kids-coppa-url-guard";
import { cssUrlReferences } from "../scripts/kids-coppa-css-guard";
import {
  analyzeClientCode,
  analyzeModuleDependencies,
  storagePolicyViolations,
} from "../scripts/kids-coppa-client-guard";

const storagePolicy = new Map([
  ["njpbs-motion", new Set(["on", "off"])],
]);

describe("Kids COPPA URL analysis", () => {
  it("reads the real host after a URL userinfo segment", () => {
    expect(
      absoluteUrlReferences("https://pbskids.org@tracker.example/pixel")[0],
    ).toMatchObject({
      hostname: "tracker.example",
      error: null,
    });
  });

  it("accepts reviewed non-network navigation without treating it as a fetch", () => {
    expect(
      parseUrlReference(
        "mailto:njpbs@montclair.edu?subject=Website%20problem%20report",
      ),
    ).toMatchObject({
      origin: null,
      hostname: null,
      error: null,
    });
    expect(parseUrlReference("tel:+19736555555")).toMatchObject({
      origin: null,
      hostname: null,
      error: null,
    });
  });

  it("reports malformed and unsupported URLs instead of dropping them", () => {
    expect(absoluteUrlReferences("https://%zz/")[0]?.error).toBeTruthy();
    expect(parseUrlReference("data:text/plain,tracker").error).toMatch(
      /unsupported URL protocol/,
    );
    expect(parseUrlReference("javascript:alert(1)").error).toMatch(
      /unsupported URL protocol/,
    );
  });

  it("treats meta refresh as an automatic request, not a chosen link", () => {
    const surface = markupUrlSurface(
      '<meta http-equiv="refresh" content="0; url=https://tracker.example/leave">',
    );
    expect(surface.fetched.map((ref) => ref.hostname)).toContain(
      "tracker.example",
    );
    expect(surface.linked.map((ref) => ref.hostname)).not.toContain(
      "tracker.example",
    );
  });

  it("keeps anchor destinations separate from fetched attributes", () => {
    const surface = markupUrlSurface(
      '<a href="https://pbskids.org/">Kids</a><img src="https://pbskids.org/pixel.png">',
    );
    expect(surface.linked.map((ref) => ref.hostname)).toContain("pbskids.org");
    expect(surface.fetched.map((ref) => ref.hostname)).toContain("pbskids.org");
  });


  it("decodes browser HTML character references in request attributes", () => {
    const surface = markupUrlSurface(
      '<img src="https&#58;//tracker.example/pixel"><img src="https&colon;//tracker-two.example/pixel">',
    );
    expect(surface.fetched.map((ref) => ref.hostname)).toEqual([
      "tracker.example",
      "tracker-two.example",
    ]);
  });

  it("preserves the browser's first duplicate URL attribute", () => {
    const surface = markupUrlSurface(
      '<img src="https://tracker.example/pixel" src="/safe.png">',
    );
    expect(surface.fetched).toEqual([
      expect.objectContaining({ hostname: "tracker.example" }),
    ]);
  });

  it("resolves relative ping endpoints as declarative posts", () => {
    const surface = markupUrlSurface('<a href="/next" ping="/collect">Next</a>');
    expect(surface.posted).toEqual([
      expect.objectContaining({
        url: "https://njpbs.org/collect",
        origin: "https://njpbs.org",
      }),
    ]);
  });

  it("retains the full origin, including a non-default port", () => {
    expect(parseUrlReference("https://njpbs.org:8443/collect.js")).toMatchObject({
      origin: "https://njpbs.org:8443",
      hostname: "njpbs.org",
    });
  });
});

describe("Kids COPPA resource traversal", () => {
  it("resolves relative scripts and styles from the kids page", () => {
    const refs = htmlResourceReferences(
      '<script src="./kids-extra.js"></script><link rel="stylesheet" href="../styles/kids.css">',
      KIDS_PAGE_URL,
    );
    expect(refs).toHaveLength(2);
    expect(resolveResourceReference("/tmp/dist", refs[0])).toMatchObject({
      url: "https://njpbs.org/kids/kids-extra.js",
      file: "/tmp/dist/kids/kids-extra.js",
      external: false,
      error: null,
    });
    expect(resolveResourceReference("/tmp/dist", refs[1])).toMatchObject({
      url: "https://njpbs.org/styles/kids.css",
      file: "/tmp/dist/styles/kids.css",
      external: false,
      error: null,
    });
  });

  it("finds nested stylesheet imports and inline style units", () => {
    expect(
      cssImportReferences(
        '@import "./more.css"; @import url(https://tracker.example/x.css);',
        "https://njpbs.org/kids/base.css",
      ),
    ).toEqual([
      {
        kind: "style",
        ref: "./more.css",
        baseUrl: "https://njpbs.org/kids/base.css",
      },
      {
        kind: "style",
        ref: "https://tracker.example/x.css",
        baseUrl: "https://njpbs.org/kids/base.css",
      },
    ]);
    const units = styleUnits({
      name: "dist/kids/index.html",
      kind: "html",
      url: KIDS_PAGE_URL,
      text: '<style>/* https://comment.example */ .hero{background:url("https://tracker.example/pixel")}</style>',
    });
    expect(units).toHaveLength(1);
    expect(cssUrlReferences(units[0].text, units[0].url)).toEqual([
      expect.objectContaining({ hostname: "tracker.example", error: null }),
    ]);
  });


  it("ignores CSS imports in comments and ordinary string values", () => {
    expect(
      cssImportReferences(
        String.raw`/* @import "retired.css"; */ .label{content:'@import "label.css"'} @import "active.css";`,
        "https://njpbs.org/kids/base.css",
      ),
    ).toEqual([
      {
        kind: "style",
        ref: "active.css",
        baseUrl: "https://njpbs.org/kids/base.css",
      },
    ]);
  });

  it("decodes CSS escapes and string-form image-set requests", () => {
    const references = cssUrlReferences(
      String.raw`.hero { background-image: url(https\3a //tracker.example/pixel); }
        .tile { background-image: image-set("https://images.example/one.png" 1x, url("/two.png") 2x); }`,
      KIDS_PAGE_URL,
    );
    expect(references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hostname: "tracker.example" }),
        expect.objectContaining({ hostname: "images.example" }),
        expect.objectContaining({ url: "https://njpbs.org/two.png" }),
      ]),
    );
  });

  it("finds static, re-exported, and dynamic module dependencies", () => {
    const dependencies = analyzeModuleDependencies(`
      import "./first.js";
      export { value } from "./second.js";
      const suffix = "third.js";
      import(\`./${"${suffix}"}\`);
      import(runtimePath);
    `);
    expect(dependencies.specifiers).toEqual([
      "./first.js",
      "./second.js",
      "./third.js",
    ]);
    expect(dependencies.unresolved).toEqual([
      expect.stringContaining("import(runtimePath)"),
    ]);
  });
});

describe("Kids COPPA executable-code analysis", () => {
  it("analyzes inline event handlers as executable code", () => {
    const units = executableUnits({
      name: "dist/kids/index.html",
      kind: "html",
      url: KIDS_PAGE_URL,
      text: '<button onclick="localStorage.setItem(\'deviceId\', visitorId)">Open</button>',
    });
    expect(units).toHaveLength(1);
    expect(
      storagePolicyViolations(
        analyzeClientCode(units[0].text).storageAccesses,
        storagePolicy,
      ),
    ).toEqual([
      expect.stringContaining('unreviewed storage key "deviceId"'),
    ]);
  });

  it("detects bracketed APIs and storage aliases", () => {
    const analysis = analyzeClientCode(`
      const store = window.localStorage;
      store.setItem("deviceId", visitorId);
      document["cookie"] = "id=1";
      navigator["sendBeacon"]("/collect", payload);
      window["sessionStorage"].setItem("x", "y");
      indexedDB.open("visitors");
    `);
    expect(analysis.forbiddenApis).toEqual([
      "document.cookie",
      "indexedDB",
      "sendBeacon",
      "sessionStorage",
    ]);
    expect(
      storagePolicyViolations(analysis.storageAccesses, storagePolicy),
    ).toEqual([
      expect.stringContaining('unreviewed storage key "deviceId"'),
    ]);
  });

  it("allows only the reviewed reduce-motion key and its finite values", () => {
    const safe = analyzeClientCode(`
      const KEY = "njpbs-motion";
      localStorage.setItem(KEY, reduced ? "off" : "on");
      localStorage.getItem(KEY);
    `);
    expect(storagePolicyViolations(safe.storageAccesses, storagePolicy)).toEqual(
      [],
    );

    const safeWithUnrelatedBinding = analyzeClientCode(`
      {
        const KEY = "unrelated-component-key";
        console.log(KEY);
      }
      {
        const KEY = "njpbs-motion";
        localStorage.setItem(KEY, reduced ? "off" : "on");
      }
    `);
    expect(
      storagePolicyViolations(
        safeWithUnrelatedBinding.storageAccesses,
        storagePolicy,
      ),
    ).toEqual([]);

    const unsafeValue = analyzeClientCode(
      'localStorage.setItem("njpbs-motion", visitorId)',
    );
    expect(
      storagePolicyViolations(unsafeValue.storageAccesses, storagePolicy),
    ).toEqual([
      expect.stringContaining('unresolved value for "njpbs-motion"'),
    ]);
  });

  it("detects same-origin write requests and unresolved destinations", () => {
    const analysis = analyzeClientCode(`
      const options = { method: "POST", body: payload };
      fetch("/api/report", options);
      const xhr = new XMLHttpRequest();
      xhr.open("PATCH", endpoint);
      fetch("/read-only", { method: "GET" });
    `);
    expect(analysis.networkWrites).toEqual([
      expect.objectContaining({
        api: "fetch",
        methods: ["POST"],
        targets: ["/api/report"],
      }),
      expect.objectContaining({
        api: "XMLHttpRequest",
        methods: ["PATCH"],
        targets: null,
      }),
    ]);
  });


  it("records localStorage property reads for key-policy validation", () => {
    const unsafe = analyzeClientCode(
      'const id = localStorage.deviceId; const motion = localStorage["njpbs-motion"];',
    );
    expect(storagePolicyViolations(unsafe.storageAccesses, storagePolicy)).toEqual([
      expect.stringContaining('unreviewed storage key "deviceId"'),
    ]);
  });

  it("follows aliases of document.cookie and navigator.sendBeacon", () => {
    const analysis = analyzeClientCode(`
      const doc = document;
      doc.cookie = "id=1";
      const nav = navigator;
      const beacon = nav.sendBeacon.bind(nav);
      beacon("/collect", payload);
    `);
    expect(analysis.forbiddenApis).toEqual([
      "document.cookie",
      "sendBeacon",
    ]);
  });

  it("invalidates reassigned bindings before approving storage keys", () => {
    const analysis = analyzeClientCode(`
      let key = "njpbs-motion";
      key = "deviceId";
      localStorage.setItem(key, "on");
    `);
    expect(storagePolicyViolations(analysis.storageAccesses, storagePolicy)).toEqual([
      expect.stringContaining("unresolved storage key"),
    ]);
  });

  it("treats DELETE, shorthand methods, spreads, and mutated options as writes", () => {
    const analysis = analyzeClientCode(`
      fetch("/delete", { method: "DELETE" });
      const method = "POST";
      fetch("/shorthand", { method });
      const postOptions = { method: "PATCH" };
      fetch("/spread", { ...postOptions });
      const changed = {};
      changed.method = "PUT";
      fetch("/changed", changed);
      fetch("/read", { method: "GET" });
    `);
    expect(analysis.networkWrites).toEqual([
      expect.objectContaining({ methods: ["DELETE"], targets: ["/delete"] }),
      expect.objectContaining({ methods: ["POST"], targets: ["/shorthand"] }),
      expect.objectContaining({ methods: ["PATCH"], targets: ["/spread"] }),
      expect.objectContaining({ methods: null, targets: ["/changed"] }),
    ]);
  });

  it("fails closed when a fetch spread can hide a method", () => {
    const analysis = analyzeClientCode(
      'fetch("/collect", { ...runtimeOptions, headers: {} });',
    );
    expect(analysis.networkWrites).toEqual([
      expect.objectContaining({ methods: null, targets: ["/collect"] }),
    ]);
  });
});
