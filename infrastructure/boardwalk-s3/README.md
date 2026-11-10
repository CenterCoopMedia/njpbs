# S3

The templates create source-scoped AWS roles for an explicitly configured Google runtime identity. Use short-lived federation. Keep the token audience, allowed object prefixes, read-only source boundaries, and secure-transport conditions intact. Configure the project number, account, buckets, and identity claims before deployment. The runtime parameter example keeps each source disabled until its index and authorization checks are ready.

Run the adjacent focused tests before changing a template or worker. Deployment needs separate authorization and configured credentials.
