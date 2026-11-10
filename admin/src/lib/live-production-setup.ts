import { parseTemplateMapping, type TemplateMapping } from "../../../packages/content-core/src/live-production";
import { parseApiOrigin, parseStudioConfiguration } from "../../../agents/vmix/configuration.mjs";
import type { SessionView, StudioInputs } from "./live-production-workspace";

export const STUDIO_INPUT_FILE_LIMIT = 16 * 1024;
// Build inputs are captured once; an unavailable preset disables only setup.
const studioConfiguration = (() => {
  try { return parseStudioConfiguration(JSON.parse(import.meta.env.VITE_CMS_STUDIO_CONFIGURATION ?? "")); }
  catch { return null; }
})();
const studioApiOrigin = (() => {
  try { return parseApiOrigin(import.meta.env.VITE_FUNCTIONS_BASE_URL); }
  catch { return null; }
})();
function requiredStudioConfiguration() {
  if (!studioConfiguration) throw new Error("Studio preset configuration is unavailable. Contact support before setup.");
  return studioConfiguration;
}
export const studioInputFields = [
  { group: "inputs", template: "headline", number: studioConfiguration?.inputs.headline, label: "Headline text input" },
  { group: "inputs", template: "name_title", number: studioConfiguration?.inputs.name_title, label: "Name and title text input" },
  { group: "overlayInputs", template: "headline", number: studioConfiguration?.overlayInputs.headline, label: "Headline banner target" },
  { group: "overlayInputs", template: "name_title", number: studioConfiguration?.overlayInputs.name_title, label: "Name and title banner target" },
] as const;

export function sameStudioInputs(left: Pick<TemplateMapping, "inputs" | "overlayInputs">, right: Pick<TemplateMapping, "inputs" | "overlayInputs">) {
  return studioInputFields.every(({ group, template }) => {
    const a = left[group]?.[template], b = right[group]?.[template];
    return a?.key === b?.key && a?.number === b?.number && a?.title === b?.title;
  });
}

export function parseStudioInputs(text: string): StudioInputs {
  requiredStudioConfiguration();
  const refused = "Choose studio-inputs.json made by Set up Studio connector.cmd. It must contain only the four distinct input identities from the configured preset.";
  if (new TextEncoder().encode(text).length > STUDIO_INPUT_FILE_LIMIT) throw new Error("Studio input details must fit 16 KiB.");
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "inputs,overlayInputs") throw new Error();
    const mapping = parseTemplateMapping({ ...value, schemaVersion: 1, sessionId: "preview", deviceId: "preview",
      version: 1, overlay: 1, state: "uncommissioned", verifiedAtMs: null });
    for (const { group, template, number } of studioInputFields) {
      if (mapping[group]?.[template]?.number !== number) throw new Error();
    }
    return { inputs: mapping.inputs, overlayInputs: mapping.overlayInputs } as StudioInputs;
  } catch { throw new Error(refused); }
}

// This handoff is nonsecret. The connector owns credential storage and journal paths.
export function connectorSetup(view: SessionView): string {
  const { session, mapping } = view;
  if (!session.deviceId || !mapping.inputs.headline || !mapping.inputs.name_title || !mapping.overlayInputs || session.state === "ended") {
    throw new Error("Save the four studio inputs and paired PC before copying connector setup.");
  }
  const preset = requiredStudioConfiguration();
  if (!studioApiOrigin) throw new Error("Studio API configuration is unavailable. Contact support before setup.");
  for (const { group, template, number } of studioInputFields) {
    if (mapping[group]?.[template]?.number !== number) throw new Error("The saved mapping differs from the configured studio preset.");
  }
  return JSON.stringify({ endpoint: `${studioApiOrigin}/cmsLiveProductionAgent`, deviceId: session.deviceId,
    sessionId: session.id, vmixPort: preset.vmixPort, exclusiveOverlay1: true, mapping, titleFilesConfirmed: true });
}
