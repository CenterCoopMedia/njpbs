import { useState } from "react";
import { avatarPresentation } from "../../lib/author-identity";
import { mediaDisplayUrl } from "../../lib/media-image";
import { AVATAR_DISPLAY_WIDTH } from "../../lib/own-author-photo-cache";
import type { AuthorPhoto } from "../../lib/functions";

// One avatar for the whole admin. Pass a profile's stored photograph and it draws
// the photo; pass nothing and it draws initials. Every surface that shows a person
// goes through here, so a photograph attached on the profile page appears in the
// account menu and the staff roster without either of them knowing about photos.
//
// The initials are decorative: an author's name is always beside the avatar in the
// surfaces that use it, so announcing "SM" as well would only repeat it. The
// photograph is decorative for the same reason -- it carries no information the
// adjacent name does not -- so it takes an empty alt rather than a description.
//
// A photo that fails to load falls back to initials rather than leaving a broken
// frame: the media origin can be unreachable, and an empty grey box beside a name
// reads as a bug.
//
// The failure is remembered against the URL that failed, not as a sticky flag.
// A flag never cleared, so the first unreachable photo turned the avatar into
// initials for the rest of the session: saving a working replacement changed
// nothing on screen until the component happened to remount.
export function AuthorAvatar({
  displayName,
  photo = null,
  photoUrl = null,
  className,
}: {
  displayName: string;
  photo?: Pick<AuthorPhoto, "url" | "focalX" | "focalY" | "thumbnails"> | null;
  /** Escape hatch for a resolved URL with no stored crop. */
  photoUrl?: string | null;
  className?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const effectiveUrl = photo
    ? mediaDisplayUrl(photo, AVATAR_DISPLAY_WIDTH, AVATAR_DISPLAY_WIDTH)
    : photoUrl;
  const avatar = avatarPresentation({
    displayName,
    photoUrl: effectiveUrl === failedUrl ? null : effectiveUrl,
    focalX: photo?.focalX ?? null,
    focalY: photo?.focalY ?? null,
  });
  const classNames = className ? `account-avatar ${className}` : "account-avatar";

  if (avatar.kind === "photo") {
    return (
      <img
        alt=""
        className={`${classNames} account-avatar-photo`}
        key={avatar.url}
        onError={() => setFailedUrl(avatar.url)}
        src={avatar.url}
        style={{ objectPosition: avatar.objectPosition }}
      />
    );
  }
  return (
    <span aria-hidden="true" className={classNames}>
      {avatar.initials}
    </span>
  );
}
