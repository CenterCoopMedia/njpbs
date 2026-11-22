export interface ScheduleCopy {
  version: 1;
  heading: string;
  introduction: string;
}

export const DEFAULT_SCHEDULE_COPY = Object.freeze({
  version: 1,
  heading: "TV schedule",
  introduction: "Now, next, and upcoming NJ PBS listings.",
} satisfies ScheduleCopy);

export function parseScheduleCopy(pageId: string, value: unknown): ScheduleCopy | undefined {
  if (value === undefined) return undefined;
  if (pageId !== "schedule") throw new Error("Schedule copy belongs only to the Schedule page.");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Schedule copy must include its ownership version, heading and introduction.");
  }
  const copy = value as Record<string, unknown>;
  if (copy.version !== 1 || Object.keys(copy).some(key => !["version", "heading", "introduction"].includes(key))) {
    throw new Error("The Schedule copy ownership version or fields are invalid.");
  }
  const { heading, introduction } = copy;
  if (typeof heading !== "string" || !heading.trim() || typeof introduction !== "string" || !introduction.trim()) {
    throw new Error("Enter a heading and introduction for the Schedule page.");
  }
  return { version: 1, heading, introduction };
}
