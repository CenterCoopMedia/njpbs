# Contributor rules

- Read the package README and the code you will change.
- Keep changes within the requested scope. Preserve unrelated work.
- Use a branch and a pull request. Describe the resulting behavior and checks.
- Keep credentials, unpublished private data, and private cloud account or
  namespace identifiers out of source, fixtures, commits, and pull request text.
  Use environment settings and deterministic `example.org` identities.
- Repository identity comes from explicit configuration. Name and numeric ID
  literals belong only in test fixtures; never add a default authorization target.
- Keep validation, authorization, and data-retention controls in place.
- Run focused checks before you submit a change. List changed or removed tests
  and explain why they changed. Do not weaken assertions to make a check pass.
- Check keyboard access, visible focus, labels, contrast, and reduced motion for
  interface changes. Follow the accessibility requirements in `docs/requirements/`.
- Use sentence case and clear, factual text. Omit generated-by and AI attribution
  lines from commits and pull request bodies.
- Deployment requires separate authorization. A source change does not authorize
  a production write, a deployment, or a change to repository secrets.
