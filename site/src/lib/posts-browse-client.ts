/** Move the native directory into a dialog only when that enhancement is usable. */
export function enhancePostsBrowse(root: HTMLElement): void {
  if (root.dataset.postsBrowseEnhanced) return;
  const directory = root.querySelector<HTMLDetailsElement>("[data-browse-directory]");
  const trigger = root.querySelector<HTMLElement>("[data-browse-open]");
  const panel = root.querySelector<HTMLElement>("[data-browse-panel]");
  if (!directory || !trigger || !panel || typeof HTMLDialogElement === "undefined" || !HTMLDialogElement.prototype.showModal) return;
  root.dataset.postsBrowseEnhanced = "true";
  const dialog = document.createElement("dialog");
  dialog.className = "posts-browse__dialog";
  dialog.setAttribute("aria-labelledby", "posts-directory-title");
  dialog.append(panel); root.append(dialog);
  const filter = panel.querySelector<HTMLInputElement>("[data-browse-filter]")!;
  const status = panel.querySelector<HTMLElement>("[data-browse-status]")!;
  const groups = [...panel.querySelectorAll<HTMLDetailsElement>("[data-directory-group]")];
  let opener: HTMLElement = trigger;
  function search(query: string) {
    const expected = query.trim().toLocaleLowerCase("en-US");
    let total = 0;
    for (const group of groups) {
      let count = 0;
      group.querySelectorAll<HTMLElement>("[data-browse-term]").forEach(item => {
        item.hidden = !(item.dataset.browseTerm ?? "").includes(expected);
        if (!item.hidden) count++;
      });
      group.hidden = count === 0;
      group.open = Boolean(expected) && count > 0;
      const badge = group.querySelector<HTMLElement>("[data-group-count]")!;
      badge.textContent = String(count); badge.setAttribute("aria-label", `${count} ${expected ? "matching " : ""}${count === 1 ? "subject" : "subjects"}`);
      total += count;
    }
    status.textContent = expected ? total ? `${total} matching ${total === 1 ? "subject" : "subjects"}` : "No matching topics or categories" : `${status.dataset.categories} ${Number(status.dataset.categories) === 1 ? "category" : "categories"} · ${status.dataset.topics} ${Number(status.dataset.topics) === 1 ? "topic" : "topics"}`;
  }
  function open(from: HTMLElement, groupId?: string, query = "") {
    opener = from; filter.value = query; search(query); dialog.showModal();
    const selected = groups.find(group => group.dataset.directoryGroup === groupId);
    if (selected) { selected.open = true; selected.querySelector<HTMLElement>("summary")?.focus(); selected.scrollIntoView({ block: "nearest" }); }
    else filter.focus();
  }
  trigger.addEventListener("click", event => { event.preventDefault(); open(trigger); });
  root.querySelectorAll<HTMLElement>("[data-browse-group]").forEach(tile => {
    tile.addEventListener("click", event => { event.preventDefault(); open(tile, tile.dataset.browseGroup); });
    tile.setAttribute("aria-haspopup", "dialog");
  });
  const form = root.querySelector<HTMLFormElement>("[data-browse-search]")!;
  form.hidden = false;
  form.addEventListener("submit", event => {
    event.preventDefault(); open(form.querySelector<HTMLElement>("button")!, undefined, form.querySelector<HTMLInputElement>("input")!.value);
  });
  panel.querySelector<HTMLElement>("[data-browse-filter-label]")!.hidden = false;
  filter.addEventListener("input", () => search(filter.value));
  const close = panel.querySelector<HTMLButtonElement>("[data-browse-close]")!;
  close.hidden = false; close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); dialog.close(); } });
  dialog.addEventListener("close", () => opener.focus());
  trigger.setAttribute("aria-haspopup", "dialog");
}
