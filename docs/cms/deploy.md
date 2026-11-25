# CMS deploy

`node scripts/deploy-cms.mjs <development|production>` deploys the CMS of the checked-out commit. Run it in a
fresh clone, because it renders the target's names into tracked files. Name steps after the target to run only those.

Every step runs, also after a failed one. Each prints its name and seconds. The run ends with the list of
failed steps and the provider's error, and exits 1 when the list is not empty.

| Step | What it does |
| --- | --- |
| install | `npm ci` at the root and in `site` |
| render | Writes the target's origins and resource names into the source |
| functions-build | Builds the Functions contracts and writes the runtime parameters |
| seed | Adds missing page images, media categories and desks |
| firebase | Rules, indexes and Functions in one `firebase deploy`. Unchanged Functions are skipped. A repeat after the provider's per-minute limit deploys only what is left |
| event-grants | Lets a new event trigger's identity call its Function |
| cms-api | Deploys the CMS API Worker |
| renderer | Deploys the preview renderer when its source changed, and waits until it reports ready |
| studio | Builds and stores the Studio connector of this commit |
| admin-build, admin-deploy | Builds the Admin and uploads it to Pages |
| admin-shell | Production: opens the Admin sign-in page through Access |
| smoke | Function boundaries, then one signed-in private preview in Chrome |
| notes | Prints missing event receivers and secret accessors, and an App Check key that differs. Never fails the run |

Inputs are environment variables: `CMS_DEPLOYMENT_VARIABLES_JSON` (the GitHub variables as one object),
`FIREBASE_SERVICE_ACCOUNT`, `CLOUDFLARE_API_TOKEN`, `CMS_EDGE_ORIGIN_SECRET`, `CMS_PREVIEW_R2_CREDENTIAL`,
`CMS_PREVIEW_SMOKE_CREDENTIAL`, `CMS_ADMIN_ACCESS_API_TOKEN` (production) and, for development, the
`CLOUDFLARE_DEV_*`, `CMS_DEV_PREVIEW_*` and `CMS_DEV_ACCESS_*` names. The renderer step needs Docker.
