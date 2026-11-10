import { MediaToolbarSpecimenFrame } from "./MediaToolbarSpecimenFrame";

// Gallery specimen: the images toolbar with two applied chips and the Filter popover open at
// Category, with counts. At 1280 the panel is anchored to Filter; at 320 it is a sheet.
export function MediaFilterPopoverSpecimen() {
  return <MediaToolbarSpecimenFrame popover="filter" property="category" query={{ kinds: ["image"], categories: ["news"] }} />;
}
