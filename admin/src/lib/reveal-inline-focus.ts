/** Reveal the complete focused control without moving the surrounding document. */
export function revealInlineFocus(container: HTMLElement, target: Element): void {
  const frame = container.getBoundingClientRect();
  const control = target.getBoundingClientRect();
  const left = frame.left + container.clientLeft;
  const right = left + container.clientWidth;
  const delta = control.left < left ? control.left - left
    : control.right > right ? control.right - right : 0;
  if (delta) container.scrollLeft += delta;
}
