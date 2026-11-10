import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { API_ORIGIN_PLACEHOLDER, pairingApiOrigin, parseApiOrigin, parseStudioConfiguration, studioStreamEndpoint } from '../../agents/vmix/configuration.mjs';
import { buildWindowsPackage } from '../../agents/vmix/build-windows.mjs';
import { layeredSimulatorMapping, simulatorMapping } from '../../agents/vmix/src/simulator';
import { parseStudioTitleFiles } from '../../packages/content-core/src/live-production';

const origin = 'https://studio.example.test';
const fixture = () => ({ schemaVersion: 1, vmixHost: '127.0.0.1', vmixPort: 12345,
  apiAccessMode: 'loopback-without-login', backgroundInput: 500,
  inputs: { headline: 501, name_title: 502 }, overlayInputs: { headline: 503, name_title: 504 },
  titleFiles: { headline: 'Example headline.gtzip', name_title: 'Example name-title.gtzip' } });

describe('Studio configuration boundaries', () => {
  it('refuses a release before Git, downloads or enrollment when the origin is missing', async () => {
    await expect(buildWindowsPackage({ sourceSha: 'a'.repeat(40), output: 'unused', apiKey: 'synthetic', apiOrigin: '' }))
      .rejects.toThrow('CMS_STUDIO_API_ORIGIN');
  });
  it('pins socket opt-in and pairing to one configured HTTPS origin', () => {
    expect(parseApiOrigin(origin)).toBe(origin);
    expect(pairingApiOrigin(`${origin}/cmsPairLiveProductionDevice`)).toBe(origin);
    expect(studioStreamEndpoint(`${origin}/cmsLiveProductionAgent`, origin)).toBe('wss://studio.example.test/live-production/agent');
    expect(studioStreamEndpoint('https://other.example.test/cmsLiveProductionAgent', origin)).toBeNull();
    expect(studioStreamEndpoint(`${origin}/cmsLiveProductionAgent`)).toBeNull();
    expect(studioStreamEndpoint(`${origin}/prefix/cmsLiveProductionAgent`, origin)).toBeNull();
  });
  it.each([undefined, '', API_ORIGIN_PLACEHOLDER, 'http://studio.example.test', `${origin}/`,
    `${origin}/path`, `${origin}?query=1`, `${origin}#fragment`, 'https://user:password@studio.example.test'])('rejects an invalid build origin %s', value => {
    expect(() => parseApiOrigin(value)).toThrow();
  });
  it.each([`${origin}/other`, `${origin}/cmsPairLiveProductionDevice?key=example`,
    'https://user:password@studio.example.test/cmsPairLiveProductionDevice',
    'http://studio.example.test/cmsPairLiveProductionDevice'])('rejects unsafe pairing metadata %s', endpoint => {
    expect(() => pairingApiOrigin(endpoint)).toThrow();
  });
  it('accepts an explicit private preset without retaining caller-owned objects', () => {
    const supplied = fixture();
    const parsed = parseStudioConfiguration(supplied);
    expect(parsed).toEqual(supplied);
    supplied.inputs.headline = 999;
    expect(parsed.inputs.headline).toBe(501);
  });
  it('rejects missing configuration and the packaged placeholder example', () => {
    expect(() => parseStudioConfiguration(undefined)).toThrow();
    const example = JSON.parse(readFileSync(new URL('../../agents/vmix/windows/studio-config.example.json', import.meta.url), 'utf8'));
    expect(() => parseStudioConfiguration(example)).toThrow();
  });
  it('keeps connector title admission aligned with the shared server contract', () => {
    const valid = [fixture().titleFiles, { headline: 'Synthetic 東京.gtzip', name_title: 'Synthetic name.GTZIP' }];
    for (const titleFiles of valid) {
      expect(parseStudioConfiguration({ ...fixture(), titleFiles }).titleFiles).toEqual(parseStudioTitleFiles(titleFiles));
    }
    for (const headline of ['Show:headline.gtzip', 'Show*headline.gtzip', 'Show?headline.gtzip',
      'Show"headline.gtzip', 'Show<headline.gtzip', 'Show>headline.gtzip', 'Show|headline.gtzip',
      'Show\u007fheadline.gtzip', fixture().titleFiles.name_title.toUpperCase()]) {
      const titleFiles = { ...fixture().titleFiles, headline };
      expect(() => parseStudioConfiguration({ ...fixture(), titleFiles })).toThrow();
      expect(() => parseStudioTitleFiles(titleFiles)).toThrow();
    }
  });
  it.each([
    { vmixHost: '192.0.2.10' }, { vmixPort: 0 }, { vmixPort: 65536 }, { vmixPort: 1.5 },
    { apiAccessMode: 'REPLACE_ME' }, { password: 'synthetic-only' }, { schemaVersion: 2 },
    { inputs: { headline: 501, name_title: 501 } }, { overlayInputs: { headline: 500, name_title: 504 } },
    { backgroundInput: -1 }, { inputs: { headline: 501 } },
    { titleFiles: { headline: 'REPLACE_ME.gtzip', name_title: 'Example.gtzip' } },
    { titleFiles: { headline: '../Example.gtzip', name_title: 'Example.gtzip' } },
    { titleFiles: { headline: 'C:\\Example.gtzip', name_title: 'Example.gtzip' } },
    { titleFiles: { headline: 'Example.txt', name_title: 'Example.gtzip' } },
  ])('fails closed on an invalid preset %j', fields => {
    expect(() => parseStudioConfiguration({ ...fixture(), ...fields })).toThrow();
  });
  it('loads once from private files and emits only normalized noncredential setup data', () => {
    const directory = mkdtempSync(join(tmpdir(), 'studio-config-'));
    try {
      const preset = join(directory, 'studio-config.json'), pairing = join(directory, 'pairing.json');
      writeFileSync(preset, JSON.stringify(fixture()));
      writeFileSync(pairing, JSON.stringify({ pairingEndpoint: `${origin}/cmsPairLiveProductionDevice`, apiKey: 'synthetic-public-client-key' }));
      const cli = new URL('../../agents/vmix/read-studio-configuration.mjs', import.meta.url);
      const run = () => spawnSync(process.execPath, [fileURLToPath(cli), preset, pairing], { encoding: 'utf8' });
      const accepted = run();
      expect(accepted.status).toBe(0);
      expect(JSON.parse(accepted.stdout)).toEqual({ ...fixture(), apiOrigin: origin });
      expect(accepted.stdout).not.toContain('apiKey');
      writeFileSync(preset, JSON.stringify({ ...fixture(), inputs: { headline: 501, name_title: 501 } }));
      const rejected = run();
      expect(rejected.status).toBe(1);
      expect(rejected.stdout).toBe('');
      expect(rejected.stderr).toContain('missing or invalid');
      expect(rejected.stderr).not.toContain('501');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('keeps simulator templates and distinct layered targets explicitly synthetic', () => {
    expect(Object.values(simulatorMapping.inputs).map(input => input!.title)).toEqual(['synthetic-headline.gtzip', 'synthetic-name-title.gtzip']);
    expect(Object.values(layeredSimulatorMapping.inputs).map(input => input!.number)).toEqual([111, 112]);
    expect(Object.values(layeredSimulatorMapping.overlayInputs!).map(input => input!.number)).toEqual([113, 114]);
    expect(Object.values(layeredSimulatorMapping.overlayInputs!).every(input => input!.title.startsWith('Synthetic '))).toBe(true);
  });
});
