/**
 * Background service worker.
 *
 * Responsibilities:
 *   1. Remove Facebook's Content-Security-Policy headers so the MAIN-world
 *      injected scripts are allowed to run.
 *   2. Register the injected content scripts (proxy at document_start, the
 *      vendor + app bundles at document_end).
 *   3. Seed the per-tab window globals the UI bootstrap expects (identity +
 *      an all-unlocked feature config).
 *   4. Provide a small chrome.storage-backed message API for resume cursors,
 *      downloaded-file IDs and persisted UI settings.
 *
 * This build is fully client-side: there are no remote auth, subscription or
 * telemetry calls.
 */

const HOST_MATCHES = [
  "https://www.facebook.com/*",
  "https://web.facebook.com/*",
];

const EXTENSION_SLUG = "download-albums-for-facebook";

function matchPatternToRegexFilter(pattern) {
  if (pattern === "<all_urls>") return ".*";
  // Convert a Chrome match pattern (e.g. https://www.facebook.com/*) into a
  // safe, anchored RE2-compatible regex. Forward slashes need no escaping.
  const escaped = pattern.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
  return "^" + escaped.replace(/\*/g, ".*") + "$";
}

function matchPattern(pattern, url) {
  try {
    if (!url) return false;
    if (pattern === "<all_urls>") return true;
    return new RegExp(matchPatternToRegexFilter(pattern)).test(url);
  } catch {
    return false;
  }
}

function getIdentityPayload() {
  const manifest = chrome.runtime.getManifest();
  return {
    id: chrome.runtime.id,
    slug: EXTENSION_SLUG,
    extensionName: manifest.name,
    version: manifest.version,
    icons: manifest.icons,
    extensionFolderUri: chrome.runtime.getURL("/"),
    isProdMode: false,
  };
}

async function injectGlobalsIntoTab(tabId) {
  const data = getIdentityPayload();
  try {
    await chrome.scripting.executeScript({
      injectImmediately: true,
      world: "MAIN",
      target: { tabId, allFrames: true },
      func: (payload) => {
        try {
          // 1) Identity / metadata object keyed by the hyphenated slug.
          const slug = payload.slug;
          const existingIdentity = window[slug];
          if (existingIdentity && typeof existingIdentity === "object") {
            Object.assign(existingIdentity, payload);
          } else {
            window[slug] = payload;
          }

          // 2) Runtime feature config keyed by the underscored slug. Every
          //    feature is unlocked (needUpgrade: false, unlimited fetch).
          const cfgKey = slug.replace(/-/g, "_");
          const cfg = window[cfgKey];
          if (!cfg || typeof cfg !== "object") window[cfgKey] = {};
          const cfgObj = window[cfgKey];

          if (!cfgObj.fetchLimit || typeof cfgObj.fetchLimit !== "object") {
            cfgObj.fetchLimit = { limitation: 0 };
          }
          if (typeof cfgObj.fetchLimit.limitation !== "number") {
            cfgObj.fetchLimit.limitation = 0;
          }

          const featureKeys = [
            "carouselDownloader",
            "imagesFormatAs",
            "folderNameRule",
            "fileNameFormats",
            "resumeDownloading",
            "skipDownloadedFiles",
            "downloadCaption",
          ];
          for (const key of featureKeys) {
            const val = cfgObj[key];
            if (!val || typeof val !== "object") {
              cfgObj[key] = { needUpgrade: false };
            } else if (typeof val.needUpgrade !== "boolean") {
              val.needUpgrade = false;
            }
          }
        } catch {
          // best-effort only
        }
      },
      args: [data],
    });
  } catch {
    // best-effort only (tab may be gone or the URL restricted)
  }
}

async function injectGlobalsIntoExistingTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: HOST_MATCHES });
    await Promise.all(
      tabs
        .map((t) => t.id)
        .filter((id) => typeof id === "number")
        .map((id) => injectGlobalsIntoTab(id)),
    );
  } catch {
    // best-effort only
  }
}

// ── 1. CSP header removal ───────────────────────────────────────────────────
(async () => {
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existing.map((r) => r.id);
    const addRules = HOST_MATCHES.map((pattern, idx) => ({
      id: idx + 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "Content-Security-Policy", operation: "remove" },
          { header: "Content-Security-Policy-Report-Only", operation: "remove" },
        ],
      },
      condition: {
        regexFilter: matchPatternToRegexFilter(pattern),
        resourceTypes: ["main_frame", "sub_frame"],
      },
    }));

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules,
    });
  } catch (err) {
    console.warn("Failed to update CSP removal rules", err);
  }
})();

// ── 2. Content-script registration ─────────────────────────────────────────
const CONTENT_SCRIPTS = [
  {
    id: `inject-${EXTENSION_SLUG}`,
    js: ["injects/proxy.js"],
    css: ["injects/app.css"],
    matches: HOST_MATCHES,
    runAt: "document_start",
    world: "MAIN",
  },
  {
    id: `inject-${EXTENSION_SLUG}-module`,
    js: ["injects/vendors.js", "injects/app.js"],
    matches: HOST_MATCHES,
    runAt: "document_end",
    world: "MAIN",
  },
];

(async () => {
  try {
    const registered = await chrome.scripting.getRegisteredContentScripts();
    if (registered.length > 0) {
      await chrome.scripting.unregisterContentScripts({
        ids: registered.map((s) => s.id),
      });
    }
    await chrome.scripting.registerContentScripts(CONTENT_SCRIPTS);
  } catch (err) {
    console.warn("Failed to (re)register content scripts", err);
  }
})();

// ── 3. Seed window globals on tab load ──────────────────────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (
    tab?.url &&
    (changeInfo.status === "loading" || changeInfo.status === "complete") &&
    HOST_MATCHES.some((p) => matchPattern(p, tab.url))
  ) {
    await injectGlobalsIntoTab(tabId);
  }
});

chrome.runtime.onInstalled.addListener(() => injectGlobalsIntoExistingTabs());
chrome.runtime.onStartup.addListener(() => injectGlobalsIntoExistingTabs());
injectGlobalsIntoExistingTabs();

// ── 4. Storage-backed message API ───────────────────────────────────────────
const STORAGE_KEYS = {
  RESUME_CURSOR: "resumeCursor",
  DOWNLOADED_IDS: "downloadedFilesId",
  UI_SETTINGS: "uiMemoSettings",
};

function getStorage(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => resolve(result[key]));
  });
}

function setStorage(key, value) {
  return chrome.storage.local.set({ [key]: value });
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  const { action, payload } = request;

  (async () => {
    try {
      let result;
      switch (action) {
        // ── Lightweight persisted flags ──────────────────────────────────────
        case "getPersistLocalStorage": {
          const [key, defaultValue] = payload;
          const stored = await getStorage(key);
          result = stored === void 0 ? defaultValue : stored;
          break;
        }
        case "setPersistLocalStorage": {
          const [key, value] = payload;
          await setStorage(key, value);
          result = true;
          break;
        }

        // ── Downloaded-file IDs (skip-already-downloaded feature) ────────────
        case "getDownloadedFilesId": {
          result = (await getStorage(STORAGE_KEYS.DOWNLOADED_IDS)) || [];
          break;
        }
        case "appendDownloadedFilesId": {
          const [ids] = payload;
          let current = (await getStorage(STORAGE_KEYS.DOWNLOADED_IDS)) || [];
          if (current.length > 300000) current = [];
          current.push(...ids);
          await setStorage(STORAGE_KEYS.DOWNLOADED_IDS, current);
          result = true;
          break;
        }
        case "clearDownloadedFilesId": {
          await setStorage(STORAGE_KEYS.DOWNLOADED_IDS, []);
          result = true;
          break;
        }

        // ── Resume cursors ───────────────────────────────────────────────────
        case "setResumeCursor": {
          const [entry] = payload;
          if (!entry?.collectionToken) {
            result = false;
            break;
          }
          let cursors = (await getStorage(STORAGE_KEYS.RESUME_CURSOR)) || [];
          const idx = cursors.findIndex(
            (c) => c.collectionToken === entry.collectionToken,
          );
          const record = {
            ...entry,
            lastUpdateAt: Math.floor(Date.now() / 1000),
          };
          if (idx >= 0) cursors[idx] = record;
          else cursors.push(record);
          await setStorage(STORAGE_KEYS.RESUME_CURSOR, cursors);
          result = true;
          break;
        }
        case "getResumeCursor": {
          const [token] = payload;
          const cursors = (await getStorage(STORAGE_KEYS.RESUME_CURSOR)) || [];
          result = cursors.find((c) => c.collectionToken === token) || null;
          break;
        }
        case "removeResumeCursor": {
          const [token] = payload;
          let cursors = (await getStorage(STORAGE_KEYS.RESUME_CURSOR)) || [];
          cursors = cursors.filter((c) => c.collectionToken !== token);
          await setStorage(STORAGE_KEYS.RESUME_CURSOR, cursors);
          result = true;
          break;
        }

        // ── Persisted UI settings ────────────────────────────────────────────
        case "getUIMemoSettings": {
          result = (await getStorage(STORAGE_KEYS.UI_SETTINGS)) || null;
          break;
        }
        case "setUIMemoSettings": {
          const [settings] = payload;
          await setStorage(STORAGE_KEYS.UI_SETTINGS, settings);
          result = true;
          break;
        }

        // ── No-ops (former pricing / telemetry hooks) ────────────────────────
        case "visitPricingPage":
        case "visitPricing":
        case "visitDashboard":
        case "sentry":
        case "consumeFeatureTreeTry":
        case "consumeFeatureFreeTryByCount":
        case "consumeFeaturesTreeTryByMemoUIConfigs":
          result = true;
          break;

        default:
          result = null;
      }
      sendResponse({ status: "success", result });
    } catch (err) {
      sendResponse({
        status: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  return true; // keep the channel open for the async response
});
