import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { assertDevelopmentRehearsalEnvironment, createDevelopmentCredentialSource,
  hasDevelopmentCredentialSource, writeDevelopmentCredential, closeDevelopmentCredentialSource,
  openDevelopmentRehearsalContext, openDevelopmentSourceContext, openDemoRehearsalContext } from '../scripts/lib/development-rehearsal-credentials.mjs';

// Synthetic credential shape only. It cannot sign a request or initialize cert().
const account = { type: 'service_account', project_id: 'njpbs-site-dev',
  client_email: 'fixture@njpbs-site-dev.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nfixture-not-a-real-key' };
const handles = [];
const source = input => {
  const handle = createDevelopmentCredentialSource(Readable.from([input]));
  handles.push(handle);
  return handle;
};
const sink = () => {
  const chunks = [];
  return { stream: new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }),
    output: () => Buffer.concat(chunks).toString('utf8') };
};
beforeEach(() => {
  for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'GOOGLE_APPLICATION_CREDENTIALS',
    'FIREBASE_CONFIG', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) vi.stubEnv(key, undefined);
});
afterEach(() => { handles.splice(0).forEach(closeDevelopmentCredentialSource); vi.unstubAllEnvs(); });

it.each(['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CONFIG'])(
  'refuses even an empty ambient %s before reading the input stream', async key => {
    vi.stubEnv(key, '');
    let reads = 0;
    const input = new Readable({ read() { reads++; this.push(null); } });
    await expect(openDevelopmentRehearsalContext(input)).rejects.toThrow('Development rehearsal credential refused');
    expect(reads).toBe(0);
    input.destroy();
  });

it('accepts only the explicit development project in either ambient project field', () => {
  expect(() => assertDevelopmentRehearsalEnvironment({ GCLOUD_PROJECT: 'njpbs-site-dev', GOOGLE_CLOUD_PROJECT: 'njpbs-site-dev' })).not.toThrow();
  for (const key of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) {
    expect(() => assertDevelopmentRehearsalEnvironment({ [key]: 'njpbs-site' })).toThrow('Development rehearsal credential refused');
  }
});

it('forwards an opaque in-memory source across streams and reuses only that same source', async () => {
  const input = JSON.stringify(account), handle = source(input);
  expect(JSON.stringify(handle)).toBe('{}');
  expect(hasDevelopmentCredentialSource(handle)).toBe(true);
  for (let count = 0; count < 2; count++) {
    const output = sink();
    await writeDevelopmentCredential(handle, output.stream);
    expect(output.output()).toBe(input);
  }
  closeDevelopmentCredentialSource(handle);
  expect(hasDevelopmentCredentialSource(handle)).toBe(false);
  await expect(writeDevelopmentCredential(handle, sink().stream)).rejects.toThrow('Development rehearsal credential refused');
});

it.each([
  ['wrong project', JSON.stringify({ ...account, project_id: 'njpbs-site' })],
  ['malformed JSON', 'invalid-credential-body'],
  ['oversized input', 'x'.repeat(32_769)],
])('refuses %s without forwarding credential bytes', async (label, input) => {
  const output = sink();
  await expect(writeDevelopmentCredential(source(input), output.stream)).rejects.toThrow('Development rehearsal credential refused');
  expect(output.output()).toBe('');
});

it('opens and closes a private lazy context without using an SDK client', async () => {
  const context = await openDevelopmentRehearsalContext(Readable.from([JSON.stringify(account)]));
  expect(context.projectId).toBe('njpbs-site-dev');
  expect(JSON.stringify(context)).toBe('{}');
  // The synthetic key would fail cert(); opening must not initialize it.
  await expect(context.close()).resolves.toBeUndefined();
  expect(() => context.firestore).toThrow('Development rehearsal credential refused');
});

it('opens the parent read-only context from the same closed source without exposing or refetching the account', async () => {
  const handle = source(JSON.stringify(account));
  const output = sink(); await writeDevelopmentCredential(handle, output.stream);
  const context = await openDevelopmentSourceContext(handle);
  expect(context.projectId).toBe('njpbs-site-dev'); expect(JSON.stringify(context)).toBe('{}');
  await context.close(); expect(() => context.firestore).toThrow('Development rehearsal credential refused');
  closeDevelopmentCredentialSource(handle);
  await expect(openDevelopmentSourceContext(handle)).rejects.toThrow('Development rehearsal credential refused');
  await expect(openDevelopmentSourceContext({ ...handle })).rejects.toThrow('Development rehearsal credential refused');
});

it('opens only an exact explicit demo emulator as a private lazy parent context', async () => {
  const packet = { schemaVersion: 1, projectId: 'demo-rehearsal', emulatorHost: '127.0.0.1:18481' };
  expect(() => openDemoRehearsalContext(packet)).toThrow();
  vi.stubEnv('FIRESTORE_EMULATOR_HOST', packet.emulatorHost);
  const context = openDemoRehearsalContext(packet);
  expect(context.projectId).toBe(packet.projectId); expect(JSON.stringify(context)).toBe('{}');
  vi.stubEnv('FIRESTORE_EMULATOR_HOST', undefined);
  expect(() => context.firestore).toThrow('Development rehearsal credential refused');
  vi.stubEnv('FIRESTORE_EMULATOR_HOST', packet.emulatorHost);
  await context.close(); expect(() => context.firestore).toThrow();
  expect(() => openDemoRehearsalContext({ ...packet, projectId: 'njpbs-site' })).toThrow();
  expect(() => openDemoRehearsalContext({ ...packet, emulatorHost: '127.0.0.1:18482' })).toThrow();
});
it.each(['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CONFIG', 'GCLOUD_PROJECT'])(
  'refuses ambient %s before an explicit demo can initialize a client', key => {
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:18481'); vi.stubEnv(key, 'njpbs-site');
    expect(() => openDemoRehearsalContext({ schemaVersion: 1, projectId: 'demo-rehearsal', emulatorHost: '127.0.0.1:18481' })).toThrow();
  });
it('rechecks development isolation before a lazy context can initialize its SDK', async () => {
  const context = await openDevelopmentRehearsalContext(Readable.from([JSON.stringify(account)]));
  vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:18481');
  expect(() => context.firestore).toThrow('Development rehearsal credential refused');
  await context.close();
});

it('reads inherited fd3 in a real child while keeping credential bytes out of argv, environment and output', async () => {
  const moduleUrl = new URL('../scripts/lib/development-rehearsal-credentials.mjs', import.meta.url).href;
  const program = `import { openDevelopmentRehearsalContext } from ${JSON.stringify(moduleUrl)};
    const context = await openDevelopmentRehearsalContext();
    process.stdout.write(JSON.stringify({ projectId: context.projectId, context }));
    await context.close();`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', program], {
    env: { PATH: process.env.PATH, HOME: '/nonexistent' }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { errors += bytes; });
  const closed = new Promise((accept, reject) => { child.on('error', reject); child.on('close', code => accept(code)); });
  await writeDevelopmentCredential(source(JSON.stringify(account)), child.stdio[3]);
  expect(await closed).toBe(0);
  expect(errors).toBe('');
  expect(JSON.parse(output)).toEqual({ projectId: 'njpbs-site-dev', context: {} });
});

it('exits at the exact credential deadline with a controlled child clock and an open pipe', async () => {
  const moduleUrl = new URL('../scripts/lib/development-rehearsal-credentials.mjs', import.meta.url).href;
  const program = `import { mock } from 'node:test';
    import { openDevelopmentRehearsalContext } from ${JSON.stringify(moduleUrl)};
    mock.timers.enable({ apis: ['setTimeout'] });
    const reading = openDevelopmentRehearsalContext();
    let pending = true;
    reading.then(() => { pending = false; }, () => { pending = false; });
    mock.timers.tick(9999);
    await new Promise(resolve => setImmediate(resolve));
    if (!pending) throw new Error('Credential deadline fired early');
    mock.timers.tick(1);
    try { await reading; process.exitCode = 2; }
    catch { process.stderr.write('Development rehearsal credential refused'); process.exitCode = 1; }
    finally { mock.timers.reset(); }`;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '--eval', program], {
    env: { PATH: process.env.PATH, HOME: '/nonexistent' }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  let output = '', errors = '', killed = false;
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { errors += bytes; });
  const deadline = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, 5_000);
  try {
    const code = await new Promise((accept, reject) => { child.on('error', reject); child.on('close', accept); });
    expect(killed).toBe(false);
    expect(code).toBe(1);
    expect(output).toBe('');
    expect(errors).toBe('Development rehearsal credential refused');
  } finally { clearTimeout(deadline); child.stdio[3].destroy(); child.kill(); }
});
