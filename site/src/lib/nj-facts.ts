// New Jersey civic numbers used as quiet allusions in the design.
//
// Only NJ_MUNICIPALITIES is encoded in the hero geometry: the outline ring in
// src/data/nj-points.json is resampled to exactly that many points, one per town
// (see scripts/resample-nj-edge.py and tests/nj-points.test.ts). The year values
// are reference constants for comments and copy -- commemorative, not encoded in
// any geometry, and not claims about the site or its operator.

/** New Jersey's 564 municipalities. The hero's boundary ring carries one point each. */
export const NJ_MUNICIPALITIES = 564;

/** 1664 -- the English took New Netherland and named the colony New Jersey. */
export const NJ_NAMED = 1664;

/** 1787 -- New Jersey ratified the U.S. Constitution, the third state to do so. */
export const NJ_RATIFIED_CONSTITUTION = 1787;
