const manifest = chrome.runtime.getManifest();

document.getElementById("icon").src = chrome.runtime.getURL(
  "/assets/icons/favicon-48.png",
);

const versionEl = document.getElementById("version");
if (versionEl) versionEl.textContent = "v" + manifest.version;
