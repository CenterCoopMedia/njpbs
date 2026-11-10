// Deployment configuration is the trust anchor; never infer it from a caller.
export function repositoryIdentity(env = process.env) {
  const repository = env.CANONICAL_GITHUB_REPOSITORY;
  const id = env.CANONICAL_GITHUB_REPOSITORY_ID;
  if (typeof repository !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/.test(repository) ||
      /replace|placeholder/i.test(repository) || [".", ".."].includes(repository.split("/")[1]) || typeof id !== "string" || !/^[1-9][0-9]*$/.test(id) ||
      !Number.isSafeInteger(Number(id))) {
    throw new Error("Configure the canonical GitHub repository name and numeric ID");
  }
  return { repository, id };
}

export function repositoryMatches(repository, env = process.env, id) {
  try {
    const expected = repositoryIdentity(env);
    return typeof repository === "string" && repository.toLowerCase() === expected.repository.toLowerCase() &&
      (id === undefined || String(id) === expected.id);
  } catch {
    return false;
  }
}

export function workflowMatches(ref, workflow, env = process.env) {
  try {
    return ref === `${repositoryIdentity(env).repository}/.github/workflows/${workflow}@refs/heads/main`;
  } catch {
    return false;
  }
}
