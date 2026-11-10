"use strict";

function isDisabled(control) {
  return control.disabled || control.getAttribute("aria-disabled") === "true";
}

function setDisabled(control, disabled) {
  if (control.getAttribute("role") === "button") {
    control.setAttribute("aria-disabled", String(disabled));
    control.classList.toggle("is-disabled", disabled);
    control.tabIndex = disabled ? -1 : 0;
  } else control.disabled = disabled;
}

// UXP's native button chrome covers custom colors. Keep the branded control's
// keyboard and disabled behavior explicit instead of drawing over that chrome.
function prepareButton(control) {
  control.setAttribute("role", "button");
  setDisabled(control, isDisabled(control));
  let spacePressed = false;
  control.addEventListener("click", event => {
    if (isDisabled(control)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    } else control.focus();
  }, true);
  control.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (isDisabled(control) || event.repeat) return;
    if (event.key === "Enter") control.click();
    else spacePressed = true;
  });
  control.addEventListener("keyup", event => {
    if (event.key !== " ") return;
    event.preventDefault();
    // Premiere can consume Space for playback and deliver only its keyup.
    // Do not activate a second action when the host already handled that press.
    const activate = spacePressed && !isDisabled(control);
    spacePressed = false;
    if (activate) control.click();
  });
  control.addEventListener("blur", () => { spacePressed = false; });
  return control;
}

module.exports = { prepareButton, setDisabled, isDisabled };
