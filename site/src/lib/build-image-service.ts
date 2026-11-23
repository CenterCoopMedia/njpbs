import type { LocalImageService } from "astro";
import sharpService, { type SharpImageServiceConfig } from "astro/assets/services/sharp";
import pLimit from "p-limit";

const remoteVariants = new WeakMap<object, Set<string>>();
const limitTransform = pLimit(4);

const buildImageService: LocalImageService<SharpImageServiceConfig & { maxRemoteVariants: number }> = {
  ...sharpService,
  async getURL(options, config, logger) {
    const url = await sharpService.getURL(options, config, logger);
    // Astro returns an unchanged URL for remote images outside the allowlist.
    if (typeof options.src !== "string" || url === options.src) return url;

    let variants = remoteVariants.get(config);
    if (!variants) {
      variants = new Set();
      remoteVariants.set(config, variants);
    }
    const max = config.service.config.maxRemoteVariants;
    if (!variants.has(url) && variants.size >= max) {
      throw new Error(`Build image budget reached (${max} distinct remote variants). Reduce distinct responsive image variants and rebuild.`);
    }
    // Astro keeps per-route references and emits each shared variant once.
    variants.add(url);
    return url;
  },
  transform: (...args) => limitTransform(() => sharpService.transform(...args)),
};

export default buildImageService;
