import { developmentInstallCredential, developmentInstallToken } from './development-install-credentials.mjs';

/** Operator CODE reads use fd4; deployed Functions keep their own secret reader. */
export function reserveEnrollmentEdgeSecret() {
  if (Object.hasOwn(process.env, 'CMS_EDGE_ORIGIN_SECRET')) throw new Error('Enrollment edge credential refused');
  return developmentInstallCredential(4, developmentInstallToken);
}
export async function readEnrollmentEdgeSecret() {
  let pipe;
  try {
    pipe = reserveEnrollmentEdgeSecret();
    return await pipe.read();
  } catch { throw new Error('Enrollment edge credential refused'); }
  finally { pipe?.close(); }
}
