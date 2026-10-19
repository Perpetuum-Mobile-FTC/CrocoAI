// PWA glue for every page (docs/design-pwa-ui.md §C): registers the service worker and keeps the
// "beforeinstallprompt" event so Acasă can show a discreet „Instalează aplicația” button.
// Classic script (no module) so the public pages can load it too; exposes window.crocoPwa.
(function () {
  var deferred = null;
  var listeners = [];
  function notify() { listeners.forEach(function (fn) { try { fn(); } catch (e) {} }); }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(function () { /* the app works without it */ });
    });
  }
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferred = e;
    notify();
  });
  window.addEventListener("appinstalled", function () { deferred = null; notify(); });

  var ua = navigator.userAgent || "";
  window.crocoPwa = {
    isStandalone: function () {
      return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
    },
    // iPhone/iPad Safari has no install prompt: the user adds the app from the Share menu.
    isIos: function () {
      return /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
    },
    canPrompt: function () { return !!deferred; },
    prompt: function () {
      if (!deferred) return Promise.resolve(false);
      var ev = deferred;
      deferred = null;
      ev.prompt();
      return ev.userChoice.then(function (c) { notify(); return c && c.outcome === "accepted"; });
    },
    // Returns an unsubscribe function.
    onChange: function (fn) {
      listeners.push(fn);
      return function () { listeners = listeners.filter(function (x) { return x !== fn; }); };
    },
  };
})();
