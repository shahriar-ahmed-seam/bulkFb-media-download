# Feature Configuration Breakdown

The JSON object provided is the **Resolved Feature Tree**. This object is injected directly into `window.download_albums_for_facebook` in the Facebook page context. It dictates exactly which features the user is allowed to use, how many times they can use them, and what their default settings are.

Based on the values (`limitation: 999999` and `needUpgrade: false`), this specific object represents a **Premium/Unlimited** state.

Here is a detailed breakdown of the structure, followed by what each of the 8 features actually controls in the code.

---

## 1. The Structure of a Feature Node

Every feature (e.g., `fetchLimit`) follows the same structural pattern. Here is what each property means:

| Property | Meaning |
|---|---|
| **`enable`** | `boolean` — Whether this feature is currently toggled ON. A user might have a premium feature but choose to disable it in the extension settings. |
| **`needUpgrade`** | `boolean` — `true` if the user's current plan is too low to use this feature. `false` means they have access. If true, interacting with this feature triggers the "Upgrade Now" popup. |
| **`limitation`** | `number` — The enforced numeric cap for this specific feature under the current plan. (`999999` or `0` typically represents unlimited). |
| **`permission`** | `number` — The minimum tier required to access the feature without limits. (1 = Free, 10 = Basic, 100 = Premium). |
| **`freeTryLeft`** | `number` — If the user doesn't have the required plan, this shows how many free trial uses remain. |
| **`isCanFreeTry`** | `boolean` — Whether this specific feature offers a free trial mechanism. |
| **`defaultValue`** | `string/boolean` — The user's saved preference for this feature (e.g., the specific format name "image/png"). Maps to `memoKey`. |
| **`_` (Underscore)** | `Object` — The native/raw blueprint of the feature from the developer's source code, before resolving against the user's plan. It contains the raw `[FREE, BASIC, PREMIUM]` limitation array. |

---

## 2. Detailed Breakdown of the 8 Features

### 1. `fetchLimit` (Fetch Count Limit)
* **What it controls:** The maximum number of photos you can download in a single batch/queue. 
* **How it's used:** Inside the photo pagination loop, the code increments a counter. If `downloadCount >= fetchLimit.limitation`, the loop forcibly halts and the "Limit Reached" modal appears.
* **Premium State:** Set to `999999` (unlimited). In the free tier, this is usually `300`.

### 2. `carouselDownloader` (Carousel Download)
* **What it controls:** The ability to download photos from the "Carousel" view (when you click on a single photo and view it in the black theatre-mode popup, navigating via next/prev arrows).
* **How it's used:** If you try to run the downloader while viewing a single photo, it checks this feature.
* **Trial logic:** Notice `isCanFreeTry: true` and `maxFreeTryCount: 5`. Free users get to use this exactly 5 times before it locks and demands an upgrade.

### 3. `imagesFormatAs` (Images Format Feature)
* **What it controls:** Built-in image conversion. Allows the user to select "PNG", "JPG", or "WEBP" instead of downloading whatever format Facebook serves.
* **How it's used:** The `Downloader` checks `defaultValue` (e.g., `"none"`, `"image/png"`). If set to a specific format, the extension paints the blob to a hidden Canvas and converts it before saving.
* **Default Value:** `"none"` (downloads the original format).

### 4. `fileNameFormats` (Filename Formats Feature)
* **What it controls:** The templating engine for naming downloaded files. 
* **How it's used:** Instead of random numbers, users can configure file names. The code replaces template strings like `{username}` or `{date}` with actual metadata grabbed from the Relay store.
* **Default Value:** `"-**original name**-"` (keeps Facebook's default randomized filename).

### 5. `folderNameRule` (Folder Name Rules Feature)
* **What it controls:** Automatic creation of sub-folders on the user's hard drive depending on the context of the download.
* **How it's used:** When calling `window.showDirectoryPicker`, the code creates a child directory using the template value. 
* **Default Value:** `"-**username**-"` (It will automatically create a folder named after the person or page who uploaded the photos, e.g., `Downloads/John Doe/photo1.jpg`).

### 6. `resumeDownloading` (Resume Download)
* **What it controls:** The ability to pause a massive download (e.g., a 5,000 photo album) and resume it later without starting from scratch.
* **How it's used:** It saves the Facebook Relay `collectionToken` and the last `cursor` hash to `chrome.storage.local`. The next time it runs, it skips directly to that pagination cursor. 

### 7. `downloadCaption` (Download Caption)
* **What it controls:** Scraping the text description/caption written by the user and saving it alongside the image.
* **How it's used:** Within the `resolveHDPhoto` GraphQL query, it extracts `data.message.text`. It then creates a secondary text file sidecar (e.g., `photo1.jpg` and `photo1.caption.txt`).
* **Default Value:** `false` (Disabled by default).

### 8. `skipDownloadedFiles` (Skip Downloaded File)
* **What it controls:** Deduplication to prevent you from downloading the exact same photo twice if you run the scraper on the same group/album days apart.
* **How it's used:** It stores the unique canonical Facebook photo IDs in a massive array (`downloadedFilesId` cache) in local storage (up to 300,000 IDs). Before downloading a photo, it checks `if (downloadedFilesId.includes(photo.id))` and skips it if true.
* **Trial logic:** Notice `isCanFreeTry: true` and `freeTryLeft: 5`. Free users get to use the deduplication feature 5 times.
