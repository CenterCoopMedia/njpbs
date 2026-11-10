/** Hosting adapters only. Keep the reviewed research, styling and fonts intact. */
export function renderNameAtlasReader(snapshot: string, bridge: string): string {
  const copyBase = "const url=new URL(window.location.href);url.hash=routeHash(code);";
  const sourceLink = "a.rel='noopener noreferrer';return a;";
  if (!snapshot.includes('<html lang="en">') || !snapshot.includes("</head>")
    || snapshot.split(copyBase).length !== 2 || snapshot.split(sourceLink).length !== 2) {
    throw new Error("Atlas snapshot changed: review its hosting adapters before updating");
  }
  return snapshot
    .replace('<html lang="en">', '<html lang="en" data-name-atlas-reader data-pagefind-ignore="all">')
    .replace("</head>", `<meta name="robots" content="noindex, nofollow, noarchive">\n<script>${bridge}</script>\n</head>`)
    .replace(copyBase, "const url=new URL('/atlas/',window.location.origin);url.hash=routeHash(code);")
    .replace(sourceLink, "a.rel='noopener noreferrer';a.append(el('span',' (opens in new tab)','sr-only'));return a;")
    .replace(/<a\b[^>]*\btarget=["']_blank["'][^>]*>[\s\S]*?<\/a>/g, (anchor) =>
      anchor.includes("(opens in new tab)") ? anchor
        : anchor.replace("</a>", '<span class="sr-only"> (opens in new tab)</span></a>'));
}
