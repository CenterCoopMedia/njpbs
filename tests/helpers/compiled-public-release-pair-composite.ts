import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { publicReleaseCodePackFixture } from "./public-release-code-pack";
import { sealPublicReleasePairRenderer } from "../../site/scripts/public-release-pair-renderer-release.mjs";
/** Compile commands own the exact source seal. The source-input bytes are the
 * documented immutable build parameter, bound only after the real baseline
 * fixture exists. No compiled source or engine bytes are replaced. */
export async function compiledPublicReleasePairCompositeArtifacts(directory: string, sourceInputs: Uint8Array, extraDist: Record<string, string> = {}) {
  const compiled = fileURLToPath(new URL("../../site/.public-post-renderer/", import.meta.url));
  const release = JSON.parse(await readFile(path.join(compiled, "renderer-release.json"), "utf8"));
  const artifacts = await publicReleaseCodePackFixture(directory, release.rendererSha, sourceInputs, extraDist);
  // Same final data-binding and sealing step as the pair compiler's
  // --source-inputs parameter, after the fixture's baseline is available.
  await writeFile(path.join(compiled, "pair-source-inputs.json"), sourceInputs);
  await sealPublicReleasePairRenderer(compiled, release.rendererSha);
  await rm(artifacts.compiledDirectory, { recursive: true, force: true });
  await cp(compiled, artifacts.compiledDirectory, { recursive: true });
  const seal = await sealPublicReleasePairRenderer(artifacts.compiledDirectory, release.rendererSha);
  return { ...artifacts, pair: { commitSha: release.rendererSha, rendererDigest: seal.rendererDigest } };
}
