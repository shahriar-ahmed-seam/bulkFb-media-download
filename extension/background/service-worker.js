/**
 * Stashly — background service worker.
 *
 * Responsibilities:
 *   1. Remove Facebook's Content-Security-Policy headers so the MAIN-world
 *      injected scripts are allowed to run.
 *   2. Register the injected content scripts (proxy at document_start, the
 *      vendor + app bundles at document_end).
 *   3. Seed the per-tab window globals the UI bootstrap expects (identity +
 *      an all-unlocked feature config).
 *   4. Provide a small chrome.storage-backed message API for resume cursors,
 *      downloaded-file IDs, persisted UI settings, and stats.
 *
 * Fully client-side: no remote auth, subscription, or telemetry calls.
 * All non-trivial state logic lives in ./storage-actions.js (unit tested).
 */

import {
  matchPatternToRegexFilter,
  matchesAnyPattern,
} from "./match-pattern.js";
import {
  STORAGE_KEYS,
  appendDownloadedIds,
  upsertResumeCursor,
  removeResumeCursor,
  findResumeCursor,
  computeStats,
} from "./storage-actions.js";

const HOST_MATCHES = [
  "https://www.facebook.com/*",
  "https://web.facebook.com/*",
];

const EXTENSION_SLUG = "download-albums-for-facebook";

// ── Per-tab window globals ──────────────────────────────────────────────────
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
async function refreshCspRules() {
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
    console.warn("[Stashly] Failed to update CSP removal rules", err);
  }
}

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

async function registerContentScripts() {
  try {
    const registered = await chrome.scripting.getRegisteredContentScripts();
    if (registered.length > 0) {
      await chrome.scripting.unregisterContentScripts({
        ids: registered.map((s) => s.id),
      });
    }
    await chrome.scripting.registerContentScripts(CONTENT_SCRIPTS);
  } catch (err) {
    console.warn("[Stashly] Failed to (re)register content scripts", err);
  }
}

// ── Bootstrap ───────────────────────────────────────────────────────────────
refreshCspRules();
registerContentScripts();
injectGlobalsIntoExistingTabs();

chrome.runtime.onInstalled.addListener(() => {
  refreshCspRules();
  registerContentScripts();
  injectGlobalsIntoExistingTabs();
});
chrome.runtime.onStartup.addListener(() => injectGlobalsIntoExistingTabs());

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (
    tab?.url &&
    (changeInfo.status === "loading" || changeInfo.status === "complete") &&
    matchesAnyPattern(HOST_MATCHES, tab.url)
  ) {
    await injectGlobalsIntoTab(tabId);
  }
});

// ── 3. Storage helpers ──────────────────────────────────────────────────────
function getStorage(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => resolve(result[key]));
  });
}

function setStorage(key, value) {
  return chrome.storage.local.set({ [key]: value });
}

// ── 4. Message API ──────────────────────────────────────────────────────────
async function handleAction(action, payload = []) {
  switch (action) {
    // ── Lightweight persisted flags ─────────────────────────────────────────
    case "getPersistLocalStorage": {
      const [key, defaultValue] = payload;
      const stored = await getStorage(key);
      return stored === undefined ? defaultValue : stored;
    }
    case "setPersistLocalStorage": {
      const [key, value] = payload;
      await setStorage(key, value);
      return true;
    }

    // ── Downloaded-file IDs (skip-already-downloaded feature) ───────────────
    case "getDownloadedFilesId":
      return (await getStorage(STORAGE_KEYS.DOWNLOADED_IDS)) || [];
    case "appendDownloadedFilesId": {
      const [ids] = payload;
      const current = (await getStorage(STORAGE_KEYS.DOWNLOADED_IDS)) || [];
      await setStorage(STORAGE_KEYS.DOWNLOADED_IDS, appendDownloadedIds(current, ids));
      return true;
    }
    case "clearDownloadedFilesId":
      await setStorage(STORAGE_KEYS.DOWNLOADED_IDS, []);
      return true;

    // ── Resume cursors ───────────────────────────────────────────────────────
    case "setResumeCursor": {
      const [entry] = payload;
      if (!entry?.collectionToken) return false;
      const cursors = (await getStorage(STORAGE_KEYS.RESUME_CURSORS)) || [];
      await setStorage(STORAGE_KEYS.RESUME_CURSORS, upsertResumeCursor(cursors, entry));
      return true;
    }
    case "getResumeCursor": {
      const [token] = payload;
      const cursors = (await getStorage(STORAGE_KEYS.RESUME_CURSORS)) || [];
      return findResumeCursor(cursors, token);
    }
    case "removeResumeCursor": {
      const [token] = payload;
      const cursors = (await getStorage(STORAGE_KEYS.RESUME_CURSORS)) || [];
      await setStorage(STORAGE_KEYS.RESUME_CURSORS, removeResumeCursor(cursors, token));
      return true;
    }
    case "listResumeCursors":
      return (await getStorage(STORAGE_KEYS.RESUME_CURSORS)) || [];
    case "clearResumeCursors":
      await setStorage(STORAGE_KEYS.RESUME_CURSORS, []);
      return true;

    // ── Persisted UI settings ────────────────────────────────────────────────
    case "getUIMemoSettings":
      return (await getStorage(STORAGE_KEYS.UI_SETTINGS)) || null;
    case "setUIMemoSettings": {
      const [settings] = payload;
      await setStorage(STORAGE_KEYS.UI_SETTINGS, settings);
      return true;
    }

    // ── Stats (consumed by the options page) ─────────────────────────────────
    case "getStats": {
      const downloadedIds = (await getStorage(STORAGE_KEYS.DOWNLOADED_IDS)) || [];
      const cursors = (await getStorage(STORAGE_KEYS.RESUME_CURSORS)) || [];
      return computeStats({ downloadedIds, cursors });
    }

    // ── No-ops (former pricing / telemetry hooks) ────────────────────────────
    case "visitPricingPage":
    case "visitPricing":
    case "visitDashboard":
    case "sentry":
    case "consumeFeatureTreeTry":
    case "consumeFeatureFreeTryByCount":
    case "consumeFeaturesTreeTryByMemoUIConfigs":
      return true;

    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  const { action, payload } = request || {};
  handleAction(action, payload)
    .then((result) => sendResponse({ status: "success", result }))
    .catch((err) =>
      sendResponse({
        status: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      }),
    );
  return true; // keep the channel open for the async response
});
