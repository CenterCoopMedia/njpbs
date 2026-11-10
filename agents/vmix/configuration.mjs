// Deployment origins and studio presets are supplied outside the source tree.
export const API_ORIGIN_PLACEHOLDER = 'https://api.example.org';

export function parseApiOrigin(value) {
  if (typeof value !== 'string' || value === API_ORIGIN_PLACEHOLDER) throw new Error('Configure the Studio API origin');
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid Studio API origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/' || value !== url.origin) throw new Error('Invalid Studio API origin');
  return url.origin;
}

export function studioStreamEndpoint(endpoint, configuredOrigin) {
  if (!configuredOrigin) return null;
  const origin = parseApiOrigin(configuredOrigin);
  const url = new URL(endpoint);
  if (url.origin !== origin || url.pathname !== '/cmsLiveProductionAgent' || url.username || url.password || url.search || url.hash) return null;
  return `wss://${url.host}/live-production/agent`;
}

export function pairingApiOrigin(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('Invalid package pairing endpoint'); }
  if (url.pathname !== '/cmsPairLiveProductionDevice' || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid package pairing endpoint');
  }
  return parseApiOrigin(url.origin);
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) {
    throw new Error('Invalid private studio configuration');
  }
}

export function parseStudioConfiguration(value) {
  exactKeys(value, ['schemaVersion', 'vmixHost', 'vmixPort', 'apiAccessMode', 'backgroundInput', 'inputs', 'overlayInputs', 'titleFiles']);
  exactKeys(value.inputs, ['headline', 'name_title']);
  exactKeys(value.overlayInputs, ['headline', 'name_title']);
  exactKeys(value.titleFiles, ['headline', 'name_title']);
  // Setup never opens a LAN endpoint or silently changes authentication behavior.
  if (value.schemaVersion !== 1 || value.vmixHost !== '127.0.0.1' || value.apiAccessMode !== 'loopback-without-login' ||
      !Number.isSafeInteger(value.vmixPort) || value.vmixPort < 1 || value.vmixPort > 65535) {
    throw new Error('Invalid private studio configuration');
  }
  const numbers = [value.backgroundInput, ...Object.values(value.inputs), ...Object.values(value.overlayInputs)];
  if (numbers.some(number => !Number.isSafeInteger(number) || number < 1) || new Set(numbers).size !== numbers.length) {
    throw new Error('Invalid private studio mapping');
  }
  for (const name of Object.values(value.titleFiles)) {
    if (typeof name !== 'string' || name.length > 255 || !/^[^\\/\x00-\x1f\x7f:*?"<>|]+\.gtzip$/i.test(name) || /REPLACE_ME/i.test(name)) {
      throw new Error('Invalid private studio title file');
    }
  }
  if (value.titleFiles.headline.toLowerCase() === value.titleFiles.name_title.toLowerCase()) {
    throw new Error('Distinct private studio title files are required');
  }
  return { schemaVersion: 1, vmixHost: value.vmixHost, vmixPort: value.vmixPort, apiAccessMode: value.apiAccessMode,
    backgroundInput: value.backgroundInput, inputs: { ...value.inputs }, overlayInputs: { ...value.overlayInputs }, titleFiles: { ...value.titleFiles } };
}
