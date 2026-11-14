// Retire newnjpbs.org: single-hop 301 to njpbs.org, path and query preserved.
// njpbs.org is the canonical flagship; newnjpbs.org exists only to redirect. Issue #219.
export default {
  fetch(request) {
    const url = new URL(request.url);
    return Response.redirect("https://njpbs.org" + url.pathname + url.search, 301);
  },
};
