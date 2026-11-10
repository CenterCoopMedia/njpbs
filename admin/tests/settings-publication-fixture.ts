import type { SettingsPublicationReceipt } from "../src/lib/functions";

export function settingsPublicationFixture(sourceVersion = 4, overrides: Partial<SettingsPublicationReceipt> = {}): SettingsPublicationReceipt {
  return { queueId: "settings-operation", originalOperationId: "settings-operation", transport: "public-context-no-build-v1",
    sourceVersion, rendererSha: "a".repeat(40), contextRevision: 2, contextDigest: "b".repeat(64),
    status: "pending", missingConsumers: ["pages", "posts", "home", "listings", "authors", "feed", "contentApi", "sitemap", "search"],
    ...overrides };
}
