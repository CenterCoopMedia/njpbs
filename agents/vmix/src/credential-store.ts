import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type DeviceCredential = { apiKey: string; refreshToken: string; deviceId?: string;
  vmix?: { username: string; password: string } };
export class CredentialStorageError extends Error {
  constructor(readonly reason: 'acl' | 'dpapi' | 'exists' | 'timeout') {
    super(`Windows credential storage failed (${reason})`);
  }
}
export function credentialPath(): string {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) throw new Error('Windows account storage is required');
  return join(process.env.LOCALAPPDATA, 'NJPBS', 'vmix-agent', 'credential.dpapi');
}
export function assertUnpaired() {
  if (existsSync(credentialPath())) throw new CredentialStorageError('exists');
}

// Static PowerShell only. Secrets travel on stdin/stdout pipes, never arguments.
const setup = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$path = $env:NJPBS_VMIX_CREDENTIAL_PATH
`;
const protect = String.raw`
if ([IO.File]::Exists($path)) { exit 22 }
$failure = 20
$directory = [IO.Path]::GetDirectoryName($path)
$directoryInfo = [IO.Directory]::CreateDirectory($directory)
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.SetOwner($sid)
foreach ($identity in @($sid, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
# Persist only the modified owner and DACL. Set-Acl also requests SACL access,
# which needs SeSecurityPrivilege even when no audit rules were changed.
$directoryInfo.SetAccessControl($acl)
$failure = 21
$bytes = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())
$encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
try { $stream = New-Object IO.FileStream($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
catch { if ([IO.File]::Exists($path)) { exit 22 }; throw }
try { $stream.Write($encrypted, 0, $encrypted.Length); $stream.Flush($true) } finally { $stream.Dispose() }
`;
const unprotect = String.raw`
$encrypted = [IO.File]::ReadAllBytes($path)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, 'CurrentUser')
$stream = [Console]::OpenStandardOutput()
$stream.Write($bytes, 0, $bytes.Length)
$stream.Flush()
`;
async function dpapi(script: string, input = ''): Promise<string> {
  const path = credentialPath();
  return new Promise((resolve, reject) => {
    // Use the system executable, never a PATH-resolved provider.
    const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const command = "$failure = 21\ntry {\n" + setup + script + "\n} catch { exit $failure }";
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, NJPBS_VMIX_CREDENTIAL_PATH: path },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 15_000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64_000) child.kill();
      else chunks.push(chunk);
    });
    child.on('error', () => { clearTimeout(timer); reject(new CredentialStorageError('dpapi')); });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      if (!timedOut && code === 0 && size <= 64_000) return resolve(Buffer.concat(chunks).toString('utf8'));
      const reason = timedOut ? 'timeout' : code === 20 ? 'acl' : code === 22 ? 'exists' : 'dpapi';
      reject(new CredentialStorageError(reason));
    });
    child.stdin.end(input);
  });
}
export async function storeCredential(credential: DeviceCredential) { await dpapi(protect, JSON.stringify(credential)); }
export async function loadCredential(): Promise<DeviceCredential> {
  const value = JSON.parse(await dpapi(unprotect));
  if (typeof value.apiKey !== 'string' || typeof value.refreshToken !== 'string' || !value.refreshToken ||
      typeof value.deviceId !== 'string') throw new Error('Invalid stored device credential');
  return value;
}
