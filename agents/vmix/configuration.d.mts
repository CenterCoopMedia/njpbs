export const API_ORIGIN_PLACEHOLDER: string;
export function parseApiOrigin(value: unknown): string;
export function studioStreamEndpoint(endpoint: string, configuredOrigin?: string): string | null;
export function pairingApiOrigin(endpoint: unknown): string;
export type StudioConfiguration = {
  schemaVersion: 1; vmixHost: '127.0.0.1'; vmixPort: number; apiAccessMode: 'loopback-without-login'; backgroundInput: number;
  inputs: { headline: number; name_title: number }; overlayInputs: { headline: number; name_title: number };
  titleFiles: { headline: string; name_title: string };
};
export function parseStudioConfiguration(value: unknown): StudioConfiguration;
