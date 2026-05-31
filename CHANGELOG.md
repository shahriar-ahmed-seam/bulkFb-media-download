# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [4.9.1] - 2026-05-31

### Changed

- Restructured into a clean, GitHub-ready repository layout (`extension/`,
  `docs/`, `scripts/`).
- Renamed cryptic Vite-hash artifacts to meaningful names
  (`index.ts-CSjdHHrT.js` → `content/bridge.js`, `injects/index.js` →
  `injects/app.js`, etc.) and updated every reference.
- Reorganized the service worker, content bridge, and popup into dedicated
  `background/`, `content/`, and `pages/` folders.

### Removed

- All remote server dependencies: login/auth, subscription verification,
  pricing/upgrade prompts, and error telemetry.
- Unused options-page and subscription UI bundles (~1.3 MB).
- `_locales/` (the manifest now uses literal name/description strings).

### Added

- `scripts/build-zip.js` to package a store-ready release archive.
- README, LICENSE (MIT), `.gitignore`, and `package.json`.

### Notes

- This is a fully client-side build; every feature is unlocked by default.
