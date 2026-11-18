# Functions test groups

`npm run test:functions` runs preflight and both Functions test groups.
`npm run test:functions:unit` runs the files in `unit-files.json` without
the Firebase emulators. Add a file to that list when its setup and assertions
use only local logic, injected dependencies or self-contained fixtures.
Keep files that call the Firebase emulators out of the list.

`npm run test:functions:emulator` runs the remaining Functions test files.
Hosted CI runs the unit group alongside four emulator shards. Each emulator
shard runs files in sequence. The sealed Docker contract also runs in its own
hosted job.
