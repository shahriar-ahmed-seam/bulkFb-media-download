/**
 * Pure, dependency-free helpers for working with Chrome match patterns.
 *
 * Kept free of any `chrome.*` references so the logic can be unit-tested in
 * plain Node without a browser environment.
 */

/**
 * Convert a Chrome match pattern (e.g. `https://www.facebook.com/*`) into an
 * anchored, RE2-compatible regex string suitable for
 * `chrome.declarativeNetRequest` `regexFilter`.
 *
 * @param {string} pattern
 * @returns {string}
 */
export function matchPatternToRegexFilter(pattern) {
  if (pattern === "<all_urls>") return ".*";
  // Escape regex metacharacters, then turn the pattern wildcard `*` into `.*`.
  // Forward slashes need no escaping inside a JS regex source string.
  const escaped = pattern.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
  return "^" + escaped.replace(/\*/g, ".*") + "$";
}

/**
 * Test whether a URL satisfies a Chrome match pattern.
 *
 * @param {string} pattern
 * @param {string} url
 * @returns {boolean}
 */
export function matchesPattern(pattern, url) {
  try {
    if (!url) return false;
    if (pattern === "<all_urls>") return true;
    return new RegExp(matchPatternToRegexFilter(pattern)).test(url);
  } catch {
    return false;
  }
}

/**
 * Test a URL against a list of match patterns.
 *
 * @param {string[]} patterns
 * @param {string} url
 * @returns {boolean}
 */
export function matchesAnyPattern(patterns, url) {
  return patterns.some((p) => matchesPattern(p, url));
}
