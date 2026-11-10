import { Button } from "./ui/Primitives";
import { Icon } from "./ui/Icon";

export function MediaFavoriteButton({
  name,
  favorite,
  pending = false,
  disabled = false,
  className,
  tabIndex,
  onToggle,
}: {
  name: string;
  favorite: boolean | undefined;
  pending?: boolean;
  disabled?: boolean;
  className?: string;
  tabIndex?: number;
  onToggle: () => void;
}) {
  const actionLabel = favorite === undefined
    ? "Loading favorite"
    : favorite
      ? "Remove from favorites"
      : "Add to favorites";
  const label = pending ? "Saving favorite" : actionLabel;
  return (
    <Button
      variant="ghost"
      className={["action-control-icon", "media-favorite-button", className].filter(Boolean).join(" ")}
      aria-label={`${label}: ${name}`}
      aria-pressed={favorite === true}
      aria-busy={pending || undefined}
      aria-disabled={pending || disabled || undefined}
      disabled={disabled || favorite === undefined}
      title={label}
      tabIndex={tabIndex}
      onClick={(event) => {
        if (pending) {
          event.preventDefault();
          return;
        }
        onToggle();
      }}
    >
      <Icon name="heart" />
    </Button>
  );
}
