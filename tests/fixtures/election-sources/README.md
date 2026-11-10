# Election source fixtures

`roster.json` is the allowlisted public projection of the real nj-decides roster
with explicit persistent IDs from the companion public-data PR and the
September 4 amended CD7 certification applied. It contains all 39 candidates
and 13 races, no private
questionnaire fields, photos or bios.

`repo-live.json`, `results.csv` and `golden.json` are synthetic
results attached to that real roster. The apparent votes are test data, not
election returns. The normalizer tests explicitly distinguish a rejected sample
from a live transport envelope. Sheet inputs are API cell matrices; the CSV is
a readable template fixture, not a runtime CSV parser.

`ap-synthetic-outside-election.json` is handwritten test data with fictional
candidate names, IDs and vote counts. Its 2024 election date and Vermont unit
must be refused by the 2026 New Jersey election boundary. Its first candidate
has 1,200 votes. EEVP 85 and precinct reporting 100 are independent input values:
the expected vote share is 0.85, while ordinary precinct reporting remains 100.
These values preserve the parser and refusal contracts without recorded returns.

The AP test builder uses documented v3 response fields and synthetic IDs mapped
to the real NJ roster. It covers calls, certification, empty deltas, stale cache,
malformed responses and mapping failures. No AP key is needed for these fixtures;
fixture proof does not establish live-provider behavior.

Provider references:

- [AP response fields](https://developer.ap.org/ap-elections-api/docs/Elections_Response_Data_Elements.htm)
- [AP v3 release notes](https://developer.ap.org/ap-elections-api/docs/Release_Notes.htm)

## AP v3 field conformance

`ap-v3-live-b.json` and `ap-v3.js` follow AP v3.2 response field shapes. Race and candidate IDs, vote counts and timestamps are synthetic. They cover numeric reportingunitLevel, six-digit instants, race and reporting-unit eevp, raceCallStatus, tabulationStatus, optional bestSources and absent winner. The called variant uses the documented winner=X marker with Winner Not Leading; the test variant retains AP's virtual election-night clock for replay.
