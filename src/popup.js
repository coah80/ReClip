const CLIP_BUTTON_ENABLED_KEY = "reclipClipButtonEnabled";
const GITHUB_URL = "https://github.com/coah80/ReClip";
const TWITTER_URL = "https://x.com/coah80";

const toggle = document.getElementById("clip-toggle");
const status = document.getElementById("status");
const githubLink = document.getElementById("github-link");
const twitterLink = document.getElementById("twitter-link");

init();

function init() {
  chrome.storage.local.get({ [CLIP_BUTTON_ENABLED_KEY]: true }, (items) => {
    const enabled = chrome.runtime.lastError ? true : items[CLIP_BUTTON_ENABLED_KEY] !== false;
    renderEnabled(enabled);
  });

  toggle.addEventListener("change", () => {
    const enabled = toggle.checked;
    chrome.storage.local.set({ [CLIP_BUTTON_ENABLED_KEY]: enabled }, () => {
      renderEnabled(enabled);
    });
  });

  githubLink.addEventListener("click", () => openUrl(GITHUB_URL));
  twitterLink.addEventListener("click", () => openUrl(TWITTER_URL));
}

function renderEnabled(enabled) {
  toggle.checked = enabled;
  status.textContent = enabled ? "Clip button enabled" : "Clip button disabled";
}

function openUrl(url) {
  chrome.tabs.create({ url });
}
