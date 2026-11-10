import { WorkerEntrypoint } from "cloudflare:workers";
import { getContainer } from "@cloudflare/containers";
import targets from "../functions/lib/publication-target.js";

/** Accessible only through an explicitly provisioned service binding. */
export class PublicationWake extends WorkerEntrypoint<Env> {
  async wake(commitSha: string, environment: string): Promise<void> {
    if (!/^[a-f0-9]{40}$/.test(commitSha) || commitSha !== this.env.PUBLICATION_COMMIT_SHA) {
      throw new Error("Cloud publication wake release differs");
    }
    if (environment !== targets.publicationTarget(this.env.CMS_DEPLOYMENT_ENVIRONMENT).environment) {
      throw new Error("Cloud publication wake target differs");
    }
    await getContainer(this.env.PUBLISHER, "publication-serializer").check();
  }
}
