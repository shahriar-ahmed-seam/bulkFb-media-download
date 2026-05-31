/**
 * Content-script bridge (ISOLATED world).
 *
 * Relays messages addressed to this extension's channel from the background
 * service worker into the MAIN-world page via `window.postMessage`, so the
 * injected app can receive them.
 */
import { p as channel } from "./constants.js";

function listen(name) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.from === name) {
      window.postMessage(
        {
          from: message.from,
          payload: message.payload,
          callbackId: message.callbackId,
        },
        "*",
      );
    }
  });
}

listen(channel);
