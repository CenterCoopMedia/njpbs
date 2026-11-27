/* global window */
const GRANT = "v1:granted";
const DENY = "v1:denied";
const MEDIA_PARAMETER = "spotlight_newsletter_media";
// Tabs running the earlier newsletter-only version listen on this name.
const CHANNEL = "spotlight-newsletter-consent";
const COOKIES = { analytics: "spotlight-analytics-consent", newsletter: "spotlight-newsletter-consent" };
// Carries a save failure across the reload that stops a withdrawn tool; the address works without storage.
const NOTICE_PARAMETER = "spotlight_privacy_notice";
const FAILED = {
  kept: "Your browser prevented saving this change. Your earlier permission is still active. Clear this site's cookies or block these tools in your browser to withdraw it.",
  off: "We could not save your choice. These tools remain off.",
};
const UNAVAILABLE = { analytics: "Analytics is unavailable.", newsletter: "Newsletter tools are unavailable." };

export function mountNewsletterConsent(win) {
  const doc = win.document;
  const root = doc.getElementById("spotlight-newsletter-choice");
  const opener = doc.querySelector("[data-newsletter-open]");
  const bar = doc.querySelector("[data-privacy-bar]");
  if (!root || !opener || !bar || doc.querySelectorAll("#spotlight-newsletter-choice").length !== 1 || root.dataset.mounted) return;
  const categories = [...root.querySelectorAll("[data-category]")].map(node => ({
    name: node.dataset.category, node, cookie: COOKIES[node.dataset.category],
    status: node.querySelector("[data-status]"), loaded: false, existing: false, failure: "",
  }));
  if (categories.length !== 2 || categories.some(category => !category.cookie)) return;
  root.dataset.mounted = "true";
  let ending = false;
  const address = new win.URL(win.location.href);
  const notice = (address.searchParams.get(NOTICE_PARAMETER) || "").split(",");
  if (address.searchParams.has(NOTICE_PARAMETER)) {
    address.searchParams.delete(NOTICE_PARAMETER);
    win.history.replaceState(null, "", address.href);
  }
  const mediaKey = `spotlight-newsletter-media:${win.location.pathname}${win.location.search}`;
  let mediaBlocked = new win.URL(win.location.href).searchParams.has(MEDIA_PARAMETER);
  try { mediaBlocked ||= win.sessionStorage.getItem(mediaKey) === "blocked"; } catch { /* A page-address marker is the storage fallback. */ }
  let channel;
  try { channel = new win.BroadcastChannel(CHANNEL); } catch { /* Focus also reconciles the saved choice. */ }

  const gpc = () => win.navigator.globalPrivacyControl === true;
  const anyLoaded = () => categories.some(category => category.loaded);
  // Reserve space under the fixed bar so it cannot cover focused page content, even at maximum scroll.
  function reserveSpace() {
    const space = bar.hidden ? "" : `${bar.offsetHeight}px`;
    doc.documentElement.style.paddingBottom = space;
    doc.documentElement.style.scrollPaddingBottom = space;
  }
  function setBarHidden(value) {
    bar.hidden = value;
    reserveSpace();
  }
  const undecided = () => categories.some(category => ![GRANT, DENY].includes(decision(category.cookie)));

  function decision(cookie) {
    try {
      const matches = doc.cookie.split(";").map(part => part.trim())
        .filter(part => part.startsWith(`${cookie}=`));
      return matches.length === 1 ? decodeURIComponent(matches[0].slice(cookie.length + 1)) : "";
    } catch { return ""; }
  }

  function hasMedia() {
    return !!doc.querySelector('video, object, embed, [data-child-directed], [data-video-id], [data-remodal-target="modalinteractive"], iframe[src*="youtube.com/embed"], iframe[src*="youtube-nocookie.com/embed"], iframe[src*="player.vimeo.com"], iframe[src*="player.pbs.org"], iframe[src*="video.pbs.org"]');
  }

  function allowed(category) {
    return !mediaBlocked && decision(category.cookie) === GRANT && !gpc() && !hasMedia();
  }

  // Removing scripts cannot stop executed code; the caller reloads the document.
  function stopTools() {
    for (const script of doc.querySelectorAll("script[data-spotlight-newsletter-vendor]")) {
      script.onload = null;
      script.remove();
    }
    const analytics = categories.find(category => category.name === "analytics");
    if (analytics.loaded) win[`ga-disable-${analytics.node.dataset.measurementId}`] = true;
    if (win.vgo?.q) win.vgo.q.length = 0;
    if (win.wisepops?.q) win.wisepops.q.length = 0;
  }

  function endVendorDocument() {
    if (ending) return;
    ending = true;
    const failures = categories.filter(category => category.failure).map(category => `${category.name}.${category.failure}`);
    if (failures.length) {
      const address = new win.URL(win.location.href);
      address.searchParams.set(NOTICE_PARAMETER, failures.join(","));
      win.history.replaceState(null, "", address.href);
    }
    stopTools();
    win.location.reload();
  }

  function excludeMedia() {
    mediaBlocked = true;
    // Stop analytics before an address change so it cannot count a second page view.
    if (anyLoaded()) stopTools();
    try {
      win.sessionStorage.setItem(mediaKey, "blocked");
      if (win.sessionStorage.getItem(mediaKey) !== "blocked") throw new Error("Exclusion was not saved");
    } catch {
      const address = new win.URL(win.location.href);
      address.searchParams.set(MEDIA_PARAMETER, "off");
      win.history.replaceState(null, "", address.href);
    }
    if (anyLoaded()) endVendorDocument();
    else display();
  }

  function vendorScript(src) {
    const script = doc.createElement("script");
    script.src = src;
    script.async = true;
    script.referrerPolicy = "no-referrer";
    script.dataset.spotlightNewsletterVendor = "";
    return script;
  }

  function loadAnalytics(category) {
    const id = category.node.dataset.measurementId;
    win.dataLayer = [];
    win.gtag = function gtag() { win.dataLayer.push(arguments); };
    win.gtag("consent", "default", { analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });
    win.gtag("consent", "update", { analytics_storage: "granted" });
    win.gtag("js", new Date());
    win.gtag("config", id, { allow_google_signals: false, allow_ad_personalization_signals: false, send_page_view: true });
    doc.head.append(vendorScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`));
  }

  function loadNewsletter(category) {
    const vgo = (...args) => vgo.q.push(args);
    vgo.q = [];
    vgo.l = Date.now();
    win.visitorGlobalObjectAlias = "vgo";
    win.vgo = vgo;
    vgo("setAccount", category.node.dataset.account);
    vgo("setTrackByDefault", false);
    const ac = vendorScript("https://diffuser-cdn.app-us1.com/diffuser/diffuser.js");
    ac.onload = () => {
      ac.onload = null;
      if (ac.isConnected && allowed(category)) win.vgo("process", "allowTracking");
    };
    const wisepops = (...args) => wisepops.q.push(args);
    wisepops.q = [];
    wisepops.l = Date.now();
    win.wisepops = wisepops;
    wisepops("options", { defaultConsent: "denied" });
    wisepops("consent", "granted");
    const wp = vendorScript(`https://wisepops.net/h/${category.node.dataset.property}/loader.js?v=3`);
    wp.dataset.cfasync = "false";
    doc.body.append(ac, wp);
  }

  function load(category) {
    if (category.loaded || category.existing || !allowed(category)) return;
    const present = category.name === "analytics" ? win.gtag || win.dataLayer : win.vgo || win.wisepops;
    if (present) {
      category.existing = true;
      category.status.textContent = `${UNAVAILABLE[category.name]} Your privacy choice is saved.`;
      root.hidden = false;
      return;
    }
    category.loaded = true;
    if (category.name === "analytics") loadAnalytics(category);
    else loadNewsletter(category);
  }

  function display() {
    const off = gpc() || mediaBlocked;
    let moveFocus = false;
    for (const category of categories) {
      if (off && category.node.contains(doc.activeElement)) moveFocus = true;
      category.node.hidden = off;
      const saved = decision(category.cookie);
      const current = category.node.querySelector("[data-current]");
      const text = `Current choice: ${saved === GRANT ? "allowed" : saved === DENY ? "not allowed" : "not chosen"}.`;
      // An unchanged write would wake the mutation observer again.
      if (current.textContent !== text) current.textContent = text;
    }
    // Another tab can complete the choices while this bar is open.
    if ((off || !undecided()) && !bar.hidden) setBarHidden(true);
    root.querySelector("[data-newsletter-gpc]").hidden = !gpc();
    root.querySelector("[data-newsletter-media]").hidden = !mediaBlocked;
    if (!root.hidden && moveFocus) root.querySelector("[data-newsletter-close]").focus();
  }

  function reconcile() {
    if (!mediaBlocked && hasMedia()) {
      excludeMedia();
      return;
    }
    display();
    if (categories.some(category => category.loaded && !allowed(category))) {
      endVendorDocument();
      return;
    }
    categories.forEach(load);
  }

  function save(category, value) {
    try {
      doc.cookie = `${category.cookie}=${encodeURIComponent(value)}; Path=/; Max-Age=15552000; SameSite=Lax; Secure`;
      if (decision(category.cookie) !== value) throw new Error("Choice was not saved");
    } catch {
      category.failure = category.loaded ? "kept" : "off";
      category.status.textContent = FAILED[category.failure];
      return false;
    }
    category.failure = "";
    category.status.textContent = "";
    return true;
  }

  function openPanel() {
    setBarHidden(true);
    display();
    root.hidden = false;
    root.querySelector(gpc() || mediaBlocked ? "[data-newsletter-close]" : "[data-deny]").focus();
  }

  function choose(choices) {
    // Save every choice before reconciling so a withdrawal reload sees them all.
    const saved = choices.map(([category, value]) => save(category, value)).every(Boolean);
    channel?.postMessage("changed");
    if (!saved) openPanel();
    else if (!undecided()) {
      setBarHidden(true);
      root.hidden = true;
      opener.focus();
    }
    reconcile();
  }

  opener.addEventListener("click", openPanel);
  bar.querySelector("[data-choices]").addEventListener("click", openPanel);
  bar.querySelector("[data-allow-all]").addEventListener("click", () => choose(categories.map(category => [category, GRANT])));
  bar.querySelector("[data-allow-none]").addEventListener("click", () => choose(categories.map(category => [category, DENY])));
  for (const category of categories) {
    category.node.querySelector("[data-allow]").addEventListener("click", () => choose([[category, GRANT]]));
    category.node.querySelector("[data-deny]").addEventListener("click", () => choose([[category, DENY]]));
  }
  root.querySelector("[data-newsletter-close]").addEventListener("click", () => {
    root.hidden = true;
    opener.focus();
  });
  if (channel) channel.onmessage = reconcile;
  if (win.ResizeObserver) new win.ResizeObserver(reserveSpace).observe(bar);
  win.addEventListener("focus", reconcile);
  win.addEventListener("pageshow", reconcile);
  doc.addEventListener("visibilitychange", reconcile);
  new win.MutationObserver(reconcile).observe(doc.body, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ["src", "data-video-id", "data-child-directed", "data-remodal-target"],
  });
  doc.addEventListener("focusin", event => {
    if (!root.hidden && !root.contains(event.target)) root.hidden = true;
  });
  for (const category of categories) {
    const kind = Object.keys(FAILED).find(key => notice.includes(`${category.name}.${key}`));
    category.status.textContent = kind ? FAILED[kind] : "";
  }
  display();
  opener.hidden = false;
  root.hidden = !categories.some(category => category.status.textContent);
  setBarHidden(!root.hidden || mediaBlocked || gpc() || !undecided());
  // Focus the restored notice so keyboard and screen-reader users meet it before the panel can close.
  const restored = categories.find(category => category.status.textContent);
  if (restored) {
    restored.status.tabIndex = -1;
    restored.status.focus();
  }
  reconcile();
}

if (typeof window !== "undefined") mountNewsletterConsent(window);
