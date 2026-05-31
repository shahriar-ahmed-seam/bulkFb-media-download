# `fb_scraper_engine.js` — Detailed Technical Documentation

> A clean-room  implementation of the core scraping engine Facebook extension, restructured into 6 readable, independent layers

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Layer 1 — FacebookModuleSystem](#2-layer-1--facebookmodulesystem)
3. [Layer 2 — RelayStoreAccessor](#3-layer-2--relaystoreaccessor)
4. [Layer 3 — GraphQLEngine](#4-layer-3--graphqlengine)
5. [Layer 4 — PhotoScraper](#5-layer-4--photoscraper)
6. [Layer 5 — Downloader](#6-layer-5--downloader)
7. [Layer 6 — Bootstrap & Example Usage](#7-layer-6--bootstrap--example-usage)
8. [Data Flow Diagram](#8-data-flow-diagram)
9. [Facebook Internal Module Dependency Map](#9-facebook-internal-module-dependency-map)
10. [Key Data Structures](#10-key-data-structures)
11. [Known Limitations & Missing Pieces](#11-known-limitations--missing-pieces)

---

## 1. Architecture Overview

The engine is organized as a **bottom-up dependency stack**. Each layer depends only on the layers below it:

```
┌─────────────────────────────────────────────────┐
│  Layer 6: Bootstrap & downloadAlbum()           │  ← Entry point
├─────────────────────────────────────────────────┤
│  Layer 5: Downloader                            │  ← File I/O
├─────────────────────────────────────────────────┤
│  Layer 4: PhotoScraper                          │  ← Pagination + HD resolution
├─────────────────────────────────────────────────┤
│  Layer 3: GraphQLEngine                         │  ← Authenticated API calls
├─────────────────────────────────────────────────┤
│  Layer 2: RelayStoreAccessor                    │  ← Read FB's Relay cache
├─────────────────────────────────────────────────┤
│  Layer 1: FacebookModuleSystem                  │  ← Hook into FB's JS runtime
└─────────────────────────────────────────────────┘
```

### Injection Lifecycle

The engine requires a **two-phase injection** into a Facebook tab:

| Phase | Timing | What Happens |
|-------|--------|--------------|
| **Phase 1** | `document_start` (before any FB script runs) | `FacebookModuleSystem.install()` wraps `window.__d`. `RelayStoreAccessor.install()` registers the Relay patch. |
| **Phase 2** | `document_end` (after FB fully loads) | `GraphQLEngine`, `PhotoScraper`, `Downloader` are instantiated. Component interceptors are registered. |

> [!IMPORTANT]
> Phase 1 **must** happen before Facebook's JavaScript executes. If `__d` is not wrapped before modules start registering, the patches will miss their targets and the engine will not function.

---

## 2. Layer 1 — FacebookModuleSystem

**File location**: Lines 40–313  
**Purpose**: Intercept Facebook's internal module loader to gain access to any internal module, patch module source code, and inject React component interceptors.

### How Facebook's Module System Works

Facebook bundles its entire codebase as named modules registered via a global function:

```javascript
window.__d(moduleName, dependencyIndices, factoryFunction, ...)
```

When a module is needed, `window.require(moduleName)` calls the factory, which receives its dependencies as arguments.

### Class: `FacebookModuleSystem`

#### Constructor

```javascript
new FacebookModuleSystem()
```

Initializes 5 internal data structures:

| Property | Type | Purpose |
|----------|------|---------|
| `_postLoadHooks` | `Map<string, Function[]>` | Callbacks fired after a module's factory executes |
| `_codeReplacements` | `Map<string, Function>` | Source code transformers (string → string) |
| `_componentInterceptors` | `Map<string, Object[]>` | React component wrappers |
| `_preRegistered` | `Set<string>` | Module names registered for interception before they load |
| `_processed` | `Set<string>` | Deduplication set — each module processed only once |

---

#### Method: `install()`

```javascript
moduleSystem.install()
```

- **Must be called at `document_start`**
- Wraps `window.__d` with a `Proxy` using `Object.defineProperty`
- The `get` trap returns the proxied definer
- The `set` trap wraps any new assignment (FB sometimes reassigns `__d`)
- Every future call to `__d(name, deps, factory)` goes through `_processModuleRegistration()`

---

#### Method: `require(name)`

```javascript
const XHR = moduleSystem.require('XHRRequest');
```

- Delegates to `window.require(name)`
- Equivalent to the original extension's `window.___xf(name)`
- Returns the module's exports object
- Throws if the module hasn't been loaded yet

---

#### Method: `patchModule(moduleName, replacer)`

```javascript
moduleSystem.patchModule('relay-runtime/store/RelayPublishQueue', (source) => {
  return source.replace(/pattern/, 'replacement');
});
```

- Registers a **source code transformation** for a specific module
- `replacer` receives the factory function's `.toString()` output
- Must return the modified source string
- The modified source is rebuilt into an executable function via `_rebuildFunction()`
- **Must be called before the target module loads** (i.e., before Phase 2)

**How `_rebuildFunction()` works:**
1. Extracts parameter names from the function signature
2. Extracts the function body
3. Creates a `<script>` tag that defines the new function on `window.__fnCache`
4. Injects and immediately removes the script tag (avoids CSP `eval` restrictions)
5. Returns the rebuilt function from the cache

---

#### Method: `interceptComponent(moduleName, component)`

```javascript
moduleSystem.interceptComponent('CometAlbumPhotoCollage.react', MyDownloadButton);
```

- Registers a React component to be rendered **alongside** the target Facebook component
- When FB renders the target component, the interceptor wraps the output in a `Fragment`:
  ```jsx
  <Fragment>
    <MyDownloadButton payload={originalProps} lastCmp={originalOutput} />
    {originalOutput}
  </Fragment>
  ```
- The interceptor component receives:
  - `payload` — the original component's props (contains album tokens, photo IDs, etc.)
  - `lastCmp` — the original rendered output (can be used for pass-through)

**Internal mechanism:**
1. The factory function is wrapped with a Proxy
2. On factory execution, it finds the default export at `args[6].default`
3. The export function is replaced with a wrapper that calls all registered interceptors
4. Each interceptor wraps the output in a React Fragment

---

#### Method: `hookModule(moduleName, callback)`

```javascript
moduleSystem.hookModule('xhrSimpleDataSerializer', (args) => {
  // args = factory function arguments (dependencies, exports, etc.)
  console.log('Module loaded with args:', args);
});
```

- Fires a callback **after** the module's factory function executes
- Useful for reading module exports or patching behavior post-load
- The callback receives the full factory args array

---

### Internal Method: `_processModuleRegistration(args)`

Called for every `__d()` call. Processing order:

```
1. _applyCodeReplacements()  →  Modify source code (string manipulation)
2. _wrapForPostLoadHooks()   →  Add post-execution callbacks
3. _wrapForComponentInterception()  →  Wrap React component renders
```

Each step wraps the factory function (`args[2]`) with additional behavior.

---

## 3. Layer 2 — RelayStoreAccessor

**File location**: Lines 332–483  
**Purpose**: Read data from Facebook's internal Relay (GraphQL cache) normalized store.

### Background: What is the Relay Store?

Facebook uses [Relay](https://relay.dev/) as its GraphQL client. Relay maintains a **normalized cache** — every GraphQL entity is stored by its `id`, and relationships are stored as `__ref` pointers. When you view an album page, all the album data, photo nodes, user records, etc. are cached in this store.

By patching `RelayPublishQueue`, the engine exposes the internal `RecordSourceProxy` as `window.___rs`, providing direct read access to all cached data.

### Class: `RelayStoreAccessor`

#### Constructor

```javascript
new RelayStoreAccessor(moduleSystem)
```

Takes a reference to the `FacebookModuleSystem` instance.

---

#### Method: `install()`

```javascript
relay.install()
```

- Registers a code patch on `relay-runtime/store/RelayPublishQueue`
- The patch intercepts the creation of `RelayRecordSourceProxy` and saves it to `window.___rs`
- **Must be called during Phase 1** (before Relay modules load)

---

#### Method: `getValue(recordId, path, args?)`

```javascript
// Get a simple field
const name = relay.getValue('user:12345', 'name');  // "John Doe"

// Traverse linked records (^ prefix)
const ownerName = relay.getValue('photo:67890', '^owner.name');

// With parameterized fields
const hdUri = relay.getValue('photo:67890', '^image{$1}.uri', {
  $1: { context: 'comet_media_viewer', height: 1000000, width: 1000000 }
});
```

**Path syntax:**

| Syntax | Relay API Call | Example |
|--------|---------------|---------|
| `fieldName` | `record.getValue("fieldName")` | `"name"` → user's name |
| `^linkedField` | `record.getLinkedRecord("linkedField")` | `"^owner"` → owner record |
| `^^linkedField` | `record.getLinkedRecords("linkedField")` | `"^^edges"` → array of edge records |
| `[0]` | Array index access | `"^^edges.[0]"` → first edge |
| `field{argKey}` | Parameterized field | `"^image{$1}.uri"` → image with args |
| `*` | Return current record as-is | Stop traversal, return record |

**Traversal flow:**
1. Start with `store.get(recordId)` to get the root record
2. Split the path into segments
3. For each segment, call the appropriate Relay method
4. Return the final value, or `undefined` if any step fails

---

#### Method: `findParentByTypename(recordId, typename, maxDepth?)`

```javascript
const albumRecord = relay.findParentByTypename('photo:67890', 'Album', 10);
```

- Traverses **upward** through the Relay store's reference graph
- Finds the first ancestor record whose `__typename` matches
- Uses a reverse-lookup built from all `__ref` and `__refs` pointers
- Limited to `maxDepth` hops (default: 10) to prevent infinite loops

---

## 4. Layer 3 — GraphQLEngine

**File location**: Lines 505–688  
**Purpose**: Execute authenticated GraphQL queries against Facebook's API using Facebook's own internal HTTP modules.

### Core Technique

Instead of manually constructing HTTP requests with extracted cookies/tokens, this engine calls Facebook's own `XHRRequest` class. This class already has access to:
- The authenticated session
- CSRF tokens (`fb_dtsg`)
- LSD tokens
- All required headers

The `getAsyncParams("POST")` function returns a pre-built object with all session parameters.

### Class: `GraphQLEngine`

#### Constructor

```javascript
new GraphQLEngine(moduleSystem)
```

---

#### Method: `execute(options)`

```javascript
const response = await graphql.execute({
  queryName: 'CometAlbumPhotoCollagePaginationQuery',
  docId: '1234567890',
  variables: { cursor: null, id: 'a.12345' },
  skipLabelData: true,
  timeout: 30000,
});
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `queryName` | `string` | ✅ | GraphQL operation name (used as `fb_api_req_friendly_name` header) |
| `docId` | `string` | ✅ | Numeric document ID identifying the query on Facebook's server |
| `variables` | `Object` | ✅ | Query variables (JSON-serialized in the request body) |
| `skipLabelData` | `boolean` | ❌ | If `true`, resolve as soon as the first response chunk arrives |
| `timeout` | `number` | ❌ | Request timeout in milliseconds (default: 30000) |

**Returns:** `Promise<Object[]>` — Array of parsed response payloads. Facebook uses **chunked responses** (HTTP streaming) for large queries, so there may be multiple payload objects.

**Internal flow:**
1. Load 5 Facebook internal modules: `XHRRequest`, `getAsyncParams`, `RelayAPIConfig`, `createRelayChunkedResponseParser`, `RelayGraphQLRequestUtils`
2. Build the request body with session params + query data
3. Create an `XHRRequest` instance pointed at `/api/graphql/`
4. Set up a chunked response parser that accumulates results
5. Handle errors, timeouts, and a 15-second "stuck chunk" safety timeout
6. Resolve with all accumulated response chunks

**Request body contents:**

```
av={actorId}                              ← Current user's ID
fb_api_caller_class=RelayModern           ← Required constant
server_timestamps=true                    ← Include server timestamps
fb_api_req_friendly_name={queryName}      ← Operation name
variables={JSON string}                   ← Query variables
doc_id={docId}                            ← Document identifier
...{asyncParams}                          ← Session/CSRF tokens
```

---

#### Method: `executeWithRetry(options, maxRetries?, baseDelay?)`

```javascript
const response = await graphql.executeWithRetry(
  { queryName: '...', docId: '...', variables: {...} },
  3,      // maxRetries
  1000    // baseDelay in ms
);
```

- Wraps `execute()` with exponential backoff retry logic
- Retry delays: 1000ms → 2000ms → 4000ms (doubles each time)
- **Does NOT retry rate limit errors** — throws immediately if rate-limited
- Returns the first successful response

---

#### Method: `getActorId()`

```javascript
const myId = graphql.getActorId();  // "100012345678"
```

Returns the currently logged-in user's Facebook ID via `RelayAPIConfig.actorID`.

---

#### Method: `getCurrentUserId()`

```javascript
const userId = graphql.getCurrentUserId();  // "100012345678"
```

Returns the current user's account ID via the `CurrentUser` module.

---

#### Private: `_isRateLimited(error)`

Checks if an error contains any of these rate limit indicators:

| Error Code | Error Text |
|------------|-----------|
| `1390008` | (API rate limit) |
| `1348007` | (request throttled) |
| `3252001` | (rate limited) |
| `1404006` | (too many requests) |
| `1675004` | (temporary block) |
| `1404078` | (restricted) |
| — | `"Request is too frequent"` |
| — | `"Rate limit"` |
| — | `"rate_limit_exceeded"` |
| — | `"Temporarily"` |
| — | `"again later"` |

---

## 5. Layer 4 — PhotoScraper

**File location**: Lines 708–930  
**Purpose**: Orchestrate album/collection scraping with pagination, resolve HD photo URLs, and traverse photo carousels.

### Class: `PhotoScraper`

#### Constructor

```javascript
new PhotoScraper(graphqlEngine, relayStoreAccessor, moduleSystem)
```

---

#### Method: `scrapeCollection(config)` — Async Generator

```javascript
for await (const photo of scraper.scrapeCollection({
  collectionToken: 'a.12345',
  queryName: 'CometAlbumPhotoCollagePaginationQuery',
  docId: '9876543210',
  paths: {
    edgesPath: 'data.node.media.edges',
    pageInfoPath: 'data.node.media.page_info',
    idPath: 'node.id',
    thumbnailUriPath: 'node.image.uri',
    nodeTypePath: 'node.__typename',
    viewerLinkPath: (edge) => `https://facebook.com/photo/?fbid=${edge.node.id}`,
  },
  options: { maxPhotos: 500, delayMs: 1000 },
})) {
  console.log(photo.id, photo.thumbnail);
}
```

**This is an `async *` generator** — it yields photos lazily as they're fetched, page by page. This means:
- Memory efficient: no buffering thousands of photos in an array
- Cancellable: the consumer can `break` out of the `for await` loop
- Backpressure: the next page isn't fetched until the consumer is ready

**Config parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `collectionToken` | `string` | Album/mediaset/group ID token |
| `queryName` | `string` | GraphQL pagination query name |
| `docId` | `string` | Numeric doc_id for the query |
| `paths` | `Object` | Response traversal path mappings (see below) |
| `extraVariables` | `Object` | Additional query variables (e.g., `{ count: 14 }`) |
| `options.maxPhotos` | `number` | Stop after this many photos (default: `Infinity`) |
| `options.delayMs` | `number` | Delay in ms between page fetches (default: `0`) |
| `options.signal` | `AbortSignal` | Abort signal for cancellation |

**Path mappings (`paths` object):**

| Path Key | Purpose | Example Value |
|----------|---------|---------------|
| `edgesPath` | Where to find the array of photo edges | `"data.node.media.edges"` |
| `pageInfoPath` | Where to find pagination info | `"data.node.media.page_info"` |
| `idPath` | Path to photo ID within each edge | `"node.id"` |
| `thumbnailUriPath` | Path to thumbnail URL | `"node.image.uri"` |
| `nodeTypePath` | Path to `__typename` (for filtering) | `"node.__typename"` |
| `viewerLinkPath` | Path to viewer URL (string) or function `(edge) => url` | `"node.url"` |

**Yields:** `{ id: string, thumbnail: string, viewerUrl: string }`

**Pagination loop:**
1. Fetch page with `cursor` (null for first page)
2. Extract edges and pageInfo from response
3. Filter edges to `__typename === "Photo"` only
4. Yield each photo
5. If `has_next_page`, set `cursor = end_cursor` and repeat
6. Stop if `maxPhotos` reached, signal aborted, or no more pages

---

#### Method: `resolveHDPhoto(photoId, mediasetToken, docId, retryCount?)`

```javascript
const hdData = await scraper.resolveHDPhoto('photo:67890', 'a.12345', '1111111111');
// {
//   id: '67890',
//   uri: 'https://scontent-xxx.fbcdn.net/v/t39.30808-6/full_res.jpg?...',
//   userId: '100012345678',
//   userName: 'John Doe',
//   folderName: 'John Doe',
//   createdAt: 1695526699,
//   caption: 'Beautiful sunset!',
//   nextPhotoId: '67891'
// }
```

Makes a `CometPhotoRootContentQuery` GraphQL request for a single photo to get:

| Field | Source Path | Description |
|-------|------------|-------------|
| `id` | `data.currMedia.id` | Canonical photo ID |
| `uri` | `data.currMedia.image.uri` | Full-resolution image URL |
| `userId` | `data.currMedia.owner.id` | Owner's user ID |
| `userName` | `data.owner.name` (from chunked response) | Owner's display name |
| `createdAt` | `data.currMedia.created_time` | Unix timestamp |
| `caption` | `data.message.text` (from chunked response) | Photo caption/description |
| `nextPhotoId` | `data.mediaset.nextMedia.edges[0].node.id` | Next photo in carousel |

**Retry logic:** If `ownerId` is null (data not yet loaded), retries up to 3 times with a 2-second delay.

---

#### Method: `scrapeCarousel(startPhotoId, mediasetToken, docId, options?)` — Async Generator

```javascript
for await (const photo of scraper.scrapeCarousel('photo:111', 'a.12345', '1111111111')) {
  console.log(`${photo.id}: ${photo.uri}`);
}
```

Walks through a photo carousel by following `nextPhotoId` links:

```
photo:111 → resolveHDPhoto → yield → nextPhotoId = photo:112
photo:112 → resolveHDPhoto → yield → nextPhotoId = photo:113
photo:113 → resolveHDPhoto → yield → nextPhotoId = null → STOP
```

- Stops when `nextPhotoId` is null (end of carousel)
- Supports `maxPhotos` and `AbortSignal` options
- Each step is a separate GraphQL request

---

## 6. Layer 5 — Downloader

**File location**: Lines 942–1132  
**Purpose**: Write downloaded images to the local filesystem using the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API).

### Class: `Downloader`

#### Constructor

```javascript
new Downloader()
```

Initializes:

| Property | Type | Purpose |
|----------|------|---------|
| `_rootDirHandle` | `FileSystemDirectoryHandle` | User-selected root download directory |
| `_folderCache` | `Map<string, FileSystemDirectoryHandle>` | Cached subfolder handles |
| `_filenameCounters` | `Map<string, number>` | Collision counters per filename |
| `_downloadedIds` | `Set<string>` | IDs of already-downloaded photos |
| `downloadCount` | `number` | Running total of downloads this session |

---

#### Method: `selectDirectory()`

```javascript
const ok = await downloader.selectDirectory();
```

- Opens the native directory picker dialog via `window.showDirectoryPicker()`
- Requests `readwrite` permission
- Stores the handle in `_rootDirHandle`
- Returns `true` if successful, `false` if user cancelled or error occurred

---

#### Method: `downloadPhoto(photo, options?)`

```javascript
const status = await downloader.downloadPhoto(
  {
    id: '67890',
    uri: 'https://scontent-xxx.fbcdn.net/v/full_res.jpg?...',
    userName: 'John Doe',
    createdAt: 1695526699,
    caption: 'Beautiful sunset!',
  },
  {
    format: 'image/webp',
    subfolder: 'John Doe',
    skipIfDownloaded: true,
    saveCaption: true,
    filenameFn: (photo, index) => `${index}_${photo.id}.jpg`,
  }
);
// Returns: 'done' | 'skip' | 'error'
```

**Full download pipeline (10 steps):**

```
1. Skip check        → Is this ID already downloaded?
2. Video filter       → Skip .mp4 / .webm files
3. Fetch blob         → fetch(uri) → .blob()
4. Validate           → Check blob.type starts with "image"
5. Generate filename  → Custom function or default pattern
6. Format conversion  → Canvas-based conversion if needed
7. Sanitize filename  → Remove illegal characters, limit to 255 chars
8. Deduplicate        → Append counter if filename already used
9. Create subfolder   → If specified, create nested directories
10. Write file        → getFileHandle → createWritable → write → close
    (+ optional caption sidecar .txt file)
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `format` | `string` | `'original'` | `'original'`, `'image/png'`, `'image/jpeg'`, or `'image/webp'` |
| `subfolder` | `string` | `null` | Subfolder path (supports `/` nesting) |
| `skipIfDownloaded` | `boolean` | `false` | Skip if photo ID is in `_downloadedIds` |
| `saveCaption` | `boolean` | `false` | Write `{filename}.caption.txt` alongside image |
| `filenameFn` | `Function` | `null` | Custom filename generator: `(photo, index) => string` |

---

#### Method: `reset()`

```javascript
downloader.reset();
```

Clears folder cache, filename counters, and resets download count. Call between sessions.

---

#### Private: `_convertImage(blob, targetType)`

- Creates an `<img>` element from the blob
- Draws it onto a `<canvas>`
- Exports via `canvas.toBlob(callback, targetType, 0.95)`
- Cleans up DOM elements and ObjectURLs
- Returns the new blob

---

#### Private: `_sanitizeFilename(name)`

Removes/replaces:
- `\ / < > : * | " ?` — filesystem-illegal characters
- Control characters (`\x00-\x1f`, `\x80-\x9f`)
- Leading/trailing dots
- Collapses whitespace
- Truncates to 255 characters

---

## 7. Layer 6 — Bootstrap & Example Usage

**File location**: Lines 1140–1373

### Function: `initEngine()`

```javascript
const { modules, relay } = initEngine();
```

**Phase 1 setup** — call at `document_start`:
1. Creates `FacebookModuleSystem` and `RelayStoreAccessor`
2. Calls `modules.install()` (wraps `__d`)
3. Calls `relay.install()` (registers Relay patch)
4. Returns both instances for later use

---

### Function: `createOperationalComponents(modules, relay)`

```javascript
const { graphql, scraper, downloader } = createOperationalComponents(modules, relay);
```

**Phase 2 setup** — call after Facebook fully loads:
1. Creates `GraphQLEngine`, `PhotoScraper`, `Downloader`
2. Returns all three for immediate use

---

### Function: `downloadAlbum(config)`

A complete example that chains all layers together:

```javascript
await downloadAlbum({
  collectionToken: 'a.12345678',
  queryName: 'CometAlbumPhotoCollagePaginationQuery',
  docId: '1234567890',
  hdDocId: '0987654321',
});
```

**Flow:**
1. Prompt user for download directory
2. Create AbortController
3. Iterate `scraper.scrapeCollection()` generator
4. For each photo → `scraper.resolveHDPhoto()` → `downloader.downloadPhoto()`
5. Track consecutive errors (abort after 5)
6. Random 50–250ms delay between downloads

---

### Window Export

The engine attaches itself to `window.__FBScraper`:

```javascript
window.__FBScraper = {
  FacebookModuleSystem,
  RelayStoreAccessor,
  GraphQLEngine,
  PhotoScraper,
  Downloader,
  initEngine,
  createOperationalComponents,
  downloadAlbum,
};
```

---

## 8. Data Flow Diagram

```
User visits FB album page
         │
         ▼
┌─────────────────────┐
│ FacebookModuleSystem │ ← Intercepts __d(), patches RelayPublishQueue
│ (Layer 1)            │
└────────┬────────────┘
         │ exposes window.___rs
         ▼
┌─────────────────────┐
│ RelayStoreAccessor   │ ← Reads album tokens, user names from Relay cache
│ (Layer 2)            │
└────────┬────────────┘
         │ provides collection tokens, owner data
         ▼
┌─────────────────────┐
│ GraphQLEngine        │ ← Calls /api/graphql/ using FB's own XHRRequest
│ (Layer 3)            │    + getAsyncParams (session tokens)
└────────┬────────────┘
         │ returns paginated edges[], HD photo URLs
         ▼
┌─────────────────────┐
│ PhotoScraper         │ ← Paginates via cursor, resolves HD per photo
│ (Layer 4)            │    yields photos one-by-one (async generator)
└────────┬────────────┘
         │ yields { id, uri, userName, createdAt, caption }
         ▼
┌─────────────────────┐
│ Downloader           │ ← fetch(uri) → blob → format convert → write to disk
│ (Layer 5)            │    via File System Access API
└─────────────────────┘
```

---

## 9. Facebook Internal Module Dependency Map

These are the Facebook modules the engine requires at runtime:

| Module Name | Used By | Purpose |
|-------------|---------|---------|
| `XHRRequest` | GraphQLEngine | Facebook's HTTP request class |
| `getAsyncParams` | GraphQLEngine | Returns session/CSRF params for POST requests |
| `RelayAPIConfig` | GraphQLEngine | Provides `actorID` (current user's ID) |
| `createRelayChunkedResponseParser` | GraphQLEngine | Parses HTTP chunked/streamed responses |
| `RelayGraphQLRequestUtils` | GraphQLEngine | `parsePayload()` function for response parsing |
| `WebPixelRatio` | GraphQLEngine | Device pixel ratio (`scale` variable) |
| `CurrentUser` | GraphQLEngine | `getAccountID()` for current user |
| `relay-runtime/store/RelayPublishQueue` | RelayStoreAccessor | **Patched** to expose `___rs` |
| `__debug` | (internal) | Module registry with `modulesMap` (for doc_id discovery) |
| `react` | FacebookModuleSystem | React createElement for component interception |

> [!WARNING]
> All module names are **hardcoded**. Facebook can rename any of these at any time, which would break the engine. The original extension mitigates this by fetching updated configs from a remote server.

---

## 10. Key Data Structures

### Photo Object (yielded by PhotoScraper)

```typescript
interface Photo {
  id: string;            // Facebook photo node ID (e.g., "67890")
  thumbnail: string;      // Thumbnail URL from collection edges
  viewerUrl: string;      // Photo viewer page URL
}
```

### HD Photo Object (returned by resolveHDPhoto)

```typescript
interface HDPhoto {
  id: string;             // Canonical photo ID
  uri: string;            // Full-resolution image CDN URL
  userId: string;         // Owner's Facebook user ID
  userName: string;       // Owner's display name
  folderName: string;     // Sanitized name for subfolder generation
  createdAt: number;      // Unix timestamp of photo creation
  caption: string;        // Photo description/caption text
  nextPhotoId: string | null;  // Next photo in carousel (null if last)
}
```

### GraphQL Page Info

```typescript
interface PageInfo {
  has_next_page: boolean;  // More pages available?
  end_cursor: string;      // Cursor for next page
}
```

---

## 11. Known Limitations & Missing Pieces

### 🔴 Critical: `doc_id` Discovery

The engine requires numeric `doc_id` values for each GraphQL query. These IDs:
- Are **not** hardcoded in this engine
- Change whenever Facebook deploys new code
- The original extension fetches them from `https://graphql-info.esuit.dev/`

**To use this engine, you must discover doc_ids yourself.** One approach:
```javascript
// After Facebook loads, search the module registry:
const debugMap = window.require('__debug').modulesMap;
const graphqlModules = Object.keys(debugMap)
  .filter(key => key.endsWith('.graphql'));

// Each graphql module has params.id = the doc_id
graphqlModules.forEach(name => {
  const mod = window.require(name);
  console.log(name, mod.params.id);
});
```

### 🟡 No CSP Header Removal

The original extension removes `Content-Security-Policy` headers via `chrome.declarativeNetRequest`. This engine does not include that functionality — it must be handled separately (e.g., in a service worker, or by running in a context where CSP isn't enforced).

### 🟡 No Service Worker / Background Script

This engine is **page-only**. It has no:
- Persistent storage across tabs
- Resume download capability
- Cross-tab coordination

### 🟡 Sequential Downloads Only

Downloads are sequential (one at a time). No concurrent download queue is implemented.

### 🟡 No UI Components

This is a pure logic engine with no React components. The original extension uses Ant Design for its modals, buttons, progress indicators, etc. This engine exposes only programmatic APIs.

### 🟢 No External Server Dependencies

Unlike the original extension, this engine makes **zero calls** to external servers (no `esuit.dev`, no analytics, no license checks). All operations are local.
