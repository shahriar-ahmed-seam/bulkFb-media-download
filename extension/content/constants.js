/**
 * Shared constants used by the content-script bridge.
 *
 * `slug` is the project identifier the injected app uses as a `window[slug]`
 * namespace key and as the message channel name between the ISOLATED-world
 * content script and the MAIN-world page script.
 */
const hostMatches = [
  "https://www.facebook.com/*",
  "https://web.facebook.com/*",
];

const displayName = "Bulk FB Media Download";
const slug = "download-albums-for-facebook";

export { displayName as e, hostMatches as h, slug as p };
