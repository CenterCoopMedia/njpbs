import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, realpath, lstat, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = resolve(fileURLToPath(new URL('../../', import.meta.url)));
async function originalFile(filename, bytes) {
  try { await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const metadata = await lstat(filename);
    assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size === Buffer.byteLength(bytes));
    assert.equal(await realpath(filename), filename);
    assert((await readFile(filename, 'utf8')) === bytes, 'Original recovery evidence changed');
  }
}

/** Filesystem boundary only. The caller supplies the original binding and
 * receipt bytes from the genuine SDK session. Local files grant no authority. */
export async function openRehearsalRecoveryEvidence(outputDirectory, binding, history) {
  const directory = resolve(outputDirectory);
  assert(directory !== checkout && !directory.startsWith(`${checkout}/`));
  // A crash can precede the original mkdir/packet write. Check the nearest
  // existing ancestor before creating descendants, including symlink aliases.
  let ancestor = directory;
  while (true) {
    try { assert.equal(await realpath(ancestor), ancestor); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = dirname(ancestor); }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  assert.equal(await realpath(directory), directory);
  const lock = join(directory, 'running'); await mkdir(lock);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await rm(lock, { recursive: true }); } };
  try {
    await originalFile(join(directory, 'packet.json'), JSON.stringify(binding, null, 2) + '\n');
    for (const { receipt, bytes } of history) {
      assert(/^[a-z][a-z0-9-]{0,95}$/.test(receipt.step));
      await originalFile(join(directory, `${receipt.step}.json`), bytes);
    }
    return Object.freeze({ close,
      async write(result) {
        assert(!closed && result.kind === 'recovery-only' && result.runId === binding.packet.runId &&
          result.sourceSha === binding.sourceCommitSha && result.scenarioPassed === false && result.controlsContinuous === false &&
          result.productionAdoption === false && result.measurementsAccepted === false);
        await originalFile(join(directory, 'recovery-only.json'), JSON.stringify(result, null, 2) + '\n');
      },
    });
  } catch (error) { await close(); throw error; }
}
