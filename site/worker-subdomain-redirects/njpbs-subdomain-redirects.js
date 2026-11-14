var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// njpbs-subdomain-redirects.js
var STATUS_CODE = 302;
var HOST_REDIRECTS = {
  "watch.njpbs.org": "/watch/",
  "video.njpbs.org": "/video/",
  "live.njpbs.org": "/live/",
  "give.njpbs.org": "/give/",
  "donate.njpbs.org": "/give/",
  "passport.njpbs.org": "/passport/",
  "schedule.njpbs.org": "/schedule/",
  "kids.njpbs.org": "/kids/",
  "support.njpbs.org": "/support/"
};
function destinationPath(hostname, pathname) {
  if (hostname === "watch.njpbs.org" && pathname.startsWith("/livestream")) {
    return "/live/";
  }
  return HOST_REDIRECTS[hostname] || "/watch/";
}
__name(destinationPath, "destinationPath");
var njpbs_subdomain_redirects_default = {
  async fetch(request) {
    const url = new URL(request.url);
    const target = new URL(`https://njpbs.org${destinationPath(url.hostname.toLowerCase(), url.pathname)}`);
    target.search = url.search;
    return Response.redirect(target.toString(), STATUS_CODE);
  }
};
export {
  njpbs_subdomain_redirects_default as default
};
//# sourceMappingURL=njpbs-subdomain-redirects.js.map
