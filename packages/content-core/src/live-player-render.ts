import { escapeHtml } from "./content-model";
import { pbsAppUrl, pbsLivestreamEmbedUrl, pbsLivestreamWatchUrl } from "./launch-fallback";
import { pbsPlayerPermissions } from "./player-permissions";

// This integration belongs to the Live route, never to a saved content block.
export function renderLivePlayerFrame(mode: "public" | "editor" = "public"): string {
  return `<section class="public-page__player-section" aria-labelledby="pbs-player-heading">
    <figure class="public-page__player">
      <div class="public-page__player-header">
        <h2 id="pbs-player-heading">NJ PBS broadcast stream</h2>
        <span aria-hidden="true">PBS player</span>
      </div>
      <p class="public-page__player-keyboard-help" id="pbs-player-keyboard-help">
        ${mode === "editor" ? "Fixed PBS player. Open the live page to use playback controls."
          : '<a href="#pbs-player-alternative-app">Skip the PBS player and use alternate live options</a>, or press Tab from this link to focus the player frame, then press Tab again to enter it.'}
      </p>
      <div class="public-page__player-frame" role="group" aria-label="PBS livestream player frame" aria-describedby="pbs-player-keyboard-help" tabindex="0">
        ${mode === "editor" ? '<div class="live-canvas-player"><strong>PBS livestream player</strong><span>Playback is available on the live page.</span></div>'
          : `<iframe title="PBS livestream" aria-describedby="pbs-player-description pbs-player-keyboard-help" src="${escapeHtml(pbsLivestreamEmbedUrl)}" allow="${pbsPlayerPermissions("livestream")}" allowfullscreen loading="lazy"></iframe>`}
      </div>
      <p class="public-page__player-fallback" id="pbs-player-alternatives" data-player-fallback>
        If the player does not load, watch the live broadcast on the <a id="pbs-player-alternative-app" href="${escapeHtml(pbsAppUrl)}" rel="noopener" target="_blank">PBS app<span class="sr-only"> (opens in new tab)</span></a> or open the <a href="${escapeHtml(pbsLivestreamWatchUrl)}" rel="noopener" target="_blank">NJ PBS livestream<span class="sr-only"> (opens in new tab)</span></a>.
      </p>
      <figcaption id="pbs-player-description">The player is hosted by PBS and may use location rules, account services, and device settings managed by PBS.</figcaption>
    </figure>
  </section>`;
}
