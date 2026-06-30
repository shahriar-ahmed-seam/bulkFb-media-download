import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DOWNLOADED_IDS,
  appendDownloadedIds,
  upsertResumeCursor,
  removeResumeCursor,
  findResumeCursor,
  computeStats,
} from "../extension/background/storage-actions.js";

// ── appendDownloadedIds ──────────────────────────────────────────────────────
test("appendDownloadedIds: appends to an empty list", () => {
  assert.deepEqual(appendDownloadedIds([], ["a", "b"]), ["a", "b"]);
});

test("appendDownloadedIds: de-duplicates against existing and within batch", () => {
  assert.deepEqual(
    appendDownloadedIds(["a"], ["a", "b", "b", "c"]),
    ["a", "b", "c"],
  );
});

test("appendDownloadedIds: does not mutate the input array", () => {
  const current = ["a"];
  const out = appendDownloadedIds(current, ["b"]);
  assert.deepEqual(current, ["a"]);
  assert.notEqual(out, current);
});

test("appendDownloadedIds: tolerates non-array / nullish inputs", () => {
  assert.deepEqual(appendDownloadedIds(null, ["a"]), ["a"]);
  assert.deepEqual(appendDownloadedIds(["a"], null), ["a"]);
  assert.deepEqual(appendDownloadedIds(undefined, undefined), []);
});

test("appendDownloadedIds: skips null/undefined entries in the batch", () => {
  assert.deepEqual(appendDownloadedIds([], ["a", null, undefined, "b"]), ["a", "b"]);
});

test("appendDownloadedIds: resets when over the hard cap", () => {
  const huge = Array.from({ length: MAX_DOWNLOADED_IDS + 1 }, (_, i) => "id" + i);
  const out = appendDownloadedIds(huge, ["fresh"]);
  assert.deepEqual(out, ["fresh"]);
});

// ── upsertResumeCursor ───────────────────────────────────────────────────────
test("upsertResumeCursor: inserts a new cursor with a timestamp", () => {
  const out = upsertResumeCursor([], { collectionToken: "T1", lastIndex: 5 }, 1000);
  assert.deepEqual(out, [{ collectionToken: "T1", lastIndex: 5, lastUpdateAt: 1000 }]);
});

test("upsertResumeCursor: replaces an existing cursor in place (order kept)", () => {
  const start = [
    { collectionToken: "A", lastIndex: 1 },
    { collectionToken: "B", lastIndex: 2 },
  ];
  const out = upsertResumeCursor(start, { collectionToken: "A", lastIndex: 99 }, 2000);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { collectionToken: "A", lastIndex: 99, lastUpdateAt: 2000 });
  assert.equal(out[1].collectionToken, "B");
});

test("upsertResumeCursor: does not mutate input", () => {
  const start = [{ collectionToken: "A" }];
  const out = upsertResumeCursor(start, { collectionToken: "A" }, 1);
  assert.notEqual(out, start);
  assert.equal(start[0].lastUpdateAt, undefined);
});

test("upsertResumeCursor: throws without a collectionToken", () => {
  assert.throws(() => upsertResumeCursor([], {}, 1));
  assert.throws(() => upsertResumeCursor([], null, 1));
});

// ── removeResumeCursor / findResumeCursor ────────────────────────────────────
test("removeResumeCursor: removes the matching token only", () => {
  const start = [{ collectionToken: "A" }, { collectionToken: "B" }];
  assert.deepEqual(removeResumeCursor(start, "A"), [{ collectionToken: "B" }]);
});

test("removeResumeCursor: no-op when token is absent", () => {
  const start = [{ collectionToken: "A" }];
  assert.deepEqual(removeResumeCursor(start, "Z"), [{ collectionToken: "A" }]);
});

test("findResumeCursor: returns the match or null", () => {
  const start = [{ collectionToken: "A", lastIndex: 7 }];
  assert.deepEqual(findResumeCursor(start, "A"), { collectionToken: "A", lastIndex: 7 });
  assert.equal(findResumeCursor(start, "Z"), null);
  assert.equal(findResumeCursor(null, "A"), null);
});

// ── computeStats ─────────────────────────────────────────────────────────────
test("computeStats: counts ids and cursors, defaulting safely", () => {
  assert.deepEqual(computeStats({ downloadedIds: ["a", "b"], cursors: [{}] }), {
    downloadedCount: 2,
    resumeCount: 1,
  });
  assert.deepEqual(computeStats({}), { downloadedCount: 0, resumeCount: 0 });
  assert.deepEqual(computeStats(), { downloadedCount: 0, resumeCount: 0 });
});
