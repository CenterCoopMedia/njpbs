import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, link } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";

function pathFor(root, key) {
  if (typeof key !== "string" || !/^[a-zA-Z0-9/_.-]+$/.test(key) ||
      key.split("/").some(part => !part || part === "." || part === "..")) throw Error("Invalid local key");
  return join(root, key);
}

async function privateParent(file) { await mkdir(dirname(file), { recursive: true, mode: 0o700 }); }

// Test/local destination boundary. Real adapters must implement these same
// streaming operations with private access and no deletion capability.
export function createFileBackupDestination(root) {
  return {
    async read(key) {
      try {
        const handle = await open(pathFor(root, key), "r");
        return handle.createReadStream();
      } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    },
    async putIfAbsent(key, body, { sizeBytes }) {
      const file = pathFor(root, key);
      await privateParent(file);
      const temporary = `${file}.${randomUUID()}.partial`;
      let bytes = 0;
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > sizeBytes ? Error("Object exceeds expected size") : null, chunk);
      } });
      try {
        await pipeline(Buffer.isBuffer(body) ? Readable.from([body]) : body, meter,
          createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
        if (bytes !== sizeBytes) throw Error("Incomplete object");
        try { await link(temporary, file); return true; }
        catch (error) { if (error.code === "EEXIST") return false; throw error; }
      } finally { await rm(temporary, { force: true }); }
    },
  };
}

// Local durable scan/job state, separate from source Firestore and the backup
// catalog. Use a fresh private directory on a local filesystem, not a web root.
export function createFileBackupState(root) {
  return {
    async read(key) {
      try { return JSON.parse(await readFile(pathFor(root, `${key}.json`), "utf8")); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    },
    async write(key, value) {
      const file = pathFor(root, `${key}.json`);
      await privateParent(file);
      const temporary = `${file}.${randomUUID()}.partial`;
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
      finally { await handle.close(); }
      try { await rename(temporary, file); }
      finally { await rm(temporary, { force: true }); }
    },
    async withLock(work) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const file = join(root, "worker.lock");
      const handle = await open(file, "a+", 0o600);
      try {
        // flock locks the shared open-file description inherited as fd 3.
        // This process retains it after flock exits; closing it (even on
        // SIGKILL/reboot) releases the lock. Never unlink the stable inode.
        const lock = spawnSync("flock", ["--nonblock", "--conflict-exit-code", "73", "3"],
          { stdio: ["ignore", "ignore", "ignore", handle.fd] });
        if (lock.status !== 0) throw Object.assign(Error("Backup state lock unavailable"), {
          code: lock.status === 73 ? "BACKUP_LOCK_HELD" : "BACKUP_LOCK_UNAVAILABLE",
        });
        // A crashed copy can leave a large staged MP4. No live step can own
        // these directories while we hold this destination's kernel lock.
        const staging = join(root, "staging");
        let entries = [];
        try { entries = await readdir(staging, { withFileTypes: true }); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.startsWith("viewing-copy-backup-")) {
            await rm(join(staging, entry.name), { recursive: true });
          }
        }
        return await work();
      } finally { await handle.close(); }
    },
  };
}

// Synthetic files are named by a digest of their exact bucket/key/version tuple.
// This is not a cloud source reader and accepts no URL or credential.
export function createFileBackupSource(root, identityKey) {
  return {
    async head(identity) {
      const file = pathFor(root, `${identityKey(identity)}.mp4`);
      const handle = await open(file, "r");
      try { return { sizeBytes: (await handle.stat()).size, versionId: identity.versionId }; }
      finally { await handle.close(); }
    },
    async read(identity) {
      const metadata = await this.head(identity);
      return { ...metadata, body: createReadStream(pathFor(root, `${identityKey(identity)}.mp4`)) };
    },
  };
}
