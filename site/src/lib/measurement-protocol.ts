// Typed adapter for the deployable CommonJS conversion core in functions/.
// The site tests exercise that runtime module without a second implementation.
import { createRequire } from "node:module";

export type ConsentState = "granted" | "denied" | "absent";

export type ServerEventDecision =
  | { send: true; clientId: string }
  | { send: false; reason: "consent-denied" | "no-consent-cookie" | "gpc" | "no-client-id" };

export interface RequestSignals {
  cookieHeader?: string | null;
  gpcHeader?: string | null;
}

export interface EventPayload {
  client_id: string;
  non_personalized_ads: boolean;
  events: Array<{ name: string; params: Record<string, unknown> }>;
}

interface MeasurementProtocolCore {
  parseGaClientId(cookieHeader: string | null | undefined): string | null;
  parseConsentCookie(cookieHeader: string | null | undefined): ConsentState;
  decideServerEvent(signals: RequestSignals): ServerEventDecision;
  buildEventPayload(
    clientId: string,
    name: string,
    params?: Record<string, unknown>,
  ): EventPayload;
}

const require = createRequire(import.meta.url);
const core = require("../../../functions/lib/measurement-protocol.js") as MeasurementProtocolCore;

export const parseGaClientId = core.parseGaClientId;
export const parseConsentCookie = core.parseConsentCookie;
export const decideServerEvent = core.decideServerEvent;
export const buildEventPayload = core.buildEventPayload;
