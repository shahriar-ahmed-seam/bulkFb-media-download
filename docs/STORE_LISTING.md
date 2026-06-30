# Chrome Web Store listing

Reference copy for the store submission form. Keep in sync with `manifest.json`.

## Name
Stashly — Bulk Media Downloader for Facebook

## Short description (132 char max)
Bulk-download photos from Facebook albums, profiles, groups and the photo viewer — saved to a folder you choose.

## Category
Productivity

## Detailed description
Stashly saves entire Facebook photo collections to a folder on your computer in
one click — albums, profile photos, group galleries, and the photo viewer.

Features
• Download a whole album, profile photo set, or group gallery at once
• Grab every photo from the Facebook photo viewer carousel
• Save straight to a folder you pick (no zip, no re-upload)
• Convert to JPG, PNG, or WEBP
• Custom file-name and folder-name templates
• Resume interrupted downloads and skip already-downloaded files
• Optional caption sidecar files
• Adjustable per-request delay

Privacy first
Stashly is 100% client-side. No login, no servers, no analytics, no tracking.
Downloads use your own Facebook session and the browser's File System Access API.
The only data stored is kept locally on your device and can be cleared anytime.

For personal archival use only. Respect Facebook's Terms of Service and the
copyright of any content you download. Not affiliated with Meta or Facebook.

## Single purpose (required by CWS)
Stashly's single purpose is to let a user bulk-download photos they can view on
Facebook to a local folder of their choice.

## Permission justifications
- **scripting** — inject the download UI and engine into Facebook pages.
- **storage** — remember user settings, download history (to skip duplicates), and resume points, locally.
- **tabs** — detect whether the active tab is a supported Facebook page to show accurate status.
- **declarativeNetRequest / declarativeNetRequestWithHostAccess** — remove Facebook's Content-Security-Policy response headers (only on facebook.com) so the injected UI is allowed to execute.
- **host access to *.facebook.com** — the extension only functions on Facebook.

## Data usage disclosures
- Does the extension collect user data? **No.**
- Sold to third parties? **No.**
- Used for purposes unrelated to core functionality? **No.**

## Keywords / tags
facebook, photo downloader, album downloader, bulk download, media downloader,
save photos, facebook albums, image downloader

## Suggested assets to prepare
- 128×128 store icon
- 1280×800 (or 640×400) screenshots: album button, options modal, options page, popup
- Optional small promo tile 440×280
