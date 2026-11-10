# Section enforcement proof (#845)

Multi-role evidence that section-scoped grants actually scope content, taken against the
Firebase emulator suite and the real Admin app rather than against fakes.

## What is here

| File | What it is |
|------|------------|
| `seed.mjs` | Seeds four people, a five-desk section registry, and content across two desks plus one unsectioned legacy record |
| `section-enforcement.mjs` | Signs in as each person in a real browser and records what they can see and do |
| `assertions.txt` | The transcript the run wrote: 26 assertions, 0 failed |
| `screenshots/` | Browser screenshots, deliberately not committed |

## How to reproduce

`admin-perf-baseline.json` is a privacy-reduced benchmark oracle containing
anonymous pre-optimization comparison data. Its measured timings and conditions
are retained; private capture time, build and review provenance are omitted.
It is not a recapturable receipt or evidence of a current build's performance.
Run the capture script to produce a new receipt when measuring a build.

The proof uses the declared workspace `@playwright/test` dependency and its
default headless Chromium. `PLAYWRIGHT_BROWSERS_PATH` may select an existing
browser cache; no global module installation or fixed executable is required.

```bash
npm run emulators:start          # from the repository root
node proof/seed.mjs              # in a second terminal
cd admin && npm run dev          # in a third terminal
node proof/section-enforcement.mjs
```

`admin/.env.local` needs the demo emulator values (`VITE_FIREBASE_PROJECT_ID=demo-njpbs`,
`VITE_USE_EMULATORS=true`, any non-empty API key). It is gitignored.

## The four people

| Person | Grant |
|--------|-------|
| Sam Super | top-level `super_admin` |
| Sky Sitewide | site-wide `editor` |
| Wren Watch | `editor` scoped to `watch` |
| Cory Contributor | `contributor` scoped to `watch` |

Each assertion is made with that person's own signed-in Firebase ID token, read from the
app's live auth instance, against the same authenticated function boundary the app calls.
Nothing is asserted against a fabricated principal.

## What the run proves

- A **site-wide** grant is unchanged: every record, in every desk and none.
- A **watch-scoped editor** reads, saves, and inspects the history of watch-desk records;
  is refused station-desk records and records carrying no desk; reads the `/watch/` page
  and is refused `/support/`, because a canonical page's desk is its server-owned public
  area; creates into `watch` and is refused a create into `station`.
- A **watch-scoped contributor** sees only their own watch-desk work. Their own draft in
  the station desk is absent: ownership does not punch through the scope.
- A record create that names **no desk** is refused. A site-wide caller gets the create
  requirement's 400 (`A new record requires a section`); a scoped caller is refused earlier,
  at 403, because a resource with no stated section matches no scoped grant.
- The create form offers exactly the registered desks behind an unchosen default, so the
  first option is never submitted by accident. The registry seeded here holds a fifth desk,
  `newsroom`, that exists in no seed table in the code. It appears in the picker, which is
  what proves the form is reading the live Firestore registry: if the subscription or the
  row parser were broken, the app would fall back to the built-in four-desk seed and the
  assertion would fail instead of quietly passing on identical values.

## Screenshots

Not committed. What each showed on the recorded run:

| File | What it showed |
|------|----------------|
| `01-super-admin-library.png` | All content: every seeded record |
| `02-sitewide-editor-library.png` | All content: every seeded record |
| `03-watch-editor-library.png` | All content: three watch-desk records only, no station or unsectioned rows |
| `04-watch-editor-create-form-section-picker.png` | New post with a required Section select reading "Choose section", offering the five registered desks including the Firestore-only Newsroom |
| `05-watch-editor-refused-station-record.png` | "Record editing unavailable — You do not have permission to edit this record", no form and no leaked content |
| `06-watch-editor-opens-watch-record.png` | The same editor opening a watch-desk record normally |
| `07-watch-contributor-library.png` | All content: one record, the contributor's own watch draft; no Pages destination |
