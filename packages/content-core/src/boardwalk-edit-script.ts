// Shared bytes: static, compiled and no-build public renderers emit this exact
// script. Its CSP hash is checked against the source in the contract tests.
export const BOARDWALK_EDIT_SCRIPT = `(function () {
  var button = document.querySelector('[data-boardwalk-edit]');
  if (!button) return;
  var host = location.hostname;
  var name = host === 'dev-public.example.org' ? 'bw_staff_dev' :
    (host === 'njpbs.org' || host === 'www.njpbs.org') ? 'bw_staff' :
    (host === 'localhost' || host === '127.0.0.1') ? 'bw_staff_local' : null;
  var origin = host === 'dev-public.example.org' ? 'https://dev-admin.example.org' :
    (host === 'localhost' || host === '127.0.0.1') ? 'http://' + host + ':5173' : 'https://admin.njpbs.org';
  function update() {
    var show = false;
    try {
      var hints = document.cookie.split(';').map(function (part) { return part.trim(); })
        .filter(function (part) { return name && part.indexOf(name + '=') === 0; });
      show = hints.length === 1 && hints[0] === name + '=1';
    } catch (_) { /* Cookie restrictions leave the reader view unchanged. */ }
    if (show) {
      var params = new URLSearchParams({ type: button.dataset.contentType, id: button.dataset.contentId });
      button.href = origin + '/open?' + params.toString();
    }
    button.hidden = !show;
    document.documentElement.toggleAttribute('data-boardwalk-edit-visible', show);
  }
  update();
  window.addEventListener('pageshow', update);
  window.addEventListener('focus', update);
})();`;

export const BOARDWALK_EDIT_SCRIPT_HASH = "sha256-eXKMS8gR/WCZpNe9ah+6h86pPn7rAz4PSKuJbosPg+s=";
