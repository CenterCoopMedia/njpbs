# Public static-page fixtures

These responses were read directly from public `https://njpbs.org` on October 25,
2026, about 2:49 PM EDT, without credentials or JavaScript. Each request returned
200. The files preserve the page structure used by the network-boundary tests.
Newsletter subscription identifiers are replaced with an example URL:

- `contact.html`: <https://njpbs.org/contact/>, HTML.
- `robots.txt`: <https://njpbs.org/robots.txt>, plain text, 68 bytes.
- `sitemap-index.xml`: <https://njpbs.org/sitemap-index.xml>, XML, 180 bytes.
- `sitemap-0.xml`: <https://njpbs.org/sitemap-0.xml>, XML, 6,796 bytes.

Contact declares its own apex canonical URL and `noindex, nofollow`. Its heading
and opening paragraph in the original HTML provide this Markdown sample:

```markdown
# Contact NJ PBS

Email or call NJ PBS for viewer, member, Passport, donation, and site questions.
```

The observed links below describe anchors on Contact. No destination was fetched.
All 17 same-origin links carry the page's nofollow diagnostic. Nineteen excluded
anchors include external, mailto and tel destinations, with repeated links
counted separately. The sitemap inventory is a separate source and excludes
Contact.

```text
https://njpbs.org/contact/ [nofollow]
  /
  /about/
  /accessibility/
  /closed-captioning/
  /contact/
  /faq/
  /in-the-news/
  /kids/
  /live/
  /meeting-notices/
  /posts/
  /privacy/
  /public-file/
  /schedule/
  /search/
  /staff/
  /support/
```

These fixtures exercise local extraction and mocked network boundaries. They do
not establish acceptance of an installed Worker.
