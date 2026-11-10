export function renderScheduleNowNextFrame(
  variant: "full" | "compact",
): string {
  return `<section
  class="now-next now-next--${variant}"
  data-now-next
  data-now-next-variant="${variant}"
  aria-label="Live schedule"
>
  <div class="now-next__fallback" data-now-next-fallback>
    <p data-now-next-fallback-message>Live program status needs page scripting.</p>
    <a href="/schedule/">See the full schedule</a>
  </div>

  <div class="now-next__ready" data-now-next-ready hidden>
    <div class="now-next__main">
      <h2 class="now-next__heading">On now</h2>
      <p class="now-next__program-name" data-now-next-current-program>
        Current listing unavailable
      </p>

      <div class="now-next__current-row">
        ${variant === "full" ? '<a class="now-next__watch" href="/live/">Watch live</a>' : ""}
        <p class="now-next__time" data-now-next-current-time>Time unavailable</p>
      </div>

      <div class="now-next__progress-wrap">
        <div
          class="now-next__progress"
          data-now-next-progress
          role="progressbar"
          aria-label="Current program progress"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow="0"
          aria-valuetext="Schedule status unavailable"
        >
          <span class="now-next__progress-fill" aria-hidden="true"></span>
        </div>
        <div class="now-next__progress-meta">
          <span data-now-next-elapsed>Elapsed time unavailable</span>
          <span data-now-next-remaining>Remaining time unavailable</span>
        </div>
      </div>

      ${
        variant === "full"
          ? `<a
            class="now-next__gap-link"
            href="/schedule/"
            data-now-next-gap-link
            hidden
          >
            Full schedule
          </a>`
          : ""
      }
    </div>

    <aside class="now-next__next">
      <h2 class="now-next__heading">Up next</h2>
      <p class="now-next__time" data-now-next-up-next-time>Time unavailable</p>
      <p class="now-next__program-name" data-now-next-up-next-program>
        Next listing unavailable
      </p>

      ${variant === "compact" ? '<a class="now-next__schedule" href="/schedule/">Full schedule</a>' : ""}
    </aside>
  </div>
</section>`;
}
