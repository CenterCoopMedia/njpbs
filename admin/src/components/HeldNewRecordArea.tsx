import { useId, useState } from "react";
import { Button, InlineMessage, Select } from "./ui/Primitives";

export function HeldNewRecordArea({ areas, onChoose }: {
  areas: readonly { id: string; label: string }[];
  onChoose: (area: string) => void;
}) {
  const id = useId();
  const [area, setArea] = useState("");
  return <InlineMessage tone="info" title="Choose an area for this draft">
    <div>
      <p>Your draft was held before you chose an editorial area.</p>
      <div className="button-row">
        <div>
          <label htmlFor={id}>Editorial area</label>
          <Select id={id} value={area} onChange={event => setArea(event.target.value)}>
            <option value="">Choose an area</option>
            {areas.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </Select>
        </div>
        <Button disabled={!areas.some(option => option.id === area)} onClick={() => onChoose(area)}>Restore draft</Button>
      </div>
    </div>
  </InlineMessage>;
}
