// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { checkProductionContent } from "../scripts/public-contract-mode.mjs";
const read = (relativePath: string) => readFile(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

describe("CMS preview configuration", () => {
  it("keeps global public checks while exempting only the requested draft route", () => {
    const draft = {
      CMS_CONTENT_MODE: "draft",
      CMS_PREVIEW_PAGE_ID: "contact",
    };

    expect(checkProductionContent("contact", draft)).toBe(false);
    expect(checkProductionContent("watch", draft)).toBe(true);
    expect(
      checkProductionContent("home", {
        CMS_CONTENT_MODE: "draft",
        CMS_PREVIEW_PAGE_ID: "home",
      }),
    ).toBe(false);
    expect(checkProductionContent("contact", { CMS_CONTENT_MODE: "published" }))
      .toBe(true);
  });

  it("enables deployed admin controls only through the reviewed preview-readiness variables", async () => {
    const stagingWorkflow = await read(
      "../../.github/workflows/cms-staging-deploy.yml",
    );

    expect(stagingWorkflow).not.toContain('VITE_CMS_PREVIEW_ENABLED: "false"');
    expect(stagingWorkflow).toContain(
      "VITE_CMS_PREVIEW_ENABLED: ${{ vars.VITE_CMS_PREVIEW_ENABLED || 'false' }}",
    );
    expect(stagingWorkflow).toContain(
      "CMS_PREVIEW_ACCESS_VERIFIED: ${{ vars.CMS_PREVIEW_ACCESS_VERIFIED || 'false' }}",
    );
    expect(stagingWorkflow).toContain(
      "CMS_PREVIEW_SERIALIZER_READY: ${{ vars.CMS_PREVIEW_SERIALIZER_READY || 'false' }}",
    );
  });
});
