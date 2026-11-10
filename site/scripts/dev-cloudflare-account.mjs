/** Validate the active account against separately configured development intent.
 * @param {Record<string, string | undefined>} env
 */
export function devCloudflareAccount(env = process.env) {
  const expected = env.CMS_DEV_CLOUDFLARE_ACCOUNT_ID;
  if (!expected || !/^[a-f0-9]{32}$/.test(expected) || env.CLOUDFLARE_ACCOUNT_ID !== expected) {
    throw new Error("Development Cloudflare account configuration is missing or differs");
  }
  return expected;
}
