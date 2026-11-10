import { useMemo, useRef } from "react";
import type { PreviewStatusResponse } from "../lib/functions";
import {
  PagePreview as PagePreviewImpl,
  type PagePreviewProps as PagePreviewImplProps,
} from "./PagePreviewImpl";

export type PagePreviewProps = PagePreviewImplProps;

// The queue read starts immediately, but an answer that is already terminal can otherwise replace
// the accepted "building" state before React, assistive technology, or a person can observe it.
// Keep that accepted state visible for a small, bounded transition window without delaying the
// network request or any active pending/building response. Controlled tests retain their shorter
// override so timing-sensitive behavior remains deterministic.
const DEFAULT_ACCEPTED_STATE_MIN_MS = 250;
const ACTIVE_STATUS_MIN_MS = 50;

type QueueObservation = {
  startedAt: number;
  observedActiveStatus: boolean;
};

function isActiveStatus(status: PreviewStatusResponse): boolean {
  return status.status === "pending" || status.status === "building";
}

function minimumVisibleMs(
  pollIntervalMs: number | undefined,
  observedActiveStatus: boolean,
): number {
  const acceptedStateWindow =
    typeof pollIntervalMs === "number"
      ? Math.min(
          Math.max(0, pollIntervalMs),
          DEFAULT_ACCEPTED_STATE_MIN_MS,
        )
      : DEFAULT_ACCEPTED_STATE_MIN_MS;
  return observedActiveStatus
    ? Math.max(ACTIVE_STATUS_MIN_MS, acceptedStateWindow)
    : acceptedStateWindow;
}

async function holdAcceptedState(
  observation: QueueObservation,
  pollIntervalMs: number | undefined,
): Promise<void> {
  const remaining =
    minimumVisibleMs(pollIntervalMs, observation.observedActiveStatus) -
    (Date.now() - observation.startedAt);
  if (remaining <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, remaining));
}

export function PagePreview(props: PagePreviewImplProps) {
  const observations = useRef(new Map<string, QueueObservation>());
  const stabilizedStatusLoader = useMemo(() => {
    const loadPreviewStatus = props.loadPreviewStatus;
    if (!loadPreviewStatus) return undefined;

    return async (queueId: string): Promise<PreviewStatusResponse> => {
      let observation = observations.current.get(queueId);
      if (!observation) {
        observation = {
          startedAt: Date.now(),
          observedActiveStatus: false,
        };
        observations.current.set(queueId, observation);
      }

      try {
        const status = await loadPreviewStatus(queueId);
        if (isActiveStatus(status)) {
          observation.observedActiveStatus = true;
          return status;
        }
        await holdAcceptedState(observation, props.pollIntervalMs);
        observations.current.delete(queueId);
        return status;
      } catch (error) {
        await holdAcceptedState(observation, props.pollIntervalMs);
        observations.current.delete(queueId);
        throw error;
      }
    };
  }, [props.loadPreviewStatus, props.pollIntervalMs]);

  return (
    <PagePreviewImpl
      {...props}
      loadPreviewStatus={stabilizedStatusLoader}
    />
  );
}
