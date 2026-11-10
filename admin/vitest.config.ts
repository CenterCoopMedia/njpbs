import { whatsNewIdPlugin } from "./build/whats-new-id";
import { repositoryFixture } from "../tests/helpers/repository-identity.mjs";
import { homeHeroCatalogPlugin } from "./build/home-hero-catalog";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  define: { __CANONICAL_GITHUB_REPOSITORY__: JSON.stringify(repositoryFixture.CANONICAL_GITHUB_REPOSITORY) },
  plugins: [whatsNewIdPlugin(), react(), homeHeroCatalogPlugin()],
  test: {
    environment: "jsdom",
    globals: true,
    maxWorkers: 2,
    // Runaway guard, not an expected duration. CI slots share a host, and a few
    // editor tests take 5 to 9 s when four slots run at once (#2669).
    testTimeout: 20_000,
    setupFiles: "./tests/setup.ts",
    // The visual and built-boot suites are Playwright, not vitest. Vitest would
    // otherwise collect their .spec.ts files and fail
    // on the @playwright/test import.
    exclude: [...configDefaults.exclude, "tests/visual/**", "tests/boot/**"],
  },
});
