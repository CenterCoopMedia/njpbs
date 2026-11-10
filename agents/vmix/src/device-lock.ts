import { mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Shared across session journal directories for this Windows service account. */
export class DeviceLock {
  private file: string;
  constructor(directory: string, deviceId: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) throw new Error('Invalid device identity');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, `${deviceId}.lock`);
    const fd = openSync(this.file, 'wx', 0o600);
    try { writeFileSync(fd, String(process.pid)); fsyncSync(fd); } finally { closeSync(fd); }
  }
  close() { unlinkSync(this.file); }
}
