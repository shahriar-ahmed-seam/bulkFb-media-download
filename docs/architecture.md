# Extension Reverse Engineering Report

**Extension**: ESUIT | Photos Downloader for Facebook™  
**Version**: 4.9.1  
**Author**: William Chen (fbesuit@gmail.com)  
**Manifest Version**: 3  
**Extension ID slug**: `download-albums-for-facebook`

---

## 1. Overview

This is a sophisticated Chrome extension that downloads photos from Facebook albums, carousels, groups, profiles, and marketplace listings at scale. **It does NOT use any traditional DOM scraping, scrolling, or network interception.** Instead, it employs a remarkably clever technique: **it hijacks Facebook's own internal JavaScript module system** (the `__d` module definer) to intercept React component rendering, extract GraphQL collection tokens, and then replays Facebook's own internal `XHRRequest` module to make authenticated GraphQL API calls — all from within the `MAIN` world, piggybacking on the user's active Facebook session.

### Key Architectural Insight

The extension operates as a **parasite on Facebook's own Relay/GraphQL infrastructure**. It:
1. Monkey-patches Facebook's module loader (`__d`) at `document_start` via `proxy.js`
2. Registers React component interceptors on album/photo viewer components
3. When the user navigates to an album page, it captures the `collectionToken` from Facebook's own Relay store
4. Uses Facebook's internal `XHRRequest` module to make GraphQL pagination requests
5. Downloads HD images via `fetch()` + File System Access API (`showDirectoryPicker`)

This means there is **zero DOM scraping**, **zero scroll simulation**, and **zero network interception via `chrome.webRequest`**.

---

## 2. Scraping Engine

### 2.1 Entry Point & Injection Chain

| Step | File | Mechanism |
|------|------|-----------|
| 1 | `service-worker-loader.js` → `assets/index.ts-CV4GNR7f.js` | Background service worker boots up |
| 2 | Background registers content scripts dynamically | `chrome.scripting.registerContentScripts()` |
| 3 | `injects/proxy.js` injected at `document_start` in `MAIN` world | Hijacks `window.__d` |
| 4 | `injects/vendors.js` + `injects/index.js` injected at `document_end` in `MAIN` world | Main application logic |

### 2.2 Module Hijacking System (`proxy.js`)

The core innovation lives in `injects/proxy.js`. It intercepts Facebook's internal module definition system:

```javascript
// proxy.js wraps window.__d with a Proxy
Object.defineProperty(window, "__d", {
  get: function() { return p },
  set: function(e) {
    p = new Proxy(e, {
      apply: (e, n, t) => (t = m(t), e.apply(n, t))
    });
  }
});
```

This intercepts **every** React module that Facebook defines via `__d(moduleName, dependencies, factory)`. The system exposes several key functions:

| Function | Purpose |
|----------|---------|
| `window.___xf(name)` | Load a Facebook internal module by name (like `require`) |
| `window.___km(name, callback)` | Register a **component interceptor** — injects custom React components alongside Facebook's own |
| `window.___pt(name)` | **Pre-register** a module name for interception (declared before the module loads) |
| `window.___cr(name, replacement)` | **Code replacement** — modifies the source code of a module before it executes |
| `window.___sf(id, path)` | **Relay Store Finder** — queries Facebook's RelayPublishQueue store for data by ID |
| `window.___gi(name, callback)` | Hook into a module **after** it loads |

### 2.3 Relay Store Access

The extension patches Facebook's `RelayPublishQueue` module to expose the internal record source:

```javascript
// proxy.js - patches relay-runtime to expose ___rs  
window.___cr("relay-runtime/store/RelayPublishQueue", e =>
  e.replace(
    /,(\w+)=new\((\w+)\("relay-runtime\/mutations\/RelayRecordSourceProxy"/,
    ',$1=window["___rs"]=new($2("relay-runtime/mutations/RelayRecordSourceProxy"'
  )
);
```

This gives the extension direct access to Facebook's Relay store, letting it:
- Read `collectionToken` for albums
- Read `owner.name` for folder names  
- Read photo metadata (created_time, image URIs, etc.)
- Traverse parent records via `___ps`, `___pn`, `___ft`, `___fv`

### 2.4 Component Interception Points

In `injects/index.js`, the extension registers interceptors on these Facebook React components:

| Facebook Component | Extension Behavior |
|---|---|
| `CometAlbumPhotoCollage` | Extracts `reference_token` from the album, renders "Download This Album" button |
| `ProfileCometAppCollectionPhotosRenderer` | Profile photo collections — extracts `collectionToken` from `variables` |
| `ProfileCometLegacyAlbumGridView` | Legacy album grid view — extracts `reference_token` from mediaset |
| `GroupsCometMediaPhotosTabGrid` | Group media tab — extracts group ID as collection token |
| `CometPhotoRootContent` | Photo viewer modal — enables carousel/single photo download |
| `MarketplacePDPC2CMediaViewerWithImagesQuery` | Marketplace listing photos |

---

## 3. Download Pipeline

### 3.1 File System Access API (NOT `chrome.downloads`)

The extension does **NOT** use `chrome.downloads` API. Instead, it uses the modern **File System Access API** (`window.showDirectoryPicker`):

```javascript
// ki() function in index.js
window.showDirectoryPicker({
  mode: "readwrite",
  id: r.slice(0, 32),  // "download-albums-for-facebook"
  startIn: "downloads"
})
```

This allows writing files directly to a user-chosen directory, with support for:
- **Subfolder creation** via `getDirectoryHandle(name, { create: true })`
- **Streaming writes** via `createWritable()` → `write(blob)` → `close()`
- **Folder caching** via `window.folderHandlerCacheMap`

### 3.2 Download Flow (per image)

The `Vi()` hook (`download` function) handles each image:

1. **Fetch the image**: `fetch(photo.uri)` → `.blob()`
2. **Validate**: Check if blob type starts with `"image"`
3. **Skip check**: If `isSkipDownloadedFile` enabled, check against `downloadedFilesId` cache
4. **Skip videos**: `.mp4` and `.webm` files are skipped
5. **Get filename**: Apply naming rule template (e.g., `{username}_{date}.jpg`)
6. **Format conversion**: If user selected non-original format, convert via `<canvas>.toBlob()`
7. **Deduplication**: Track filenames in `window.downloadedFilenameCountMap`, append counter if duplicate
8. **Create folder**: If `isGenFolder` enabled, create subdirectory based on folder naming rule
9. **Write file**: `getFileHandle(name, {create:true})` → `createWritable()` → `write(blob)` → `close()`
10. **Write caption**: If `downloadCaption` enabled, write a `.caption.txt` sidecar file
11. **Update tracking**: Add file ID to `downloadedFilesId` for skip-downloaded feature
12. **Random micro-delay**: `Math.ceil(200 * Math.random() + 50) / 1000` seconds between downloads

### 3.3 Concurrency Model

There is **no parallel download queue**. Downloads are **sequential** — one image at a time in a `for...of` loop. This is intentionally conservative to avoid Facebook rate limits.

### 3.4 Image Format Conversion

When the user selects PNG/JPG/WEBP output:

```javascript
async function Ri(blob, targetType) {
  let { width, height, img, objUrl } = await Li(blob);
  let canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  canvas.getContext("2d").drawImage(img, 0, 0);
  return new Promise(resolve => {
    canvas.toBlob(newBlob => {
      URL.revokeObjectURL(objUrl);
      canvas.remove();
      resolve(newBlob);
    }, targetType, "0.95");
  });
}
```

---

## 4. API / GraphQL Usage

### 4.1 GraphQL Request System

This is the **critical core** of the extension. The function `Ct()` (aliased as `graphqlRequest`) makes GraphQL requests using Facebook's own internal modules:

```javascript
// Key Facebook internal modules used:
window.___xf("XHRRequest")           // Facebook's XHR wrapper
window.___xf("getAsyncParams")       // POST parameters (includes fb_dtsg, lsd, etc.)
window.___xf("RelayAPIConfig")       // Gets actorID (current user ID)
window.___xf("createRelayChunkedResponseParser")  // Parses chunked GraphQL responses
window.___xf("RelayGraphQLRequestUtils")           // parsePayload function
```

### 4.2 Request Format

Each GraphQL request sends:

```
POST /api/graphql/
Content-Type: application/x-www-form-urlencoded
X-FB-Friendly-Name: {graphqlName}

fb_api_req_friendly_name={graphqlName}
&variables={JSON encoded variables}
&doc_id={numeric document ID}
&av={actorID}
&fb_api_caller_class=RelayModern
&server_timestamps=true
&{...asyncParams from getAsyncParams("POST")}
```

### 4.3 GraphQL Queries Used

| GraphQL Name | Purpose | Pagination |
|---|---|---|
| `CometAlbumPhotoCollagePaginationQuery` | Album photos | Cursor-based |
| `ProfileCometAppCollectionPhotosRendererPaginationQuery` | Profile photo collections | Cursor-based |
| `ProfileCometLegacyAlbumGridViewPaginationQuery` | Legacy album grids | Cursor-based |
| `GroupsCometMediaPhotosTabGridQuery` | Group photo galleries | Cursor-based |
| `CometPhotoRootContentQuery` | Single photo HD data + next photo in carousel | Single + linked |
| `MarketplacePDPContainerQuery` | Marketplace listing metadata | Single |
| `MarketplacePDPC2CMediaViewerWithImagesQuery` | Marketplace listing images | Single |

### 4.4 Remote GraphQL Config Server

The extension fetches GraphQL configuration (doc_ids, variables, preload instructions) from its own servers:

```
Primary:   https://graphql-info.esuit.dev/{graphqlName}
Fallback:  https://esuit-dev-site-graphql-args.web.app/{graphqlName}
```

The response is **encrypted** using XOR cipher with key `"sentry"`:

```javascript
function Ye(encryptedBase64, key) {
  // base64 decode → hex parse → XOR with repeating key → UTF-8 decode
  const bytes = We(atob(encryptedBase64));
  const keyBytes = Ge(key, bytes.length);
  const decrypted = bytes.map((b, i) => b ^ keyBytes[i]);
  return He(decrypted);  // UTF-8 decode
}
```

This config contains:
- `docId` — the numeric GraphQL document ID
- `variables` — default variable templates
- `preload` — instructions to load Facebook internal modules (Bootloader, entrypoints, route code)
- `queryName` — the GraphQL operation name

### 4.5 Dynamic Module Loading

Before making a GraphQL request, the extension ensures the required Facebook modules are loaded by using Facebook's own `Bootloader`:

```javascript
// Load modules via Facebook's Bootloader
window.___xf("Bootloader").loadModules(moduleNames, callback);

// Or preload route code
window.___xf("CometRelayEF").fetchPredictedResources(module, { routeParams, routeProps });
```

This ensures the correct `doc_id` is available in `__debug.modulesMap["{queryName}.graphql"]`.

### 4.6 Token/Auth Handling

The extension **does NOT extract cookies, `fb_dtsg`, or `lsd` tokens directly**. Instead, it calls:

```javascript
window.___xf("getAsyncParams")("POST")
```

This returns Facebook's own async parameters object which includes all necessary CSRF tokens, session tokens, and authentication headers. The extension simply passes them through — it **piggybacks on the authenticated session** entirely.

For the actorID:
```javascript
window.___xf("RelayAPIConfig").actorID
```

---

## 5. Premium System

### 5.1 Tier Structure

```javascript
// Three tiers defined in index-C1oC9I1t.js
enum Plan { FREE = 0, BASIC = 1, PREMIUM = 2 }
```

Permission levels map to: FREE = 1, BASIC = 10, PREMIUM = 100.

### 5.2 Feature Gating

Features are defined in `$t` array in the service worker:

| Feature Key | Permission | FREE Limit | BASIC Limit | PREMIUM Limit |
|---|---|---|---|---|
| `fetchLimit` | 1 (FREE+) | **300 images** | Unlimited | Unlimited |
| `carouselDownloader` | 10 (BASIC+) | 5 free tries | ✅ | ✅ |
| `imagesFormatAs` | 100 (PREMIUM) | 50 images | 200 images | Unlimited |
| `fileNameFormats` | 100 (PREMIUM) | 50 images | 200 images | Unlimited |
| `folderNameRule` | 100 (PREMIUM) | 50 images | 200 images | Unlimited |
| `resumeDownloading` | 100 (PREMIUM) | ❌ | ❌ | ✅ |
| `downloadCaption` | 100 (PREMIUM) | 50 images | 100 images | ✅ |
| `skipDownloadedFiles` | 10 (BASIC+) | 5 free tries | ✅ | ✅ |

### 5.3 The 300 Image Limit

The FREE tier limit of **300 images per queue** is enforced client-side in the download loop:

```javascript
// In the pagination fetch loop (Hi() / startFetchAndDownload):
if (downloadCount >= fetchLimit) {
  isOnLimit.current = true;
  return Promise.resolve();
}
```

The `fetchLimit` value comes from: `features.fetchLimit.limitation[planIndex]` = `[300, 0, 0]`.  
A limitation of `0` means unlimited.

> [!WARNING]
> **The 300 limit is enforced client-side only.** The feature tree data is injected into `window.download_albums_for_facebook` via `chrome.scripting.executeScript`. A determined user could override `window.download_albums_for_facebook.fetchLimit.limitation` or `window.download_albums_for_facebook.fetchLimit.needUpgrade` in the console to bypass it. However, the feature consumption tracking is stored server-side for free-try counts.

### 5.4 License Verification

License validation is **server-validated** via:

```
GET https://getusersubscription-57pphaecyq-uc.a.run.app/?token={encodedToken}
```

The token is encoded as:
```javascript
function qe(uid, productId) {
  return encodeURIComponent(btoa(xorEncrypt(JSON.stringify({uid, productId}), "zzq8iM3Nft")));
}
```

The response contains:
- `stripeId` — Stripe customer ID
- `email`, `name`
- `allPayments` — array of payment records with `status`, `priceId`, `nextBillingDate`

Payment statuses checked: `succeeded`, `COMPLETED`, `completed`, `trialing`, `CANCELLED`, `canceled`, `active`, `ACTIVE`, `pending`, `refunded`.

Plan determination flow:
1. Filter payments to active/valid ones
2. Cross-reference `priceId` against product prices from `https://static-data.esuit.dev/index.json`
3. If any payment matches a BASIC price → plan = BASIC
4. If any payment matches a PREMIUM price → plan = PREMIUM

Customer data is cached in `chrome.storage.local` with a `lastCheckAt` timestamp. Re-validation occurs if `lastCheckAt + 86400 < now` (24-hour cache).

---

## 6. Rate Limiting / Delays

### 6.1 Anti-Ban Progressive Delay (`AvoidAccountRestrict`)

The `Mi()` hook implements an **adaptive throttle**:

```javascript
function AvoidAccountRestrict() {
  if (isFullSpeed) return;  // Bypass when FullSpeed enabled
  retryCount++;
  let delay = 10 * retryCount;
  delay = Math.ceil(Math.random() * delay + 500);
  if (delay < 1000) return setDelay(0);
  if (delay > 5000) { retryCount = 0; return setDelay(0); }
  setDelay(delay);
  await sleep(delay);
  setDelay(0);
}
```

This creates a **progressive random backoff** between API requests. The delay increases with consecutive requests, resets if it gets too high, and is bypassed entirely in FullSpeed mode.

### 6.2 User-Configurable Request Delay

Users can set a fixed delay (0-30 seconds) per request. This is applied via the `zi()` hook (`requestDelay`):

```javascript
async function requestDelay() {
  if (delay === 0 || isFullSpeed) return;
  setRequestDelayMs(delay * 1000);
  await sleep(delay * 1000);
  setRequestDelayMs(0);
}
```

### 6.3 Rate Limit Detection

The `S()` function (`isRateLimited`) checks for Facebook rate limit responses:

```javascript
function S(e) {
  return e.toString().includes("1390008") ||   // Rate limit error codes
    e.toString().includes("1348007") ||
    e.toString().includes("3252001") ||
    e.toString().includes("Request is too frequent") ||
    e.toString().includes("Rate limit") ||
    e.toString().includes("rate_limit_exceeded") ||
    // ... more
}
```

When detected, the download loop throws and terminates.

### 6.4 Micro-delay Between File Writes

After each file download, there's a small random delay:

```javascript
await sleep(Math.ceil(200 * Math.random() + 50) / 1000);  // 50-250ms
```

---

## 7. Pagination Logic

### 7.1 Cursor-Based GraphQL Pagination

For album/collection views, the extension uses standard Relay-style cursor pagination:

```javascript
async function startFetchAndDownload(cursor) {
  // Make GraphQL request with cursor
  graphqlRequest({
    graphqlName: "CometAlbumPhotoCollagePaginationQuery",
    afterArgs: vars => ({ ...vars, cursor: cursor || null, id: collectionToken }),
    skipLabelData: true
  }).then(async response => {
    const edges = lodash.get(response[0], edgesPath, []);
    const pageInfo = lodash.get(response[0], pageInfoPath, {});
    const hasNext = pageInfo.has_next_page ?? false;
    const endCursor = pageInfo.end_cursor ?? null;
    
    // Process photos...
    
    if (hasNext) {
      await startFetchAndDownload(endCursor);  // Recursive pagination
    }
  });
}
```

Each GraphQL query uses different edge/pageInfo paths mapped per component type.

### 7.2 Carousel/Photo Viewer Pagination

For carousel downloads (photo viewer), pagination works differently — it follows the `nextMedia` linked record:

```javascript
const nextPhotoId = lodash.get(response[0], "data.mediaset.nextMedia.edges[0].node.id")
  ?? findValueFromLoadQueryData(response, "data.nextMediaAfterNodeId.id");

if (nextPhotoId) {
  await startFetchAndDownload(nextPhotoId);  // Follow the linked list
}
```

### 7.3 Resume Downloading

The extension supports resuming downloads by persisting cursor state:

```javascript
// Save cursor state
await chrome.storage.local (resumeCursor bucket):
{
  collectionToken: "...",
  lastCursor: "...",
  lastIndex: 142,
  lastUpdateAt: 1695526699
}
```

This is a **PREMIUM-only** feature.

### 7.4 Stopping Conditions

1. `has_next_page === false` — GraphQL reports no more pages
2. `downloadCount >= fetchLimit` — FREE tier 300 limit hit
3. `isStopManually.current === true` — User clicked "Stop"
4. 5 consecutive request errors → auto-terminate
5. `BY_PHOTOS_COUNT` mode: `totalPhotos >= targetCount`
6. `BY_DAYS_COUNT` mode: `photo.createdAt < cutoffTimestamp`
7. Rate limit error detected → throw and terminate

---

## 8. Network Interception

### 8.1 What It Does NOT Do

- ❌ Does **not** use `chrome.webRequest` for intercepting Facebook traffic
- ❌ Does **not** override `XMLHttpRequest` or `fetch`
- ❌ Does **not** capture/replay observed network requests

### 8.2 What It DOES Do

- ✅ Uses `chrome.declarativeNetRequest` to **remove CSP headers** (Content-Security-Policy) so that its injected scripts can execute in the MAIN world without CSP violations:

```javascript
function Mt(hostPatterns) {
  chrome.declarativeNetRequest.updateDynamicRules({
    addRules: hostPatterns.map((pattern, i) => ({
      id: i + 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "Content-Security-Policy", operation: "remove" },
          { header: "Content-Security-Policy-Report-Only", operation: "remove" }
        ]
      },
      condition: {
        regexFilter: pattern,
        resourceTypes: ["main_frame", "xmlhttprequest"]
      }
    }))
  });
}
```

- ✅ Patches Facebook's AJAX serializer via `___gi("xhrSimpleDataSerializer")` to allow modifying GraphQL request payloads before they're sent (via `___ah` / `ajaxHijack`)

---

## 9. Auth / Token Handling

### 9.1 No Direct Token Extraction

The extension does **not** extract cookies, `fb_dtsg`, or `lsd` tokens. Instead:

| What | How |
|---|---|
| CSRF/Session tokens | `window.___xf("getAsyncParams")("POST")` — returns all needed params |
| Actor ID (user ID) | `window.___xf("RelayAPIConfig").actorID` |
| Current user check | `window.___xf("CurrentUser").getAccountID()` |
| CSRF for Instagram | `window.___xf("PolarisConfig").getCSRFToken()` |
| IG App ID | `window.___xf("PolarisConfig").getIGAppID()` |

### 9.2 Encryption Keys

| Key | Purpose |
|---|---|
| `"zzq8iM3Nft"` | XOR key for encoding user UID + productId for license server |
| `"sentry"` | XOR key for decrypting GraphQL config from remote server |
| `"string"` | Key parameter name referenced in `Ye()` decrypt function |
| `"mHxGWIqCotRcnLgFbr4YcdaZWDMHJlWu"` | Cache key for extension stats data |

---

## 10. Server Communication

### 10.1 External API Endpoints (Non-Facebook)

| Endpoint | Purpose | Data Sent |
|---|---|---|
| `https://graphql-info.esuit.dev/{name}` | Fetch GraphQL doc_ids & config | GraphQL operation name |
| `https://esuit-dev-site-graphql-args.web.app/{name}` | Fallback GraphQL config | GraphQL operation name |
| `https://static-data.esuit.dev/index.json` | Extension catalog & pricing data | None (GET) |
| `https://stats.esuit.dev/index.json` | Extension usage stats | None (GET) |
| `https://getusersubscription-57pphaecyq-uc.a.run.app/` | License/subscription verification | `token` (XOR-encrypted UID+productId) |
| `https://esuit-dev-sentry-6b0d6.web.app/api/sentry` | Error telemetry | XOR-encrypted error data (level, message, tags, extras) |

### 10.2 Sentry / Error Telemetry

Errors are collected and sent to the developer's sentry endpoint. Data includes:
- Error message and stack trace
- `pageLink` (current URL)
- GraphQL operation name
- Custom tags and context

The payload is XOR-encrypted with key `"sentry"` before transmission.

### 10.3 No Analytics/Tracking

There is no visible analytics SDK (Google Analytics, Mixpanel, etc.) embedded in the extension.

---

## 11. Code Obfuscation

### 11.1 Minification Level

- **All JS files are minified** (variable names mangled, whitespace removed)
- **Not obfuscated** (no eval, no string encoding, no control flow flattening)
- Built with **Vite** (evidenced by `@vite-ignore` comments, Vite-style chunk naming like `index-Bns6A62T.js`)
- React components are bundled using Vite's code splitting

### 11.2 Key Identifier Mapping

Through analysis, the critical mangled identifiers map to:

| Minified | Actual Purpose |
|---|---|
| `r` (in index.js) | `"download-albums-for-facebook"` (project slug) |
| `a` (in index.js) | Extension display name |
| `l` (in index.js) | Chrome Web Store link |
| `d` (in index.js) | "What's new" Facebook permalink |
| `F` (const) | `"download-albums-for-facebook"` |
| `q` (const) | Host match patterns array |
| `Qe` (const) | Extension display name |
| `P.FREE/BASIC/PREMIUM` | Plan enum values 0/1/2 |

### 11.3 Encrypted Config

The GraphQL config fetched from `graphql-info.esuit.dev` is XOR-encrypted. The decrypt function (`Ye`) uses base64 decode → hex parse → XOR with repeating key bytes.

---

## 12. Performance Strategy

### 12.1 Memory Management

- Photos are stored in a React ref (`photosArrRef`), not state — avoiding unnecessary re-renders
- UI only renders the **last 78 photos** in the thumbnail grid: `photosArrRef.current.slice(-78)`
- Blob references are nulled after writing: `blob = null; fileHandle = null; writable = null;`
- `ObjectURL.revokeObjectURL()` is called after image format conversion

### 12.2 Deduplication

- **ID-based dedup during fetch**: `photos.filter(p => !existingPhotos.find(e => e.id === p.id))`
- **Skip-downloaded feature**: File IDs persisted to `chrome.storage.local` (up to 300,000 IDs before auto-clear)
- **Filename dedup**: `downloadedFilenameCountMap` tracks filenames, appends counter for duplicates

### 12.3 Folder Handle Caching

```javascript
window.folderHandlerCacheMap = new Map();
// Cached by joined path segments, avoiding repeated getDirectoryHandle calls
```

---

## 13. Failure Handling

### 13.1 GraphQL Request Failures

**Retry with exponential backoff** (default: 3 retries):

```javascript
const retryConfig = { maxRetries: 3, retryDelay: 1000 };

for (let attempt = 0; attempt <= maxRetries; attempt++) {
  if (attempt > 0) {
    const delay = retryDelay * Math.pow(2, attempt - 1);
    await sleep(delay);
  }
  try {
    return await makeRequest();
  } catch (error) {
    lastError = error;
  }
}
throw lastError;
```

### 13.2 HD Photo Fetch Failures

If fetching an individual photo's HD data fails (owner ID is null), it retries up to 3 times with a 2-second delay:

```javascript
async function fetchHDPhoto(photo, retryCount = 0) {
  // ... GraphQL request ...
  if (!ownerId) {
    if (retryCount > 2) return reject("Failed to fetch HD photos");
    await sleep(2);
    return fetchHDPhoto(photo, retryCount + 1);
  }
}
```

### 13.3 Consecutive Error Threshold

A counter tracks consecutive download errors. After **5 consecutive failures**, the entire download terminates:

```javascript
if (consecutiveErrors++ > 5) {
  throw new Error("There have been 5 consecutive request errors, and the program has been terminated.");
}
```

### 13.4 Request Timeout

GraphQL requests have a 30-second timeout. The chunked response parser has a 15-second "stuck" timeout — if no `isComplete` signal arrives within 15 seconds of the last chunk, it auto-resolves.

### 13.5 User-Facing Error Dialog

Errors are displayed via Ant Design modals with:
- Readable error messages (with special handling for disk-full, rate-limit, HTTP 500)
- "Download errors message" button (exports error JSON for developer support)
- "Contact ESUIT developer" button
- Facebook error history from `ErrorPubSub`

---

## 14. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Chrome Browser                          │
├──────────────────┬──────────────────────────────────────────┤
│  Service Worker  │  Facebook Tab (MAIN world)               │
│  (background)    │                                          │
│                  │  ┌──────────────────────────────────┐    │
│  - License check │  │  proxy.js (document_start)        │    │
│  - Storage mgmt  │  │  - Hijacks __d module loader     │    │
│  - Tab tracking  │  │  - Patches RelayPublishQueue     │    │
│  - Feature gates │  │  - Exposes ___xf, ___km, ___sf   │    │
│  - CSP removal   │  │  - Patches XHR serializer        │    │
│  - Resume cursor │  └──────────────────────────────────┘    │
│                  │                                          │
│   ◄── message ──►│  ┌──────────────────────────────────┐    │
│    (external)    │  │  index.js (document_end)           │    │
│                  │  │  - React UI (Ant Design)          │    │
│                  │  │  - Component interceptors          │    │
│                  │  │  - GraphQL request engine          │    │
│                  │  │  - File System API downloads       │    │
│                  │  │  - Settings/config management      │    │
│                  │  └──────────────────────────────────┘    │
├──────────────────┤                                          │
│  Content Script  │  vendors.js                              │
│  (ISOLATED)      │  - Ant Design UI framework               │
│  - Message relay │  - lodash-es                             │
│  between bg↔page │  - dayjs                                 │
│                  │  - @ant-design/icons                     │
└──────────────────┴──────────────────────────────────────────┘
         │                        │
         │                        │
         ▼                        ▼
┌─────────────────┐     ┌──────────────────────┐
│  ESUIT Servers   │     │  Facebook GraphQL     │
│  - GraphQL config│     │  /api/graphql/        │
│  - License check │     │  (using FB's own      │
│  - Sentry errors │     │   XHR + auth tokens)  │
│  - Product data  │     │                       │
└─────────────────┘     └──────────────────────┘
```

### Message Flow

1. **Service Worker ↔ Page**: Uses `chrome.runtime.onMessageExternal` (the extension's content script acts as a bridge via the `externally_connectable` manifest key)
2. **Content Script (ISOLATED) ↔ Page (MAIN)**: The content script loader (`index.ts-CSjdHHrT.js`) relays messages from background to the page via `window.postMessage`
3. **Page ↔ Facebook**: Direct use of Facebook's internal `XHRRequest` module — no proxy needed since the injected code runs in the MAIN world with full access to Facebook's JS context

---

## 15. Weaknesses

### 15.1 Critical Fragility Points

1. **Module Name Dependencies**: The extension hardcodes Facebook internal module names like `"XHRRequest"`, `"getAsyncParams"`, `"RelayAPIConfig"`, `"CometDarkMode"`, `"CurrentUser"`, etc. If Facebook renames ANY of these, the extension breaks.

2. **Component Name Dependencies**: Interceptors target specific component names (`"CometAlbumPhotoCollage"`, `"ProfileCometAppCollectionPhotosRenderer"`, etc.). Facebook regularly renames React components.

3. **GraphQL doc_id Staleness**: The remote GraphQL config server must be constantly updated with new `doc_id` values whenever Facebook changes their GraphQL schemas. The extension has a detection mechanism for this (`docId 发生变化` warning), but it still requires manual server-side updates.

4. **Relay Store Structure**: The `___sf()` store finder relies on specific Relay record paths (e.g., `"^owner.name"`, `"reference_token"`). Schema changes break these lookups silently.

5. **`__d` Hook Assumption**: The entire system assumes Facebook uses the `__d` module definer. If Facebook changes their bundling/module system, everything breaks.

### 15.2 Security Weaknesses

1. **Client-side feature gating**: The 300-image limit and feature gates are enforced in JavaScript running in the MAIN world — easily bypassable via console.

2. **Weak encryption**: XOR cipher with static keys is trivially reversible (as demonstrated in this analysis).

3. **License token XOR key exposed**: `"zzq8iM3Nft"` is hardcoded in the client JavaScript.

### 15.3 Inefficiencies

1. **Sequential downloads**: No parallelism — could be 3-5× faster with concurrent fetches.

2. **Canvas-based format conversion**: Using `canvas.toBlob()` is CPU-intensive and blocks the main thread. Could use `OffscreenCanvas` or a worker.

3. **Full Ant Design bundle**: `vendors.js` is 688KB — the entire Ant Design library is bundled for a ~modest UI.

4. **Duplicate `MessageChannel` class**: The `he` class (background message handler) is defined identically 3 times in the service worker file.

---

## 16. How to Rebuild a Better Version

### 16.1 Core Architecture Improvements

1. **Dynamic Module Discovery**: Instead of hardcoded module names, scan `__debug.modulesMap` for modules matching patterns (e.g., find any module exporting `actorID`, find any XHR factory). Use dynamic discovery with fallback chains.

2. **GraphQL doc_id Auto-Discovery**: Instead of fetching doc_ids from a remote server, intercept the module definitions to capture `doc_id` values as Facebook loads them. The extension already has this capability via `___gi()` but doesn't use it as the primary source.

3. **Parallel Downloads**: Use a concurrent queue (e.g., p-limit with concurrency of 3-5) for image downloads. The GraphQL fetching can remain sequential, but blob downloads are independent.

4. **Web Worker for Format Conversion**: Offload `canvas.toBlob()` to an `OffscreenCanvas` in a Web Worker to avoid blocking the UI.

5. **Streaming Architecture**: Instead of buffering all photo metadata in memory, use a generator/async iterator pattern:
   ```javascript
   async function* paginatePhotos(collectionToken) {
     let cursor = null;
     do {
       const { edges, pageInfo } = await fetchPage(cursor);
       yield* edges;
       cursor = pageInfo.end_cursor;
     } while (pageInfo.has_next_page);
   }
   ```

### 16.2 Resilience Improvements

1. **Module Name Fuzzy Matching**: Instead of exact module names, use heuristic matching:
   ```javascript
   // Instead of: require("XHRRequest")
   // Use: find module whose export has .setMethod, .setData, .send
   findModuleByExportShape({ setMethod: 'function', setData: 'function', send: 'function' })
   ```

2. **GraphQL Schema Probing**: Before using a doc_id, validate it with a minimal test request. If it fails with a schema error, fall back to alternative doc_ids or re-probe.

3. **Relay Store Path Auto-Discovery**: Instead of hardcoded paths like `"data.currMedia.image.uri"`, traverse the response shape dynamically looking for URIs matching `scontent` CDN patterns.

### 16.3 Premium System Hardening

1. **Server-Side Download Validation**: Issue signed download tokens from the license server. Each token authorizes N downloads within a time window. The extension must present a valid token to proceed.

2. **Feature Flag Encryption**: Encrypt the feature configuration payload with a per-session key derived from the license server, not a static XOR key.

3. **Obfuscation**: Apply proper JavaScript obfuscation (control flow flattening, string encoding, dead code injection) to make bypassing harder.

### 16.4 UX Improvements

1. **Progress Estimation**: Calculate estimated time remaining based on average download speed and remaining photo count.

2. **Thumbnail Preview Grid**: Show downloaded photos in a grid with full preview on click, not just 50×50 thumbnails.

3. **Selective Download**: Let users check/uncheck individual photos before downloading.

4. **Background Download**: Use a service worker + `clients.claim()` to continue downloads even if the tab closes.

5. **ZIP Output Option**: Offer downloading as a ZIP file for users who don't want scattered files (using `fflate` or `zip.js`).
