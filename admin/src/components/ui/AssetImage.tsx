import { type ImgHTMLAttributes, type ReactNode, useEffect, useState } from "react";

/**
 * An image that degrades to a designed fallback instead of the browser's broken-image glyph.
 * A deleted or unreachable asset used to leave a raw torn-picture icon in a card, a picker
 * tile, or a media row; the fallback is whatever the caller already shows when there is no
 * image, so the two states read the same. The failure resets when the source changes, so a
 * freshly chosen asset gets its own chance to load.
 */
export function AssetImage({
  fallback,
  src,
  onError,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & { fallback: ReactNode }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  useEffect(() => {
    setFailedSrc(null);
  }, [src]);
  if (src && failedSrc === src) return <>{fallback}</>;
  return (
    <img
      src={src}
      {...props}
      onError={(event) => {
        setFailedSrc(src ?? null);
        onError?.(event);
      }}
    />
  );
}
