import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { preparePairedAdminArtifact, pairedAdminArtifactContents } from '../../scripts/lib/paired-admin-pages-artifact.mjs';
import { DEV_TARGETS } from '../../scripts/assert-dev-cms-targets.mjs';
const api = createRequire(import.meta.url)('../../functions/lib/cms-preview-pair.js');

/** Only the external Pages/Functions HTTP boundary is a fixture. Native sealed
 * artifacts, parsers, publication owner and SDK journals run unchanged. */
export async function rehearsalAdminProvider({ directory, candidateArtifact, functions, cmsApiDeployment, servedArtifact }: any) {
  let artifact = servedArtifact;
  if (!artifact) {
    const baselineDirectory = join(directory, 'served-baseline'); await mkdir(baselineDirectory);
    await writeFile(join(baselineDirectory, 'index.html'), '<html>Served fixture baseline</html>');
    await writeFile(join(baselineDirectory, 'admin-status.json'), JSON.stringify({ schemaVersion: 2, status: 'current', environment: 'Development',
      build: { revision: 'a'.repeat(40) } }));
    artifact = await preparePairedAdminArtifact({ directory: baselineDirectory, sourceSha: 'a'.repeat(40), environment: 'development' });
  }
  const project = { id: '33333333-3333-4333-8333-333333333333', name: DEV_TARGETS.CMS_ADMIN_PAGES,
    production_branch: 'main', deployment_configs: { production: { compatibility_date: '2026-09-09' } } };
  const deploymentId = '11111111-1111-4111-8111-111111111111';
  const base = `/client/v4/accounts/${DEV_TARGETS.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${DEV_TARGETS.CMS_ADMIN_PAGES}`;
  const calls: Array<{ method: string; path: string }> = [];
  const admin = { authorized: true, allowLocalEmulator: true, prepared: candidateArtifact, baseline: { artifact, deploymentId },
    target: { environment: 'development', projectId: 'njpbs-site-dev', accountId: DEV_TARGETS.CLOUDFLARE_ACCOUNT_ID,
      pagesProjectId: project.id, branch: 'main', configurationDigest: api.digest({ id: project.id, name: project.name,
        production_branch: project.production_branch, production: project.deployment_configs.production }) },
    readCloudflareToken: () => 'fixture-cloudflare', readGoogleToken: () => 'fixture-google', readAccessHeaders: () => ({}),
    fetchImpl: async (raw: string, init: RequestInit = {}) => {
      const url = new URL(raw), method = init.method ?? 'GET'; calls.push({ method, path: url.origin + url.pathname });
      if (method !== 'GET') throw new Error('Unexpected provider write escaped the named rehearsal fault');
      if (url.origin === 'https://cloudfunctions.googleapis.com' && url.pathname === '/v2/projects/njpbs-site-dev/locations/us-central1/functions') {
        return Response.json({ functions });
      }
      if (url.origin === 'https://api.cloudflare.com' && url.pathname.endsWith(`/workers/scripts/${DEV_TARGETS.CMS_API_WORKER}/deployments`)) {
        return Response.json({ success: true, result: { deployments: [{ id: cmsApiDeployment, versions: [{ version_id: "77777777-7777-4777-8777-777777777777", percentage: 100 }] }] } });
      }
      if (url.origin === DEV_TARGETS.CMS_ADMIN_ORIGIN) {
        const file = pairedAdminArtifactContents(artifact).files.find((entry: any) =>
          (entry.path.endsWith('/index.html') ? entry.path.slice(0, -10) : entry.path.endsWith('.html') ? entry.path.slice(0, -5) : entry.path) === url.pathname);
        if (!file) throw new Error('Unknown fixture Admin file');
        return new Response(file.bytes, { headers: { 'content-type': file.contentType } });
      }
      let result;
      if (url.origin !== 'https://api.cloudflare.com') throw new Error('Unexpected fixture provider host');
      if (url.pathname === base) result = { ...project, canonical_deployment: { id: deploymentId } };
      else if (url.pathname === base + `/deployments/${deploymentId}`) result = { id: deploymentId, project_id: project.id,
        project_name: project.name, environment: 'production', latest_stage: { name: 'deploy', status: 'success' },
        deployment_trigger: { metadata: { branch: 'main', commit_hash: artifact.sourceSha, commit_message: 'fixture-baseline' } } };
      else if (url.pathname === base + '/upload-token') result = { jwt: 'fixture-asset-jwt' };
      else throw new Error('Unexpected fixture provider path');
      return Response.json({ success: true, result });
    } };
  return { admin, calls };
}
