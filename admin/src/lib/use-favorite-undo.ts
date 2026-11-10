import { useRef } from "react";
import { useLocation } from "react-router";
import { useSuccessNotice } from "../components/ui/SuccessNoticeRegion";
import { HttpError } from "./functions";
import type { MediaFavoriteRef } from "./media-favorites";
import { mediaFavoriteKey, useMediaFavorites } from "./use-media-favorites";

export function useFavoriteUndo(userId: string, favorites: ReturnType<typeof useMediaFavorites>) {
  const routeKey = useLocation().key;
  const notice = useSuccessNotice();
  const current = useRef({ userId, routeKey });
  current.current = { userId, routeKey };

  async function toggle(ref: MediaFavoriteRef, name: string) {
    const owner = { userId, routeKey, refKey: mediaFavoriteKey(ref) };
    const result = await favorites.toggle(ref);
    if (!result || !notice.isCurrent() || current.current.userId !== owner.userId || current.current.routeKey !== owner.routeKey ||
      mediaFavoriteKey(result.ref) !== owner.refKey) return;
    const message = `${name} was ${result.favorite ? "added to" : "removed from"} your favorites.`;
    if (!result.changed) { notice.show(message); return; }

    let used = false;
    notice.show(message, { action: { label: "Undo", onClick: () => {
      if (used || !notice.isCurrent() || current.current.userId !== owner.userId || current.current.routeKey !== owner.routeKey ||
        mediaFavoriteKey(ref) !== owner.refKey) return;
      used = true;
      notice.show(`Undoing the change to ${name}.`);
      void favorites.setFavorite(ref, !result.favorite, { throwOnError: true, canWrite: () => notice.isCurrent() &&
        current.current.userId === owner.userId && current.current.routeKey === owner.routeKey }).then(reversed => {
        if (!notice.isCurrent() || current.current.userId !== owner.userId || current.current.routeKey !== owner.routeKey) return;
        if (!reversed || mediaFavoriteKey(reversed.ref) !== owner.refKey || reversed.favorite === result.favorite) {
          notice.show(`The change to ${name} could not be undone. Reload the library.`, { tone: "error" });
          return;
        }
        notice.show(`${name} was ${reversed.favorite ? "restored to" : "removed from"} your favorites.`);
      }).catch(error => {
        if (!notice.isCurrent() || current.current.userId !== owner.userId || current.current.routeKey !== owner.routeKey) return;
        notice.show(error instanceof HttpError && error.status === 404
          ? `${name} is no longer available and could not be restored.`
          : `The change to ${name} could not be undone. Reload the library.`, { tone: "error" });
      });
    } } });
  }

  return { toggle };
}
