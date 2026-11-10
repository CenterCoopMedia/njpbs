# Boardwalk Premiere panel

Panel source version: **0.1.1**.

Sideloaded UXP client for the shared Boardwalk video library. Build and load the
panel locally to develop against emulators with synthetic accounts and media.
Verify native host behavior before distributing a release.

## Build and load

1. Use Node 22 and run `npm ci --prefix premiere-boardwalk-panel --ignore-scripts`.
2. For a release, supply `CMS_PRODUCTION_API_ORIGIN` and run `node scripts/render-development-config.mjs --production --root <disposable-checkout>` from the source tools. Run the following build inside that rendered checkout: `npm --prefix premiere-boardwalk-panel run build`. An unrendered release build refuses before emitting output.
   CI fixture builds use `npm --prefix premiere-boardwalk-panel run build -- --test`; they have a separate test identity and no source-revision evidence.
3. Open Premiere Pro 26.5 or later and UXP Developer Tool.
4. Add `premiere-boardwalk-panel/dist/manifest.json`, then load the panel.
5. Open Boardwalk under Window > UXP Plugins. Open a Premiere project.

For local emulator development, build with
`node premiere-boardwalk-panel/build.cjs --local` and load
`dist-local/manifest.json`. This has a separate plugin identity and uses
`demo-njpbs` Functions at port 5001 and local Admin at port 5173. Production
builds do not allow HTTP or localhost. Start the existing repository emulators
and Admin development server separately; use synthetic accounts and owned media.

For the station installer, build from the reviewed release commit with its verified deployment render, then
use **Package** in the UXP Developer Tool actions menu for `dist/manifest.json`.
Keep the independent distribution ID `org.njpbs.boardwalk.premiere`. Adobe supports
private distribution of the resulting `.ccx` installer through Creative Cloud
Desktop; a Marketplace listing is not required. Verify installation of that
package, not only loading the development folder. See Adobe's
[packaging guide](https://developer.adobe.com/premiere-pro/uxp/plugins/distribution/package/).
The build receipt records the source commit only for a clean checkout or its verified deterministic render. A null
revision identifies an uncommitted, archive or test build and is not release evidence.

Native builds omit the browser preview favicon because UXP parses link elements
as stylesheets. The manifest supplies the native plugin icons.

## Interface

The build copies the official NJ PBS logo and canonical dark design tokens from
Admin and the site. Thumbnail selection matches Boardwalk; details retain the
selected poster. Header, tabs, and batch controls stay in place, and Back restores
the library position. Minimum size is 280 by 400 pixels. The library uses one,
two, or three columns as the panel widens. Text fields have a black background
and white entered text. The native host controls the in-field placeholder color.
Library searches, transfers, browser approval, and report submission show an
animated three-dot activity indicator. Its reserved space keeps the layout stable.

## Behavior

- Browse paginated metadata and poster thumbnails. Opening a card or selecting
  a batch does not fetch video bytes. Explicit Download and import actions
  fetch only the chosen originals or generated exports, one file at a time.
  Marker details load only after opening a card. Their indicator does not block
  importing the selected video; marker actions wait for the detail response.
- Name-prefix search runs 250 milliseconds after typing stops. Late responses
  cannot replace a newer query. Filtering waits for an active import to finish
  and preserves its completion message.
- Browser approval connects the staff account for 30 days. UXP secure storage
  retains the opaque session across restarts. Server checks current permissions
  on each operation. Sign-out, revocation, or lost storage can end it earlier.
  **Connect Boardwalk** and **Open Boardwalk** open the approval page with the
  connection code filled in. Staff still select **Review connection**, compare
  the code with Premiere, and explicitly approve. The page removes the code
  from the address bar after reading it; invalid query codes are ignored.
  Older Functions fall back to the configured approval page, and older Admin
  builds leave the field empty. Use **Copy code**, then paste into **Connection
  code**, or select the read-only code field and copy it. The hyphen is optional.
  Copy success or failure appears below the code in a polite live region.
- Choose original or ProRes. Full originals download directly. ProRes uses the
  existing paid export. Original ranges use the separate stream-copy worker
  and require its disabled-by-default rollout flag.
- Choose a cache folder once. Downloads stream to disk before Premiere imports
  them into the active Project panel bin. Editors place clips on a timeline.
  Transfers use UXP file URLs for the user-selected entries; raw Windows paths
  are not valid inputs to the host filesystem calls.
- Markers round-trip manually using a selected, tracked source clip. Save checks
  the Boardwalk asset version. Markers outside or crossing a downloaded range
  remain unchanged. Applying markers replaces local clip markers and uses
  Premiere undo history for markers and colors.
  Comment, chapter and segmentation markers are supported. WebLink markers are
  refused because Adobe's API cannot restore their URL and target. A clip with
  existing WebLink markers cannot have its markers replaced through the panel.
  It can still be linked as the source of a returned video, with marker inclusion
  disabled and the limitation shown beside the source.
- Return an exported file as a new asset. Link its tracked source and range;
  optionally include linked-clip markers only when export timing matches.
  Multipart uploads retain a resumable checkpoint and verify retained bytes.
- Cache clearing removes this account's tracked downloads in the chosen folder
  after an explicit checkbox. Those files become offline in projects using them.
  A file that Premiere still holds open is kept, and the panel names it. Close
  the projects that use it, or restart Premiere, then clear again.
- Settings includes **Report a problem** with an optional description. Reports
  include plugin, Premiere and UXP versions and the latest 40 operation results.
  Unexpected failures also queue automatic reports; cancellation, validation,
  expired sessions, rate limits and reporting failures do not trigger alerts.
  Manual reports show a confirmation and reference ID for support follow-up.
  Automatic reports capture unexpected failures without interrupting media work.
- Local diagnostics retain up to 100 structured events from the last 24 hours in
  the private plugin data folder, scoped to the connected account. They contain
  no video titles, filenames, paths, URLs, headers, credentials or raw errors.
  Pending reports keep their request UUID and payload across retries. A manual
  report awaiting a receipt shows **Retry report** and retains its description.
  A revoked session hides retained reports until that account reconnects.
  After a temporary startup outage, Refresh or Report a problem retries session
  validation and restores reporting without a panel reload.
  Logging and alert delivery failures never prevent a media operation.

Guide capture scripts write to `./guide-capture-output` by default. Set
`GUIDE_CAPTURE_OUTPUT` to choose another local folder, or pass the output-folder
argument to override it. Capture output is a local review artifact; guide builds
do not import it automatically. Review the generated images, then copy approved
files into the image directory configured by the consuming guide integration. A
successful capture alone does not refresh a packaged guide.

## Verification

`npm --prefix premiere-boardwalk-panel test` checks storage, transfer integrity,
marker range, diagnostic privacy and retry contracts. `npm --prefix premiere-boardwalk-panel run test:browser`
runs the real built UI with substituted platform/network boundaries and requires
the repository's Playwright install plus Chromium. It proves demand-only video
fetches, batch selection, search/import ordering, and connection controls at
260 and 400 pixels wide. It does not prove UXP host behavior.

The Copy code action uses
[`navigator.clipboard.setContent({"text/plain": code})`](https://developer.adobe.com/premiere-pro/uxp/resources/recipes/clipboard/)
and the manifest's `clipboard: "readAndWrite"` permission, as documented for
Premiere 25.6 or later with manifest 5 (this panel requires 26.5).
Version 0.1.1 still needs native Windows checks for clipboard copy/paste into
the real browser approval flow, read-only field selection, keyboard activation,
and narrow docking. Browser renders and clipboard substitutions do not establish
these behaviors. Packaging and Creative Cloud installation remain a separate step.

For native verification, use synthetic accounts and media with the local
emulators. Check docking, session restoration after plugin reload and a full
Premiere restart, original download/import integrity, marker changes, return
uploads, and manual reporting. Verify Windows and macOS behavior separately;
browser tests do not establish native networking or host integration.

With an active sequence, Premiere 26.5.2 on Windows can consume Space and Enter
as host shortcuts before the panel receives keydown. Pointer actions work;
button keyboard activation is not reliable in that host state. The panel does
not activate a second action from a keyup whose press Premiere already handled.
Browser keyboard checks do not establish native keyboard support.

Verify native host behavior and deployment approval before rollout.
