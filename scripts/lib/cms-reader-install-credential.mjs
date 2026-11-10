import { fstatSync } from "node:fs";
import { Socket } from "node:net";

const refuse = () => { throw new Error("CMS reader credential unavailable"); };
const FDS = ["4", "12", "13", "14"];

export function readerCredentialPipeIdentity(fd) {
  if (!FDS.includes(String(fd))) refuse();
  const stat = fstatSync(fd, { bigint: true });
  if ((!stat.isFIFO() && !stat.isSocket()) || stat.ino <= 0n) refuse();
  return { device: String(stat.dev), inode: String(stat.ino) };
}

export function parseReaderCredentialPipeManifest(text) {
  if (typeof text !== "string" || text.length > 4096) refuse();
  const value = JSON.parse(text);
  if (!value || Array.isArray(value) || !Object.keys(value).length || Object.keys(value).some(fd => !FDS.includes(fd))) refuse();
  for (const identity of Object.values(value)) {
    if (!identity || Object.keys(identity).sort().join() !== "device,inode" ||
        ![identity.device, identity.inode].every(part => typeof part === "string" && /^\d{1,30}$/.test(part))) refuse();
  }
  return value;
}

// Reserve the parent's exact inherited pipe before opening an SDK connection.
// Metadata alone is checked here; bytes are consumed only at dispatch. Missing
// or recycled descriptors cannot turn an internal socket into a credential pipe.
export function readerCredentialPipe(fd, signal, identity) {
  if (!identity || Object.keys(identity).sort().join() !== "device,inode") refuse();
  const actual = readerCredentialPipeIdentity(fd);
  if (actual.device !== identity.device || actual.inode !== identity.inode) refuse();
  const stream = new Socket({ fd, readable: true, writable: false, pauseOnCreate: true });
  stream.on("error", () => {});
  let pending, closed = false;
  const read = async () => {
    const chunks = []; let size = 0;
    const stop = () => stream.destroy(new Error("CMS reader credential unavailable"));
    const timer = setTimeout(stop, 10_000); signal?.addEventListener("abort", stop, { once: true });
    try {
      signal?.throwIfAborted();
      for await (const part of stream) { size += part.length; if (size > 32768) refuse(); chunks.push(Buffer.from(part)); }
      const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
      if (!/^[\x21-\x7e]{1,32768}$/.test(value)) refuse();
      return value;
    } catch { refuse(); }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", stop); chunks.forEach(chunk => chunk.fill(0)); stream.destroy(); }
  };
  return Object.freeze({ read() { if (closed) refuse(); signal?.throwIfAborted(); pending ??= read(); return pending; },
    close() { closed = true; stream?.destroy(); pending = null; } });
}
