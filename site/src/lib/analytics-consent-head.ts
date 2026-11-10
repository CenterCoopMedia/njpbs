import { ANALYTICS_CONSENT_GRANTED } from "./analytics-consent";

export const MAILCHIMP_CONSENT_SNIPPET = `(function () {
  var loaded = false;
  window.njpbsLoadMailchimp = function () {
    if (loaded) return;
    loaded = true;
    !function(c,h,i,m,p){m=c.createElement(h),p=c.getElementsByTagName(h)[0],m.async=1,m.src=i,p.parentNode.insertBefore(m,p)}(document,"script","https://chimpstatic.com/mcjs-connected/js/users/7f46611cb324e9e193acda7cc/7f380769f496c8086ff6d4141.js");
  };
  try {
    var decisions = document.cookie.split(";").map(function (part) {
      return part.trim();
    }).filter(function (part) {
      return part.indexOf("njpbs-consent=") === 0;
    });
    if (
      navigator.globalPrivacyControl !== true &&
      decisions.length === 1 &&
      decodeURIComponent(decisions[0].slice(14)) === ${JSON.stringify(ANALYTICS_CONSENT_GRANTED)}
    ) {
      window.njpbsLoadMailchimp();
    }
  } catch (error) {
    /* Keep Mailchimp off when the consent cookie cannot be read. */
  }
})();`;

export const WISEPOPS_SCRIPT_URL =
  "https://wisepops.net/h/WWRBSDzMPa/loader.js?v=3";

export const WISEPOPS_CONSENT_SNIPPET = `(function () {
  var loaded = false;
  var nonce = document.currentScript && document.currentScript.nonce;

  window.njpbsLoadWisepops = function () {
    if (loaded) return;
    loaded = true;

    window.wisepops = window.wisepops || function () {
      (window.wisepops.q = window.wisepops.q || []).push(arguments);
    };
    window.wisepops.l = Date.now();
    window.wisepops._nonce = nonce;
    window.wisepops("options", { defaultConsent: "denied" });
    window.wisepops("consent", "granted");

    var script = document.createElement("script");
    var firstScript = document.getElementsByTagName("script")[0];
    script.setAttribute("data-cfasync", "false");
    script.setAttribute("data-njpbs-wisepops", "");
    if (nonce) script.nonce = nonce;
    script.defer = true;
    script.src = ${JSON.stringify(WISEPOPS_SCRIPT_URL)};
    firstScript.parentNode.insertBefore(script, firstScript);
  };

  window.njpbsStopWisepops = function () {
    if (!loaded) return;
    window.location.reload();
  };

  try {
    var decisions = document.cookie.split(";").map(function (part) {
      return part.trim();
    }).filter(function (part) {
      return part.indexOf("njpbs-consent=") === 0;
    });
    if (
      navigator.globalPrivacyControl !== true &&
      decisions.length === 1 &&
      decodeURIComponent(decisions[0].slice(14)) === ${JSON.stringify(ANALYTICS_CONSENT_GRANTED)}
    ) {
      window.njpbsLoadWisepops();
    }
  } catch (error) {
    /* Keep Wisepops off when the consent cookie cannot be read. */
  }
})();`;

export const ANALYTICS_DEFAULT_SNIPPET = `      (function () {
        window.dataLayer = window.dataLayer || [];
        window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
        window.gtag("consent", "default", {
          analytics_storage: "denied",
          ad_storage: "denied",
          ad_user_data: "denied",
          ad_personalization: "denied",
          wait_for_update: 500
        });
      })();`;
