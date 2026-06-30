# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-06-30

First production release, rebranded to **Stashly**.

### Added

- Brand-new **options/settings page** with live activity stats and one-click
  clearing of download history and resume points.
- Redesigned **toolbar popup**: live page-status detection, stats, and quick
  actions, in a new dark violet theme.
- New `getStats`, `listResumeCursors`, and `clearResumeCursors` background
  message actions.
- **Test suite** (`npm test`) using Node's built-in runner — pure-logic unit
  tests with corner cases plus manifest and build-integrity checks (35 tests).
- **CI** (GitHub Actions) running tests + build on every push/PR, and a tag-
  triggered **release** workflow.
- Store-readiness docs: `PRIVACY.md`, `CONTRIBUTING.md`, `docs/STORE_LISTING.md`,
  and a concise `docs/ARCHITECTURE.md`.
- Accent theme for the injected in-page UI (`injects/app.css`).
- SVG brand logo used across the popup and options UI.

### Changed

- Refactored the background worker: non-trivial logic extracted into pure,
  `chrome`-free, unit-tested modules (`match-pattern.js`, `storage-actions.js`);
  the worker is now a thin I/O wrapper.
- Download history now de-duplicates IDs.
- Tooling migrated to ESM; `npm test` / `npm run build` are dependency-free.

### Removed

- All leftover **ESUIT** branding, links, and remote endpoints from the injected
  app — the build now contains zero `esuit.dev` references (enforced by a test).
- Verbose reverse-engineering docs, superseded by `docs/ARCHITECTURE.md`.

## [4.9.1] - 2026-05-31

- Initial client-side build and clean repository restructure.
- Removed remote auth/subscription/telemetry; all features unlocked locally.
