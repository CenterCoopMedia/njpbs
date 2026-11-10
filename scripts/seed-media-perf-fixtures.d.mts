export function seedMediaPerfFixtures(options?: {
  env?: Record<string, string | undefined>;
  argv?: string[];
}): Promise<{ assets: number; categories: number; email: string }>;
