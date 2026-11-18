type SignupWindow = Window & typeof globalThis & { njpbsShowSignupForm?: () => void };

export function initNewsletterSignupEmbed(document: Document): void {
  const windowRef: SignupWindow | null = document.defaultView;
  const section = document.querySelector(".newsletter-signup-embed");
  const prompt = section?.querySelector<HTMLElement>("[data-signup-prompt]");
  const status = section?.querySelector<HTMLElement>("[data-signup-status]");
  const button = prompt?.querySelector<HTMLButtonElement>("[data-signup-show]");
  const target = section?.querySelector<HTMLElement>("[data-signup-target]");
  if (!windowRef || !prompt || !status || !button || !target) return;

  let failureTimer: number | undefined;
  let rendered = false;

  const waitForForm = (focus: boolean): void => {
    if (failureTimer !== undefined) windowRef.clearTimeout(failureTimer);
    status.textContent = "Loading the sign-up form…";
    if (focus) status.focus();
    prompt.hidden = true;
    failureTimer = windowRef.setTimeout(() => {
      status.textContent = "The sign-up form could not load. Refresh the page to try again.";
    }, 5000);
  };

  button.addEventListener("click", () => {
    if (!windowRef.njpbsShowSignupForm) {
      status.textContent = "The sign-up form is unavailable on this page.";
      status.focus();
      prompt.hidden = true;
      return;
    }
    waitForForm(true);
    windowRef.njpbsShowSignupForm();
  });

  if (document.querySelector("script[data-njpbs-wisepops]")) waitForForm(false);

  if (!windowRef.ResizeObserver) return;
  new windowRef.ResizeObserver(([entry]) => {
    const visible = (entry?.contentRect.height ?? 0) > 0;
    if (visible === rendered) return;
    rendered = visible;
    if (failureTimer !== undefined) windowRef.clearTimeout(failureTimer);
    if (visible && (document.activeElement === button || document.activeElement === status)) target.focus();
    prompt.hidden = visible;
    status.textContent = "";
  }).observe(target);
}
