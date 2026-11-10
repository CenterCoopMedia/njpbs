import { readFileSync } from 'node:fs';
import { readBody, requestSignal } from './http';
import { assertUnpaired, storeCredential } from './credential-store';

async function readCode(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error('Pair from an interactive Windows terminal');
  process.stderr.write('Enter the Boardwalk pairing code (hidden): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let code = '';
    const finish = (error?: Error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n');
      if (error) reject(error); else resolve(code);
    };
    const onData = (data: Buffer) => {
      for (const char of data.toString('utf8')) {
        if (char === '\u0003' || char === '\u0004') return finish(new Error('Pairing canceled'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') code = code.slice(0, -1);
        else if (/[A-Za-z0-9-]/.test(char) && code.length < 32) code += char;
      }
    };
    process.stdin.on('data', onData);
  });
}

function hasDeviceIdentity(idToken: unknown, deviceId: string): boolean {
  if (typeof idToken !== 'string') return false;
  const parts = idToken.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part) ||
      Buffer.from(part, 'base64url').toString('base64url') !== part)) return false;
  try {
    const decode = (part: string) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(part, 'base64url')));
    const header = decode(parts[0]);
    const claims = decode(parts[1]);
    if (!header || typeof header !== 'object' || Array.isArray(header) ||
        !claims || typeof claims !== 'object' || Array.isArray(claims)) return false;
    const identities = [claims.user_id, claims.sub].filter(value => value !== undefined);
    return identities.length > 0 && identities.every(value => value === `vmix_${deviceId}`);
  } catch { return false; }
}

export async function exchangePairing(endpoint: string, apiKey: string, code: string,
  request: typeof fetch = fetch): Promise<{ deviceId: string; refreshToken: string; apiKey: string }> {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !url.pathname.endsWith('/cmsPairLiveProductionDevice') || !apiKey) throw new Error('Invalid pairing configuration');
  const paired = await request(url, { method: 'POST', redirect: 'error', signal: requestSignal(15_000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  if (!paired.ok) throw new Error('Pairing failed. Create a new code in Boardwalk');
  const enrollment = JSON.parse(await readBody(paired, 64_000));
  if (enrollment.success !== true || typeof enrollment.deviceId !== 'string' ||
      typeof enrollment.customToken !== 'string') throw new Error('Invalid pairing response');
  const tokenUrl = new URL('https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken');
  tokenUrl.searchParams.set('key', apiKey);
  const response = await request(tokenUrl, { method: 'POST', redirect: 'error', signal: requestSignal(15_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: enrollment.customToken, returnSecureToken: true }) });
  if (!response.ok) throw new Error('Device sign-in failed. Revoke this enrollment and start again');
  const token = JSON.parse(await readBody(response, 64_000));
  // Google returns an ID token, not localId. HTTPS authenticates this response;
  // decode its identity here without retaining the short-lived token.
  if (typeof token.refreshToken !== 'string' || !token.refreshToken || !hasDeviceIdentity(token.idToken, enrollment.deviceId)) {
    throw new Error('Invalid device credential response');
  }
  return { deviceId: enrollment.deviceId, refreshToken: token.refreshToken, apiKey };
}
export async function pair(configPath: string) {
  assertUnpaired();
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const code = await readCode();
  const credential = await exchangePairing(config.pairingEndpoint, config.apiKey, code);
  await storeCredential(credential);
  console.log(`Device enrolled: ${credential.deviceId}. Credential saved for this Windows account.`);
}
