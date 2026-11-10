import { fstatSync, lstatSync } from "node:fs";
import { CmsPublicationSerializerOperatorError } from "./cms-publication-credentials";

export function assertCmsPublicationSerializerLock(
  fd = 5,
  lockPath = "/run/njpbs-cms-publisher/serializer.lock",
): void {
  let descriptor;
  let lock;
  try {
    descriptor = fstatSync(fd);
    lock = lstatSync(lockPath);
  } catch {
    throw new CmsPublicationSerializerOperatorError("The CMS publication serializer lock is missing");
  }
  if (
    !descriptor.isFile() ||
    !lock.isFile() ||
    lock.isSymbolicLink() ||
    descriptor.dev !== lock.dev ||
    descriptor.ino !== lock.ino ||
    lock.uid !== process.geteuid?.() ||
    (lock.mode & 0o077) !== 0
  ) {
    throw new CmsPublicationSerializerOperatorError("The CMS publication serializer lock is invalid");
  }
}
