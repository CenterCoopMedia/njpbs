/* Shared by the shell and the frozen reader; no cross-origin navigation. */
(() => {
  const origin = window.location.origin;
  const validHash = (value) => typeof value === "string"
    && (value === "" || /^#town=\d{4}(?:&event=[A-Za-z0-9_-]{1,64})?$/.test(value));
  const frame = document.querySelector("[data-name-atlas-frame]");
  if (frame) {
    const standalone = document.querySelector("[data-name-atlas-standalone]");
    const readerUrl = (hash) => "/atlas/reader/" + (validHash(hash) ? hash : "");
    const updateLink = () => { if (standalone) standalone.href = readerUrl(window.location.hash); };
    const navigateReader = () => {
      updateLink();
      if (validHash(window.location.hash)) {
        frame.contentWindow?.postMessage({ type: "njpbs-atlas-navigate", hash: window.location.hash }, origin);
      }
    };
    window.addEventListener("message", (event) => {
      if (event.origin !== origin || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (!data || data.type !== "njpbs-atlas-route" || !validHash(data.hash)
        || typeof data.replace !== "boolean" || data.hash === window.location.hash) return;
      const url = window.location.pathname + window.location.search + data.hash;
      window.history[data.replace ? "replaceState" : "pushState"](window.history.state, "", url);
      updateLink();
    });
    window.addEventListener("popstate", navigateReader);
    window.addEventListener("hashchange", navigateReader);
    // Set the initial hash before loading: the default town cannot win a race.
    frame.src = readerUrl(window.location.hash);
    updateLink();
    return;
  }

  if (!document.documentElement.hasAttribute("data-name-atlas-reader") || window.parent === window) return;
  let applyingParentRoute = false;
  const nativeReplace = window.history.replaceState.bind(window.history);
  const announce = (replace) => {
    if (!applyingParentRoute && validHash(window.location.hash)) {
      window.parent.postMessage({ type: "njpbs-atlas-route", hash: window.location.hash, replace }, origin);
    }
  };
  for (const method of ["pushState", "replaceState"]) {
    window.history[method] = function (...args) {
      // Frames share session history. Only the parent adds an entry; the child
      // mirrors it, otherwise every selection creates two Back-button stops.
      const result = nativeReplace(...args);
      announce(method === "replaceState");
      return result;
    };
  }
  window.addEventListener("popstate", () => announce(true));
  window.addEventListener("hashchange", () => announce(true));
  window.addEventListener("message", (event) => {
    if (event.origin !== origin || event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.type !== "njpbs-atlas-navigate" || !validHash(data.hash)
      || data.hash === window.location.hash) return;
    applyingParentRoute = true;
    try {
      nativeReplace(window.history.state, "", window.location.pathname + window.location.search + data.hash);
      window.dispatchEvent(new PopStateEvent("popstate"));
    } finally {
      applyingParentRoute = false;
    }
  });
})();
