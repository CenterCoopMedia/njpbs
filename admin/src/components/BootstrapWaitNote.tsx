import { BoardwalkTip } from "./ui/BoardwalkTip";

export const BOOTSTRAP_NOTE_INTERVAL_MS = 4500;

export function BootstrapWaitNote({ slow }: { slow: boolean }) {
  return <BoardwalkTip intervalMs={BOOTSTRAP_NOTE_INTERVAL_MS} stopped={slow} className="bootstrap-wait-copy" />;
}
