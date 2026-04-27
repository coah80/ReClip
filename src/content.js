const BRIDGE_ID = "reclip-page-bridge";
const CLIP_BUTTON_ENABLED_KEY = "reclipClipButtonEnabled";

let ensureTimer = 0;
let clipButtonEnabled = true;
let lastFlowType = "";

init();

const observer = new MutationObserver(scheduleEnsureNativeFlow);
observer.observe(document.documentElement, {
  childList: true,
  subtree: true
});

window.addEventListener("yt-navigate-finish", () => {
  setTimeout(scheduleEnsureNativeFlow, 500);
});

setInterval(scheduleEnsureNativeFlow, 5000);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !Object.prototype.hasOwnProperty.call(changes, CLIP_BUTTON_ENABLED_KEY)) {
    return;
  }

  clipButtonEnabled = changes[CLIP_BUTTON_ENABLED_KEY].newValue !== false;
  lastFlowType = "";
  scheduleEnsureNativeFlow();
});

async function init() {
  clipButtonEnabled = await getClipButtonEnabled();
  injectBridge();
  scheduleEnsureNativeFlow();
}

function getClipButtonEnabled() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [CLIP_BUTTON_ENABLED_KEY]: true }, (items) => {
      if (chrome.runtime.lastError) {
        resolve(true);
        return;
      }
      resolve(items[CLIP_BUTTON_ENABLED_KEY] !== false);
    });
  });
}

function injectBridge() {
  if (document.getElementById(BRIDGE_ID)) {
    return;
  }

  const script = document.createElement("script");
  script.id = BRIDGE_ID;
  script.src = chrome.runtime.getURL("src/page-bridge.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).append(script);
}

function scheduleEnsureNativeFlow() {
  clearTimeout(ensureTimer);
  ensureTimer = setTimeout(ensureNativeFlow, 200);
}

function ensureNativeFlow() {
  const type = clipButtonEnabled && isYouTubeVideoPage() ? "RECLIP_ENSURE_NATIVE_FLOW" : "RECLIP_DISABLE_NATIVE_FLOW";
  const reason = clipButtonEnabled ? "page" : "toggle";
  const flowKey = `${type}:${reason}`;
  if (type === "RECLIP_DISABLE_NATIVE_FLOW" && flowKey === lastFlowType) {
    return;
  }
  lastFlowType = flowKey;
  window.postMessage({
    source: "reclip-content",
    type,
    reason
  }, "*");
}

function isYouTubeVideoPage() {
  return location.hostname.endsWith("youtube.com") && location.pathname === "/watch" && new URL(location.href).searchParams.has("v");
}
