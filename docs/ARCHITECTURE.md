# Architecture

Stashly is a Manifest V3 extension with four cooperating parts. It does **not**
scrape the DOM or simulate scrolling — it reuses Facebook's own Relay/GraphQL
runtime from the page's MAIN world, so requests run inside the user's existing
session.

```
┌──────────────────────────────────────────────────────────────────┐
│ Background service worker  (background/)                          │
│  • strips Facebook CSP headers via declarativeNetRequest          │
│  • registers the MAIN-world content scripts                       │
│  • seeds per-tab window globals (identity + unlocked feature cfg)  │
│  • chrome.storage message API (history, resume, settings, stats)  │
└───────────────┬──────────────────────────────────────────────────┘
                │ chrome.scripting / chrome.storage
                ▼
┌──────────────────────────────────────────────────────────────────┐
│ Facebook tab                                                      │
│  MAIN world:                                                      │
│   injects/proxy.js   (document_start) hooks the __d module loader │
│   injects/vendors.js (document_end)   Ant Design / lodash / dayjs │
│   injects/app.js     (document_end)   UI + download engine        │
│  ISOLATED world:                                                  │
│   content/loader.js → content/bridge.js  relays runtime messages  │
└──────────────────────────────────────────────────────────────────┘
```

## Directory layout

| Path | Role |
|------|------|
| `background/service-worker-loader.js` | Module entry referenced by the manifest |
| `background/service-worker.js` | CSP removal, script registration, message API |
| `background/match-pattern.js` | Pure match-pattern → regex helpers (unit tested) |
| `background/storage-actions.js` | Pure storage state transitions (unit tested) |
| `content/loader.js` | ISOLATED-world content-script entry |
| `content/bridge.js` | Relays background messages into the page |
| `content/constants.js` | Shared slug / host constants |
| `injects/proxy.js` | MAIN-world `__d` loader hook (`document_start`) |
| `injects/vendors.js` | Bundled UI vendor libraries |
| `injects/app.js` | Main UI + download pipeline (`document_end`) |
| `injects/app.css` | Accent theme for the injected UI |
| `pages/popup`, `pages/options` | Toolbar popup and settings page |

## Download pipeline (high level)

1. `proxy.js` hooks `window.__d` and exposes the Relay store + helper globals.
2. `app.js` registers interceptors on Facebook's album / photo components and
   reads the collection token from the Relay store.
3. It paginates via Facebook's internal `XHRRequest` GraphQL module.
4. Each HD image is fetched and written to a user-chosen directory through the
   File System Access API (`showDirectoryPicker`), with optional format
   conversion and custom naming.

## Testable core

The non-trivial background logic is isolated into `match-pattern.js` and
`storage-actions.js` — pure, `chrome`-free modules. The service worker is a thin
I/O wrapper around them, which keeps the logic unit-testable in plain Node
(`npm test`).

## Known fragility

The download engine depends on Facebook's internal module names, React
component names, and GraphQL `doc_id`s. When Facebook changes those, downloads
can break until the identifiers are refreshed. `injects/app.js` is a
pretty-printed third-party bundle; it is maintained via targeted edits rather
than a source build.
