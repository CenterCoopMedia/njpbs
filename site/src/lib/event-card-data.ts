import type { CmsEventBuildData } from "./cms-events-loader";

export function eventCardData(snapshot: CmsEventBuildData) {
  return {
    title: snapshot.title,
    url: snapshot.path,
    startsAt: snapshot.startsAt,
    endsAt: snapshot.endsAt,
    location: snapshot.location,
    image: snapshot.image,
    imageAlt: snapshot.imageDecorative ? "" : snapshot.imageAlt,
    registrationUrl: snapshot.registrationUrl,
    registrationLabel: snapshot.registrationLabel,
  };
}
