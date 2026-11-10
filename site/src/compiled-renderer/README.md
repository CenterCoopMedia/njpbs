# Compiled renderer source root

The private renderer configuration uses this source root to exclude build-time
content loaders and unrelated public/internal routes. Its adapter injects the
existing Home, Page, Post, Program, Event, Schedule and Staff route files directly. It does not
maintain copies of their templates or a second set of page wrappers.

Validated content reaches those routes through `Astro.locals.cmsRender`. The
ordinary static build continues to use its existing Astro content collections.

The middleware entry re-exports the shared HTML link boundary, so compiled public
renders and private previews use the same address policy as the static build.
