import { createContext, useContext, type ReactNode } from "react";
import type { AvatarPhoto, AvatarPhotoSource } from "../lib/own-author-photo-cache";

// The signed-in person's own profile photograph, hoisted to the shell.
//
// The avatar in the navigation account menu and the one in account settings are
// drawn by the layout, which knows the account (a display name and an email) but
// not the author profile the photograph lives on. So saving a photo changed every
// avatar except the two the person looks at most.
//
// The shell resolves it once, on mount, and the profile route publishes the value
// it already has after each load or save, so nothing re-fetches on navigation and
// no render depends on a request. Shaped like WorkspaceActions: a default value
// that means "no shell is listening", so the profile route and its spec can mount
// outside the layout without a provider.

export interface OwnAuthorPhotoValue {
  photo: AvatarPhoto | null;
  /** Publish the signed-in person's own photograph to the shell avatars. */
  setPhoto: (photo: AvatarPhotoSource | null) => void;
}

const OwnAuthorPhotoContext = createContext<OwnAuthorPhotoValue>({
  photo: null,
  setPhoto: () => undefined,
});

export function OwnAuthorPhotoProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: OwnAuthorPhotoValue;
}) {
  return (
    <OwnAuthorPhotoContext.Provider value={value}>
      {children}
    </OwnAuthorPhotoContext.Provider>
  );
}

export function useOwnAuthorPhoto(): OwnAuthorPhotoValue {
  return useContext(OwnAuthorPhotoContext);
}
