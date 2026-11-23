const COOKIE = "spotlight-newsletter-consent";
const GRANT = "v1:granted";
const DENY = "v1:denied";

export function mountNewsletterConsent(win) {
  const doc = win.document;
  const root = doc.getElementById("spotlight-newsletter-choice");
  const opener = doc.querySelector("[data-newsletter-open]");
  if (!root || !opener || doc.querySelectorAll("#spotlight-newsletter-choice").length !== 1 || root.dataset.mounted) return;
  root.dataset.mounted = "true";
  const status = root.querySelector("[data-newsletter-status]");
  let loaded = false;
  let ending = false;
  let channel;
  try { channel = new win.BroadcastChannel(COOKIE); } catch { /* Focus also reconciles the saved choice. */ }

  function decision() {
    try {
      const matches = doc.cookie.split(";").map(part => part.trim())
        .filter(part => part.startsWith(`${COOKIE}=`));
      return matches.length === 1 ? decodeURIComponent(matches[0].slice(COOKIE.length + 1)) : "";
    } catch { return ""; }
  }

  function hasMedia() {
    return !!doc.querySelector('video, object, embed, [data-child-directed], [data-video-id], [data-remodal-target="modalinteractive"], iframe[src*="youtube.com/embed"], iframe[src*="youtube-nocookie.com/embed"], iframe[src*="player.vimeo.com"], iframe[src*="player.pbs.org"], iframe[src*="video.pbs.org"]');
  }

  function allowed() {
    return decision() === GRANT && win.navigator.globalPrivacyControl !== true && !hasMedia();
  }

  function endVendorDocument() {
    if (ending) return;
    ending = true;
    for (const script of doc.querySelectorAll("script[data-spotlight-newsletter-vendor]")) {
      script.onload = null;
      script.remove();
    }
    if (win.vgo?.q) win.vgo.q.length = 0;
    if (win.wisepops?.q) win.wisepops.q.length = 0;
    win.location.reload();
  }

  function vendorScript(src) {
    const script = doc.createElement("script");
    script.src = src;
    script.async = true;
    script.referrerPolicy = "no-referrer";
    script.dataset.spotlightNewsletterVendor = "";
    return script;
  }

  function load() {
    if (loaded || !allowed()) return;
    if (win.vgo || win.wisepops) {
      status.textContent = "Newsletter tools are unavailable. Your privacy choice is saved.";
      root.hidden = false;
      return;
    }
    loaded = true;
    const vgo = (...args) => vgo.q.push(args);
    vgo.q = [];
    vgo.l = Date.now();
    win.visitorGlobalObjectAlias = "vgo";
    win.vgo = vgo;
    vgo("setAccount", root.dataset.account);
    vgo("setTrackByDefault", false);
    const ac = vendorScript("https://diffuser-cdn.app-us1.com/diffuser/diffuser.js");
    ac.onload = () => {
      ac.onload = null;
      if (ac.isConnected && allowed()) win.vgo("process", "allowTracking");
    };
    const wisepops = (...args) => wisepops.q.push(args);
    wisepops.q = [];
    wisepops.l = Date.now();
    win.wisepops = wisepops;
    wisepops("options", { defaultConsent: "denied" });
    wisepops("consent", "granted");
    const wp = vendorScript(`https://wisepops.net/h/${root.dataset.property}/loader.js?v=3`);
    wp.dataset.cfasync = "false";
    doc.body.append(ac, wp);
  }

  function display() {
    const gpc = win.navigator.globalPrivacyControl === true;
    for (const node of root.querySelectorAll("[data-newsletter-choice]")) node.hidden = gpc;
    root.querySelector("[data-newsletter-gpc]").hidden = !gpc;
    root.querySelector("[data-newsletter-close]").hidden = !gpc;
  }

  function reconcile() {
    display();
    if (loaded && !allowed()) {
      endVendorDocument();
      return;
    }
    load();
  }

  function choose(value) {
    try {
      doc.cookie = `${COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=15552000; SameSite=Lax; Secure`;
      if (decision() !== value) throw new Error("Choice was not saved");
    } catch {
      status.textContent = loaded
        ? "Your browser prevented saving this change. Your earlier permission is still active. Clear this site's cookies or block these tools in your browser to withdraw it."
        : "We could not save your choice. Newsletter tools remain off.";
      return;
    }
    channel?.postMessage("changed");
    root.hidden = true;
    opener.focus();
    reconcile();
  }

  opener.addEventListener("click", () => {
    display();
    root.hidden = false;
    root.querySelector(win.navigator.globalPrivacyControl === true
      ? "[data-newsletter-close]" : "[data-newsletter-deny]").focus();
  });
  root.querySelector("[data-newsletter-allow]").addEventListener("click", () => choose(GRANT));
  root.querySelector("[data-newsletter-deny]").addEventListener("click", () => choose(DENY));
  root.querySelector("[data-newsletter-close]").addEventListener("click", () => {
    root.hidden = true;
    opener.focus();
  });
  if (channel) channel.onmessage = reconcile;
  win.addEventListener("focus", reconcile);
  win.addEventListener("pageshow", reconcile);
  doc.addEventListener("visibilitychange", reconcile);
  doc.addEventListener("focusin", event => {
    if (!root.hidden && !root.contains(event.target)) root.hidden = true;
  });
  display();
  opener.hidden = false;
  root.hidden = win.navigator.globalPrivacyControl === true || [GRANT, DENY].includes(decision());
  load();
}

if (typeof window !== "undefined") mountNewsletterConsent(window);
