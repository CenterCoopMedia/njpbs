import { useId } from "react";
import { MEDIA_COLLECTION_COLORS, type MediaCollectionColor } from "../lib/media-collections";

const COLOR_LABELS: Record<MediaCollectionColor, string> = {
  slate: "Slate",
  blue: "Blue",
  green: "Green",
  gold: "Gold",
  red: "Red",
  purple: "Purple",
};

export function CollectionColorField({
  value,
  disabled,
  onChange,
}: {
  value: MediaCollectionColor;
  disabled?: boolean;
  onChange: (color: MediaCollectionColor) => void;
}) {
  const group = useId();
  return (
    <fieldset className="media-collection-colors" disabled={disabled}>
      <legend>Folder color</legend>
      <div className="media-collection-color-options">
        {MEDIA_COLLECTION_COLORS.map((color) => (
          <label key={color} className="media-collection-color-option">
            <input
              type="radio"
              name={group}
              value={color}
              checked={value === color}
              onChange={() => onChange(color)}
            />
            <span className="media-collection-color-swatch" data-color={color}>
              {COLOR_LABELS[color]}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
