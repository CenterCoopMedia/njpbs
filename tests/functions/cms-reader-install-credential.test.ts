import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";

const childProgram = `
const { readerCredentialPipe, readerCredentialPipeIdentity } = await import(process.argv[1]);
const controller = new AbortController();
let source;
if (process.argv[2] === 'cancel') setTimeout(() => controller.abort(), 50);
try {
  const mode=process.argv[2];
  const identity=mode==='missing' ? undefined : readerCredentialPipeIdentity(4);
  if(mode==='mismatch') identity.inode='0';
  source=readerCredentialPipe(4, controller.signal, identity);
  const first = await source.read(), second = await source.read();
  source.close(); let closed = false;
  try { await source.read(); } catch { closed = true; }
  process.stdout.write(JSON.stringify({ accepted: true, length: first.length, same: first === second, closed }));
} catch {
  source?.close();
  if (['missing','mismatch'].includes(process.argv[2])) {
    const {Socket}=await import('node:net'); const original=new Socket({fd:4,readable:true,writable:false});
    let recoveredLength=0; for await(const part of original) recoveredLength+=part.length;
    process.stdout.write(JSON.stringify({accepted:false,recoveredLength}));
  } else process.stdout.write(JSON.stringify({ accepted: false }));
}
`;
async function consume(mode: string, payload?: string) {
  const module = new URL("../../scripts/lib/cms-reader-install-credential.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childProgram, module, mode], { stdio: ["ignore", "pipe", "pipe", "ignore", "pipe"] });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  child.stdout!.on("data", part => stdout.push(part)); child.stderr!.on("data", part => stderr.push(part));
  const pipe = child.stdio[4] as import("node:stream").Writable;
  pipe.on("error", () => {});
  if (payload !== undefined) pipe.end(payload);
  const [code] = await once(child, "exit"); pipe.destroy();
  expect(code).toBe(0); expect(Buffer.concat(stderr).length).toBe(0);
  return JSON.parse(Buffer.concat(stdout).toString());
}
it("consumes a bounded inherited pipe at use, shares that original value and permanently closes it", async () => {
  expect(await consume("read", "fixture-only-token\n")).toEqual({ accepted: true, length: 18, same: true, closed: true });
});
it.each(["", "x".repeat(32769), "fixture\nheader"])("refuses malformed or oversized inherited bytes without exposing them", async value => {
  expect(await consume("read", value)).toEqual({ accepted: false });
});
it("cancels an unfinished producer without waiting for an inherited blocking read", async () => {
  expect(await consume("cancel")).toEqual({ accepted: false });
});
it.each(["missing", "mismatch"])("refuses %s parent pipe identity without reading or destroying the original descriptor", async mode => {
  expect(await consume(mode, "fixture-only-token\n")).toEqual({ accepted: false, recoveredLength: 19 });
});
