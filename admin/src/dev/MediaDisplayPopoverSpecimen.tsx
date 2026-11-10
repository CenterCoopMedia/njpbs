import { MediaToolbarSpecimenFrame } from "./MediaToolbarSpecimenFrame";

// Gallery specimen: the images toolbar with the Display popover open. At 1280 the panel is
// anchored to Display, or to More when Display has collapsed; at 320 it is a sheet.
export function MediaDisplayPopoverSpecimen() {
  return <MediaToolbarSpecimenFrame popover="display" />;
}
