// Cloudflare returns the deployment actively serving traffic first.
// https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/
export const activeWorkerDeploymentQuery = 'deployments?page=1&per_page=1';

export function isActiveWorkerDeploymentPage({ result, result_info: page }) {
  return Array.isArray(result?.deployments) && result.deployments.length <= 1 &&
    (page?.page === undefined || page.page === 1) && (page?.per_page === undefined || page.per_page === 1);
}
