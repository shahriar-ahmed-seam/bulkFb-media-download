/**
 * Pure, dependency-free storage logic for Stashly's background worker.
 *
 * These helpers contain the non-trivial state transitions (deduped download
 * history with a hard cap, resume-cursor upsert/remove, stats) so they can be
 * unit-tested without a browser. The service worker is a thin I/O wrapper that
 * reads `chrome.storage.local`, calls these helpers, and writes the result.
 */

export const STORAGE_KEYS = Object.freeze({
  DOWNLOADED_IDS: "downloadedFilesId",
  RESUME_CURSORS: "resumeCursor",
  UI_SETTINGS: "uiMemoSettings",
});

/** Hard cap on tracked downloaded-file IDs before the history self-resets. */
export const MAX_DOWNLOADED_IDS = 300000;

/**
 * Append IDs to the downloaded-history list.
 *
 * - De-duplicates against existing entries and within the incoming batch.
 * - If the list has grown past {@link MAX_DOWNLOADED_IDS}, it resets first so
 *   storage never grows unbounded.
 *
 * @param {string[]} current
 * @param {string[]} ids
 * @returns {string[]} a new array (never mutates the input)
 */
export function appendDownloadedIds(current, ids) {
  let base = Array.isArray(current) ? current : [];
  if (base.length > MAX_DOWNLOADED_IDS) base = [];
  const incoming = Array.isArray(ids) ? ids : [];
  const seen = new Set(base);
  const result = base.slice();
  for (const id of incoming) {
    if (id == null) continue;
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

/**
 * Insert or update a resume cursor keyed by `collectionToken`.
 *
 * @param {Array<object>} cursors
 * @param {{collectionToken: string}} entry
 * @param {number} [now] epoch seconds (defaults to current time)
 * @returns {Array<object>} a new array (never mutates the input)
 */
export function upsertResumeCursor(cursors, entry, now = Math.floor(Date.now() / 1000)) {
  if (!entry || !entry.collectionToken) {
    throw new Error("upsertResumeCursor: entry.collectionToken is required");
  }
  const list = Array.isArray(cursors) ? cursors.slice() : [];
  const record = { ...entry, lastUpdateAt: now };
  const idx = list.findIndex((c) => c.collectionToken === entry.collectionToken);
  if (idx >= 0) list[idx] = record;
  else list.push(record);
  return list;
}

/**
 * Remove the resume cursor for a collection token.
 *
 * @param {Array<object>} cursors
 * @param {string} token
 * @returns {Array<object>} a new array (never mutates the input)
 */
export function removeResumeCursor(cursors, token) {
  const list = Array.isArray(cursors) ? cursors : [];
  return list.filter((c) => c.collectionToken !== token);
}

/**
 * Find the resume cursor for a collection token.
 *
 * @param {Array<object>} cursors
 * @param {string} token
 * @returns {object|null}
 */
export function findResumeCursor(cursors, token) {
  const list = Array.isArray(cursors) ? cursors : [];
  return list.find((c) => c.collectionToken === token) || null;
}

/**
 * Compute user-facing stats from the persisted state.
 *
 * @param {{downloadedIds?: string[], cursors?: object[]}} state
 * @returns {{downloadedCount: number, resumeCount: number}}
 */
export function computeStats(state = {}) {
  return {
    downloadedCount: Array.isArray(state.downloadedIds)
      ? state.downloadedIds.length
      : 0,
    resumeCount: Array.isArray(state.cursors) ? state.cursors.length : 0,
  };
}
