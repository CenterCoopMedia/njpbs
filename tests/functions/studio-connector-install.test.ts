import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PACKAGE_FILES, writePackageInventory } from '../../agents/vmix/package-inventory.mjs';

const sourceSha = 'a'.repeat(40);
const powershell = process.platform === 'win32' ? 'powershell.exe' : '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const onWindows = process.platform === 'win32' || existsSync(powershell);
const win = (path: string) => process.platform === 'win32' ? path : execFileSync('wslpath', ['-w', path], { encoding: 'utf8' }).trim();
const tempRoot = process.platform !== 'win32' && onWindows
  ? execFileSync('wslpath', ['-u', execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '[IO.Path]::GetTempPath()'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()], { encoding: 'utf8' }).trim() : tmpdir();
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
let directory: string, source: string, target: string;
function put(path: string, text: string) { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, text); }
async function payload(version: string) {
  for (const name of PACKAGE_FILES) put(join(source, name), `${version}:${name}`);
  put(join(source, 'runtime/node.exe'), `${version}:runtime`);
  put(join(source, 'runtime/node_modules/runtime-data.txt'), `${version}:nested runtime`);
  return writePackageInventory(source, sourceSha);
}
function run(body = '', processBody = '@()', install = true) {
  const script = join(directory, 'contract.ps1');
  writeFileSync(script, `$ErrorActionPreference = 'Stop'\nSet-StrictMode -Version Latest\n` +
    `. ${quote(win(resolve('agents/vmix/windows/install.ps1')))}\n` +
    `$env:LOCALAPPDATA = ${quote(win(join(directory, 'local')))}\n$env:USERPROFILE = ${quote(win(join(directory, 'user')))}\n` +
    `function Get-CimInstance { param($ClassName, $Filter) ${processBody} }\n` + body + '\n' +
    (install ? `try { $result = Install-Connector ${quote(win(source))} ${quote(win(target))}; Write-Output ('RESULT:' + $result) }\ncatch { Write-Output ('REFUSED:' + $_.Exception.Message); exit 3 }\n` : ''));
  // The operator input is a process boundary, supplied explicitly by each case.
  let text = readFileSync(script, 'utf8');
  text = text.replace('function Get-CimInstance', "function Read-Host { param($Prompt) Write-Host ('CONFIRM:' + $Prompt); return 'yes' }\nfunction Get-CimInstance");
  writeFileSync(script, text);
  try { return execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', win(script)],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error: any) { if (error.status === 3) return error.stdout.toString(); throw error; }
}

beforeEach(() => {
  // Windows PowerShell cannot execute a file from Linux /tmp. Keep every fixture
  // in one disposable Windows temp directory; never use the real account state.
  directory = mkdtempSync(join(tempRoot, 'njpbs-install-contract-'));
  source = join(directory, 'download with spaces'); target = join(directory, 'local/NJPBS/vmix-agent');
  mkdirSync(source); mkdirSync(join(directory, 'user'));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it('serializes a complete Windows package inventory, including nested runtime hashes', async () => {
  const manifest = await payload('new');
  expect(manifest.sourceSha).toBe(sourceSha);
  expect(Object.keys(manifest.files).sort()).toEqual([...PACKAGE_FILES, 'runtime/node.exe', 'runtime/node_modules/runtime-data.txt'].sort());
  expect(manifest.files['runtime/node.exe']).toBe(createHash('sha256').update('new:runtime').digest('hex'));
  expect(JSON.parse(readFileSync(join(source, 'package-files.json'), 'utf8'))).toEqual(manifest);
});

// Hosted Linux still checks the real Node serializer. On the Windows worker,
// execute that serialized contract through Windows PowerShell 5.1 as well.
describe.runIf(onWindows)('Windows setup package contract', () => {
  it('does not replace or back up an identical installed package', async () => {
    await payload('same'); expect(run()).toContain('RESULT:');
    const record = readFileSync(join(target, 'install-record.json'), 'utf8');
    const output = run();
    expect(output).toContain('already current');
    expect(output).not.toContain('CONFIRM:');
    expect(readFileSync(join(target, 'install-record.json'), 'utf8')).toBe(record);
    expect(readdirSync(resolve(target, '..')).some(name => name.startsWith('vmix-agent-previous-'))).toBe(false);
  });
  it('keeps the installed package if an operator declines replacement', async () => {
    await payload('old'); expect(run()).toContain('RESULT:');
    await payload('new');
    const output = run(`function Read-Host { param($Prompt) if (Test-Path -LiteralPath ${quote(win(join(resolve(target, '..'), 'vmix-agent-setup.lock')))}) { throw 'Lock held during confirmation' }; return '' }`);
    expect(output).toContain('Installed source:'); expect(output).toContain('Incoming source:');
    expect(output).toContain('REFUSED:Replacement not confirmed');
    expect(readFileSync(join(target, 'vmix-agent.cjs'), 'utf8')).toBe('old:vmix-agent.cjs');
    expect(readdirSync(resolve(target, '..')).some(name => name.startsWith('vmix-agent-previous-'))).toBe(false);
  });
  it('refuses a package changed while the operator was confirming, before moving files', async () => {
    await payload('old'); expect(run()).toContain('RESULT:'); await payload('new');
    const body = `function Read-Host { param($Prompt) [IO.File]::WriteAllText(${quote(win(join(target, 'vmix-agent.cjs')))}, 'changed during confirmation'); return 'yes' }`;
    expect(run(body)).toContain('REFUSED:Installed package changed during confirmation');
    expect(readFileSync(join(target, 'runtime/node.exe'), 'utf8')).toBe('old:runtime');
    expect(readdirSync(resolve(target, '..')).some(name => name.startsWith('vmix-agent-previous-'))).toBe(false);
  });
  it('refuses incoming metadata changed while the operator was confirming', async () => {
    await payload('old'); expect(run()).toContain('RESULT:'); await payload('new');
    const manifest = quote(win(join(source, 'package-files.json')));
    const body = `function Read-Host { param($Prompt) $m = [IO.File]::ReadAllText(${manifest}) | ConvertFrom-Json; $m.sourceSha = '${'b'.repeat(40)}'; [IO.File]::WriteAllText(${manifest}, ($m | ConvertTo-Json -Depth 5)); return 'yes' }`;
    expect(run(body)).toContain('REFUSED:Incoming package changed during setup');
    expect(readFileSync(join(target, 'vmix-agent.cjs'), 'utf8')).toBe('old:vmix-agent.cjs');
  });
  it('installs and upgrades every shipped file/runtime while keeping state and unknown files in place', async () => {
    await payload('old');
    expect(run()).toContain('RESULT:');
    const state = ['credential.dpapi', 'config.json', 'studio-inputs.json', 'sessions/show/journal.jsonl', 'operator-notes.txt'];
    for (const name of state) put(join(target, name), `keep:${name}`);
    // Legacy files need not be trusted: the approved migration quarantines them.
    put(join(target, 'setup.ps1'), 'legacy local modification');
    put(join(target, 'runtime/old-only.txt'), 'retain old runtime');
    await payload('new');
    const output = run();
    expect(output).toContain('RESULT:');
    expect(output).toContain('CONFIRM:');
    expect(output).toContain('Kept unrecognized local item: operator-notes.txt');
    const backups = readdirSync(resolve(target, '..')).filter(name => name.startsWith('vmix-agent-previous-'));
    expect(backups).toHaveLength(1);
    const backup = join(resolve(target, '..'), backups[0]);
    expect(readFileSync(join(backup, 'setup.ps1'), 'utf8')).toBe('legacy local modification');
    expect(readFileSync(join(backup, 'runtime/old-only.txt'), 'utf8')).toBe('retain old runtime');
    expect(existsSync(join(target, 'runtime/old-only.txt'))).toBe(false);
    for (const name of PACKAGE_FILES) expect(readFileSync(join(target, name))).toEqual(readFileSync(join(source, name)));
    for (const name of state) {
      expect(readFileSync(join(target, name), 'utf8')).toBe(`keep:${name}`);
      expect(existsSync(join(backup, name))).toBe(false);
    }
    expect(JSON.parse(readFileSync(join(target, 'install-record.json'), 'utf8'))).toMatchObject({ sourceSha, files: { 'runtime/node.exe': createHash('sha256').update('new:runtime').digest('hex') } });
  });
  it('allows another download with different per-download metadata', async () => {
    await payload('same'); expect(run()).toContain('RESULT:');
    put(join(source, 'pairing.json'), 'fresh pairing metadata'); put(join(source, 'source.json'), 'fresh source metadata');
    await writePackageInventory(source, sourceSha);
    expect(run()).toContain('RESULT:');
    expect(readFileSync(join(target, 'pairing.json'), 'utf8')).toBe('fresh pairing metadata');
  });
  it.each(['changed bundle', 'changed runtime', 'unknown inventory entry', 'missing file'])('refuses %s in the incoming package before moving the prior install', async kind => {
    await payload('old'); expect(run()).toContain('RESULT:');
    await payload('new');
    if (kind === 'changed bundle') put(join(source, 'vmix-agent.cjs'), 'tampered');
    if (kind === 'changed runtime') put(join(source, 'runtime/node.exe'), 'tampered runtime');
    if (kind === 'missing file') rmSync(join(source, 'studio.ps1'));
    if (kind === 'unknown inventory entry') {
      const file = join(source, 'package-files.json'), value = JSON.parse(readFileSync(file, 'utf8'));
      value.files['../outside'] = 'b'.repeat(64); writeFileSync(file, JSON.stringify(value));
    }
    expect(run()).toContain('REFUSED:');
    expect(readFileSync(join(target, 'vmix-agent.cjs'), 'utf8')).toBe('old:vmix-agent.cjs');
    expect(readdirSync(resolve(target, '..')).some(name => name.startsWith('vmix-agent-previous-'))).toBe(false);
  });
  it.each(['device lock', 'journal lock', 'running process', 'setup lock'])('refuses a %s without moving any installed file', async kind => {
    await payload('old'); expect(run()).toContain('RESULT:');
    await payload('new');
    if (kind === 'device lock') put(join(directory, 'user/.njpbs-vmix-agent/locks/device.lock'), '123');
    if (kind === 'journal lock') put(join(target, 'sessions/show/agent.lock'), '123');
    if (kind === 'setup lock') put(join(resolve(target, '..'), 'vmix-agent-setup.lock'), '123');
    const processes = kind === 'running process' ? "@([PSCustomObject]@{ExecutablePath=''; CommandLine='node vmix-agent.cjs --config config.json'})" : '@()';
    expect(run('', processes)).toContain('REFUSED:');
    expect(readFileSync(join(target, 'vmix-agent.cjs'), 'utf8')).toBe('old:vmix-agent.cjs');
  });
  it('restores the previous package after a replacement move fails', async () => {
    await payload('old'); expect(run()).toContain('RESULT:');
    put(join(target, 'credential.dpapi'), 'keep credential');
    await payload('new');
    const fault = `function Move-Item { param($LiteralPath, $Destination)\n` +
      `if ($LiteralPath -like '*incoming-*\\studio.ps1') { throw 'synthetic move failure' }\n` +
      `Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination\n}\n`;
    expect(run(fault)).toContain('REFUSED:synthetic move failure');
    expect(readFileSync(join(target, 'vmix-agent.cjs'), 'utf8')).toBe('old:vmix-agent.cjs');
    expect(readFileSync(join(target, 'runtime/node.exe'), 'utf8')).toBe('old:runtime');
    expect(readFileSync(join(target, 'credential.dpapi'), 'utf8')).toBe('keep credential');
    expect(existsSync(join(resolve(target, '..'), 'vmix-agent-setup.lock'))).toBe(false);
  });
  it('attempts every restore and keeps Start blocked if any rollback move fails', async () => {
    await payload('old'); expect(run()).toContain('RESULT:');
    put(join(target, 'credential.dpapi'), 'keep credential'); put(join(target, 'config.json'), '{}');
    await payload('new');
    const fault = `function Move-Item { param($LiteralPath, $Destination)\n` +
      `if ($LiteralPath -like '*incoming-*\\studio.ps1' -or $LiteralPath -like '*previous-*\\vmix-agent.cjs') { throw 'synthetic handle failure' }\n` +
      `Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination\n}\n`;
    const result = run(fault);
    expect(result).toContain('REFUSED:Connector install needs recovery');
    expect(result).toContain('Previous files:'); expect(result).toContain('Incoming files:');
    expect(existsSync(join(resolve(target, '..'), 'vmix-agent-setup.lock'))).toBe(true);
    // The first restore failed, but later entries must still be restored.
    expect(readFileSync(join(target, 'setup.ps1'), 'utf8')).toBe('old:setup.ps1');
    expect(readFileSync(join(target, 'runtime/node.exe'), 'utf8')).toBe('old:runtime');
    expect(readFileSync(join(target, 'credential.dpapi'), 'utf8')).toBe('keep credential');
    try { run(`& ${quote(win(resolve('agents/vmix/windows/start.ps1')))}\nexit $LASTEXITCODE`, '@()', false); throw new Error('Expected Start refusal'); }
    catch (error: any) {
      expect(error.status).toBe(1);
      expect(error.stdout.toString()).toContain('setup is in progress or needs recovery');
    }
  });
  it('keeps the legacy executable in backup if another file cannot be restored', async () => {
    await payload('old'); expect(run()).toContain('RESULT:'); await payload('new');
    const fault = `function Move-Item { param($LiteralPath, $Destination)\n` +
      `if ($LiteralPath -like '*incoming-*\\studio.ps1' -or $LiteralPath -like '*previous-*\\setup.ps1') { throw 'synthetic handle failure' }\n` +
      `Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination\n}\n`;
    expect(run(fault)).toContain('REFUSED:Connector install needs recovery');
    expect(existsSync(join(target, 'vmix-agent.cjs'))).toBe(false);
    const backup = readdirSync(resolve(target, '..')).find(name => name.startsWith('vmix-agent-previous-'))!;
    expect(readFileSync(join(resolve(target, '..'), backup, 'vmix-agent.cjs'), 'utf8')).toBe('old:vmix-agent.cjs');
    expect(existsSync(join(resolve(target, '..'), 'vmix-agent-setup.lock'))).toBe(true);
  });
  it.each([0, 1])('keeps Start blocked until the real setup self-test succeeds (exit %s)', async status => {
    await payload('self-test');
    for (const name of ['setup.ps1', 'install.ps1', 'start.ps1']) copyFileSync(resolve('agents/vmix/windows', name), join(source, name));
    const nodePath = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '(Get-Command node.exe).Source'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const node = process.platform === 'win32' ? nodePath : execFileSync('wslpath', ['-u', nodePath], { encoding: 'utf8' }).trim();
    copyFileSync(node, join(source, 'runtime/node.exe'));
    put(join(source, 'vmix-agent.cjs'), `process.exitCode=${status};`);
    await writePackageInventory(source, sourceSha);
    put(join(target, 'credential.dpapi'), 'keep credential'); put(join(target, 'config.json'), '{}');
    let output = '';
    try { output = run(`& ${quote(win(join(source, 'setup.ps1')))} -SelfTestOnly\nexit $LASTEXITCODE`, '@()', false); }
    catch (error: any) { expect(error.status).toBe(status); output = error.stdout.toString(); }
    expect(output).toContain(status === 0 ? 'PASS: The connector self-test passed' : 'The self-test did not pass. Start remains blocked');
    expect(existsSync(join(target, 'self-test.pending'))).toBe(status !== 0);
    if (status !== 0) {
      try { run(`& ${quote(win(resolve('agents/vmix/windows/start.ps1')))}\nexit $LASTEXITCODE`, '@()', false); throw new Error('Expected Start refusal'); }
      catch (error: any) { expect(error.status).toBe(1); expect(error.stdout.toString()).toContain('self-test has not passed'); }
    }
    expect(readFileSync(join(target, 'credential.dpapi'), 'utf8')).toBe('keep credential');
  });
  it.each(['missing file', 'setup lock'])('explains a %s refusal through the real setup entry point', async kind => {
    await payload('old'); expect(run()).toContain('RESULT:');
    for (const name of ['setup.ps1', 'install.ps1']) copyFileSync(resolve('agents/vmix/windows', name), join(source, name));
    await writePackageInventory(source, sourceSha);
    if (kind === 'missing file') rmSync(join(source, 'studio.ps1'));
    else put(join(resolve(target, '..'), 'vmix-agent-setup.lock'), 'recovery needed');
    try { run(`& ${quote(win(join(source, 'setup.ps1')))} -SelfTestOnly\nexit $LASTEXITCODE`, '@()', false); throw new Error('Expected setup refusal'); }
    catch (error: any) {
      expect(error.status).toBe(1);
      expect(error.stdout.toString()).toContain(kind === 'missing file' ? 'extracted package is incomplete' : 'Another setup is running or an earlier setup needs recovery');
    }
    expect(readFileSync(join(target, 'vmix-agent.cjs'), 'utf8')).toBe('old:vmix-agent.cjs');
  });
});
