import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchPatternToRegexFilter,
  matchesPattern,
  matchesAnyPattern,
} from "../extension/background/match-pattern.js";

test("compiles a basic host pattern to an anchored regex", () => {
  assert.equal(
    matchPatternToRegexFilter("https://www.facebook.com/*"),
    "^https://www\\.facebook\\.com/.*$",
  );
});

test("<all_urls> compiles to match-anything", () => {
  assert.equal(matchPatternToRegexFilter("<all_urls>"), ".*");
});

test("escapes regex metacharacters in the host", () => {
  const re = matchPatternToRegexFilter("https://a.b+c.com/*");
  // the '+' must be escaped so it is literal
  assert.ok(re.includes("\\+"));
  assert.ok(new RegExp(re).test("https://a.b+c.com/x"));
});

test("matchesPattern: positive and negative cases", () => {
  assert.equal(
    matchesPattern("https://www.facebook.com/*", "https://www.facebook.com/me"),
    true,
  );
  assert.equal(
    matchesPattern("https://www.facebook.com/*", "https://evil.com/"),
    false,
  );
});

test("matchesPattern: subdomain is NOT matched by a different host", () => {
  assert.equal(
    matchesPattern("https://www.facebook.com/*", "https://m.facebook.com/x"),
    false,
  );
});

test("matchesPattern: <all_urls> matches anything, including odd input", () => {
  assert.equal(matchesPattern("<all_urls>", "https://anything.example/x"), true);
});

test("matchesPattern: empty / null url returns false", () => {
  assert.equal(matchesPattern("https://www.facebook.com/*", ""), false);
  assert.equal(matchesPattern("https://www.facebook.com/*", null), false);
  assert.equal(matchesPattern("https://www.facebook.com/*", undefined), false);
});

test("matchesPattern: protocol mismatch (http vs https) is rejected", () => {
  assert.equal(
    matchesPattern("https://www.facebook.com/*", "http://www.facebook.com/me"),
    false,
  );
});

test("matchesAnyPattern: any one match wins", () => {
  const hosts = [
    "https://www.facebook.com/*",
    "https://web.facebook.com/*",
  ];
  assert.equal(matchesAnyPattern(hosts, "https://web.facebook.com/groups/1"), true);
  assert.equal(matchesAnyPattern(hosts, "https://twitter.com/"), false);
  assert.equal(matchesAnyPattern(hosts, null), false);
});
