# Bulk FB Media Download

A Chrome (Manifest V3) extension that bulk-downloads photos from Facebook
albums, profile photo collections, group photo galleries, and the photo-viewer
carousel — straight to a folder you choose on disk.

This build is **fully client-side**. There is no login, no subscription check,
no telemetry, and no remote server dependency. Every feature is unlocked.

> **Disclaimer**: This project is for educational and personal-archival use.
> You are responsible for complying with Facebook's Terms of Service and with
> the copyright of any content you download. Only download media you have the
> right to.

---

## Features

- Download an entire album, profile photo set, or group photo gallery in one click
- Download every photo in the photo-viewer carousel
- Save directly to a chosen folder via the File System Access API (no zip step)
- Optional format conversion (JPG / PNG / WEBP)
- Custom file-name and folder-name templates
- Resume interrupted downloads
- Skip already-downloaded files
- Optional `.caption.txt` sidecar files
- Configurable per-request delay to stay gentle on Facebook's rate limits

---

## How it works

The extension does **not** scrape the DOM or simulate scrolling. Instead it
piggybacks on Facebook's own Relay/GraphQL infrastructure from the page's MAIN
world:

1. `injects/proxy.js` (at `document_start`) hooks Facebook's `__d` module
   loader and exposes the Relay store.
2. `injects/vendors.js` + `injects/app.js` (at `document_end`) render the UI
   and drive the download pipeline, reusing Facebook's internal `XHRRequest`
   module so requests carry the user's existing session.
3. The background service worker strips Facebook's CSP headers (so the injected
   MAIN-world scripts can run) and provides a small `chrome.storage`-backed API
   for resume cursors, downloaded-file IDs, and saved UI settings.

See [docs/architecture.md](docs/architecture.md) for the full breakdown.

---

## Project structure

```
bulkFb-media-download/
├── extension/                  # the loadable / releasable extension
│   ├── manifest.json
│   ├── background/
│   │   ├── service-worker-loader.js   # module entry referenced by manifest
│   │   └── service-worker.js          # CSP removal, script registration, storage API
│   ├── content/
│   │   ├── loader.js                  # ISOLATED-world content-script entry
│   │   ├── bridge.js                  # relays runtime messages to the page
│   │   └── constants.js               # shared slug / host constants
│   ├── injects/
│   │   ├── proxy.js                   # MAIN-world __d loader hook (document_start)
│   │   ├── vendors.js                 # bundled Ant Design / lodash / dayjs
│   │   ├── app.js                     # main UI + download engine (document_end)
│   │   └── app.css
│   ├── pages/popup/                   # toolbar popup
│   └── assets/icons/                  # extension icons
├── docs/                       # reverse-engineering & architecture notes
├── scripts/build-zip.js        # produces a store-ready zip
└── package.json
```

---

## Install (development)

1. Clone this repo.
2. Open `chrome://extensions` in Chrome (or any Chromium browser).
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the `extension/` folder.
5. Open Facebook, navigate to an album / profile photos / group photos page.
   The download button appears automatically.

> Requires Chrome 103+ for the File System Access API and MV3 dynamic content
> scripts.

---

## Build a release zip

```bash
npm run build
```

This packages the contents of `extension/` into
`dist/bulkfb-media-download-v<version>.zip`, ready to upload to the Chrome Web
Store or attach to a GitHub release. The script uses your platform's built-in
zip tooling, so there are no install steps.

---

## Releasing on GitHub

```bash
git init
git add .
git commit -m "Initial release: v4.9.1"
git branch -M main
git remote add origin https://github.com/shahriar-ahmed-seam/bulkFb-media-download.git
git push -u origin main
```

Then create a tagged release and attach the zip from `dist/`:

```bash
npm run build
git tag v4.9.1
git push origin v4.9.1
# upload dist/bulkfb-media-download-v4.9.1.zip to the GitHub release
```

---

## Limitations & fragility

This extension depends on Facebook's internal module and component names
(`XHRRequest`, `CometAlbumPhotoCollage`, etc.) and on GraphQL `doc_id`s. When
Facebook changes those, downloads can break until the relevant identifiers are
updated. See [docs/architecture.md](docs/architecture.md) §15 for details.

---

## License

[MIT](LICENSE)
