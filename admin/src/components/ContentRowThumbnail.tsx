import { AssetImage } from "./ui/AssetImage";
import { Icon, type IconName } from "./ui/Icon";

interface ContentRowThumbnailProps {
  src?: string;
  icon: IconName;
}

function ThumbnailFallback({ icon }: { icon: IconName }) {
  return (
    <span className="content-row-thumbnail content-row-thumbnail-fallback" aria-hidden="true">
      <Icon name={icon} />
    </span>
  );
}

export function ContentRowThumbnail({ src, icon }: ContentRowThumbnailProps) {
  const fallback = <ThumbnailFallback icon={icon} />;
  if (!src) return fallback;
  return (
    <AssetImage
      className="content-row-thumbnail content-row-thumbnail-image"
      src={src}
      alt=""
      width={52}
      height={52}
      loading="lazy"
      decoding="async"
      fallback={fallback}
    />
  );
}
