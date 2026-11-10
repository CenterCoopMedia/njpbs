import { describe, expect, it } from 'vitest';
import { exchangePairing } from '../../agents/vmix/src/pair';
import { assertUnpaired, loadCredential } from '../../agents/vmix/src/credential-store';

const endpoint = 'https://cms.example.test/cmsPairLiveProductionDevice';
const jwt = (claims: unknown) => [
  Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify(claims)).toString('base64url'),
  Buffer.from('synthetic-signature').toString('base64url'),
].join('.');
// Google signInWithCustomToken response shape, including the studio reply's
// optional fields. It has no localId: https://firebase.google.com/docs/reference/rest/auth
const tokenReply = (idToken: unknown = jwt({ user_id: 'vmix_fixture-device', sub: 'vmix_fixture-device' })) => ({
  expiresIn: '3600', idToken, isNewUser: false,
  kind: 'identitytoolkit#VerifyCustomTokenResponse', refreshToken: 'synthetic-refresh',
});
const pairingRequest = (token: unknown): typeof fetch => {
  let calls = 0;
  return async () => new Response(JSON.stringify(++calls === 1
    ? { success: true, deviceId: 'fixture-device', customToken: 'synthetic-custom' } : token));
};

describe('agent pairing HTTPS boundary', () => {
  it('exchanges one-time pairing for the matching dedicated Firebase refresh credential', async () => {
    const requests: { url: string; body: any }[] = [];
    const request: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(requests.length === 1
        ? { success: true, deviceId: 'fixture-device', customToken: 'synthetic-custom' }
        : tokenReply()), { status: 200 });
    };
    expect(await exchangePairing('https://cms.example.test/cmsPairLiveProductionDevice', 'public-key', 'ABCD-EFGH-JKLM', request))
      .toEqual({ deviceId: 'fixture-device', apiKey: 'public-key', refreshToken: 'synthetic-refresh' });
    expect(requests[0].body).toEqual({ code: 'ABCD-EFGH-JKLM' });
    expect(requests[0].url).not.toContain('ABCD');
    expect(requests[1].body).toEqual({ token: 'synthetic-custom', returnSecureToken: true });
    expect(requests[1].url).toBe('https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=public-key');
  });
  it('rejects wrong product endpoints, mismatched identities and upstream sensitive errors', async () => {
    for (const endpoint of ['http://cms.example.test/cmsPairLiveProductionDevice', 'https://cms.example.test/cmsPollPremierePairing',
      'https://cms.example.test/cmsPairLiveProductionDevice?code=secret', 'https://user:secret@cms.example.test/cmsPairLiveProductionDevice']) {
      await expect(exchangePairing(endpoint, 'public-key', 'ABCD-EFGH-JKLM')).rejects.toThrow('Invalid pairing configuration');
    }
    await expect(exchangePairing('https://cms.example.test/cmsPairLiveProductionDevice', 'public-key', 'ABCD-EFGH-JKLM',
      async () => new Response('synthetic-private-body', { status: 403 }))).rejects.toThrow('Pairing failed. Create a new code in Boardwalk');
    await expect(exchangePairing('https://cms.example.test/cmsPairLiveProductionDevice', 'public-key', 'ABCD-EFGH-JKLM',
      pairingRequest(tokenReply(jwt({ user_id: 'staff-user', sub: 'staff-user' }))))).rejects.toThrow('Invalid device credential response');
  });
  it.each([{ user_id: 'vmix_fixture-device' }, { sub: 'vmix_fixture-device' }])('accepts either ID token identity claim: %j', async claims => {
    await expect(exchangePairing(endpoint, 'public-key', 'synthetic-code', pairingRequest(tokenReply(jwt(claims)))))
      .resolves.toMatchObject({ deviceId: 'fixture-device', refreshToken: 'synthetic-refresh' });
  });
  it.each([
    {}, { user_id: null }, { sub: 123 }, { sub: 'staff-user' },
    { user_id: 'vmix_fixture-device', sub: 'staff-user' },
    { user_id: 'staff-user', sub: 'vmix_fixture-device' },
  ])('rejects missing, invalid or conflicting identities: %j', async claims => {
    await expect(exchangePairing(endpoint, 'public-key', 'synthetic-code', pairingRequest(tokenReply(jwt(claims)))))
      .rejects.toThrow('Invalid device credential response');
  });
  it.each([
    undefined, null, 123, '', 'not-a-jwt', 'a.b.c.d', '.e30.c2ln', 'e30..c2ln', 'e30.e30.',
    'e30.!.c2ln', 'e30.a.c2ln', 'e30.bm90LWpzb24.c2ln', 'e30._w.c2ln',
    jwt(null), jwt([]), jwt('vmix_fixture-device'),
    jwt({ sub: 'vmix_fixture-device' }).replace(/^[^.]+/, 'bnVsbA'),
  ])('rejects malformed ID tokens without trusting localId: %j', async idToken => {
    await expect(exchangePairing(endpoint, 'public-key', 'synthetic-code',
      pairingRequest({ ...tokenReply(), idToken, localId: 'vmix_fixture-device' })))
      .rejects.toThrow('Invalid device credential response');
  });
  it.each([undefined, null, '', 123])('requires a nonempty refresh token: %j', async refreshToken => {
    await expect(exchangePairing(endpoint, 'public-key', 'synthetic-code', pairingRequest({ ...tokenReply(), refreshToken })))
      .rejects.toThrow('Invalid device credential response');
  });
  it('fails closed on non-Windows credential storage', async () => {
    if (process.platform === 'win32') return;
    expect(assertUnpaired).toThrow('Windows account storage is required');
    await expect(loadCredential()).rejects.toThrow('Windows account storage is required');
  });
});
