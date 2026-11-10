# Theme chooser archive

This folder contains four reference themes: Garden State public (`gs`), Signal
(`sig`), Garden State poster (`post`), and Garden signal glasshouse (`glasshouse`).
The files are outside the active website build.

The layout follows website-relative paths:

- `src/pages/index.astro` contains the chooser page.
- `src/components/previews/` contains each theme's page components.
- `src/lib/chooser-kits.ts` contains the theme data.
- `public/kits/` contains each theme's styles, scripts, tokens, and asset notes.

Use `RESTORE.md` to evaluate a selected theme in a temporary website checkout.
Add current chooser-data, contrast-token, and interaction tests before activation.
Historical test files and the retired tablist helper are not included. If tabs are
needed, implement and test them against the current component contract.

Archived imports refer to the website package. They are not expected to build or
typecheck in this directory. Preserve the active homepage while evaluating an
experiment; deployment requires separate approval.
