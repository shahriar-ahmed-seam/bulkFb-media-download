/**
 * Content-script entry point (ISOLATED world).
 *
 * Registered via the manifest `content_scripts` entry. Dynamically imports the
 * ES-module bridge (content scripts cannot be modules directly) and hands it a
 * small performance marker.
 */
(function () {
  "use strict";

  const injectTime = performance.now();
  (async () => {
    const { onExecute } = await import(
      /* @vite-ignore */
      chrome.runtime.getURL("content/bridge.js")
    );
    onExecute?.({
      perf: { injectTime, loadTime: performance.now() - injectTime },
    });
  })().catch(console.error);
})();
