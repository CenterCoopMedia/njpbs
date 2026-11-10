/** Activation shared by Post lead and entry media; never starts playback automatically. */
export function installPostMediaPlayers(document: Document): void {
  for (const root of document.querySelectorAll<HTMLElement>("[data-post-lead-player]")) {
    const button = root.querySelector<HTMLButtonElement>("[data-lead-play]");
    const template = root.querySelector<HTMLTemplateElement>("[data-lead-template]");
    if (!button || !template || root.dataset.playerInstalled) continue;
    root.dataset.playerInstalled = "true";
    button.addEventListener("click", () => {
      button.replaceWith(template.content.cloneNode(true)); template.remove();
      root.querySelector<HTMLIFrameElement>("iframe")?.focus();
    }, { once: true });
  }
}
