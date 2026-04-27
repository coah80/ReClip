const YOUTUBE_ORIGIN = "https://www.youtube.com";
const CREATE_POST_PATH = "/youtubei/v1/backstage/create_post";
const AUTH_COOKIE_NAMES = ["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"];

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "RECLIP_CREATE_CLIP") {
    return false;
  }

  createClip(message.payload)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });

  return true;
});

async function createClip(payload) {
  const input = validatePayload(payload);
  const headers = await buildHeaders(input.config);
  const url = `${YOUTUBE_ORIGIN}${CREATE_POST_PATH}?key=${encodeURIComponent(input.config.apiKey)}&prettyPrint=false`;
  const body = {
    context: input.config.context,
    createBackstagePostParams: encodeCreateBackstagePostParams(input.channelId),
    commentText: input.title,
    clipAttachment: {
      externalVideoId: input.videoId,
      offsetMs: String(input.startMs),
      durationMs: String(input.endMs - input.startMs)
    }
  };

  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const data = parseJson(text);

  if (!response.ok) {
    throw new Error(`YouTube returned HTTP ${response.status}: ${summarizeResponse(data, text)}`);
  }

  const clipUrl = extractClipUrl(data);
  if (!clipUrl) {
    throw new Error(`Clip response did not contain a clip URL: ${summarizeResponse(data, text)}`);
  }

  return {
    clipUrl,
    raw: data
  };
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Missing clip payload.");
  }

  const config = payload.config || {};
  if (!config.apiKey || !config.context) {
    throw new Error("YouTube page config is missing. Refresh the tab and try again.");
  }

  const title = String(payload.title || "").trim();
  if (!title) {
    throw new Error("Clip title is required.");
  }
  if (title.length > 140) {
    throw new Error("Clip title must be 140 characters or less.");
  }

  const videoId = String(payload.videoId || "").trim();
  const channelId = String(payload.channelId || "").trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    throw new Error("Could not determine the source video ID.");
  }
  if (!/^UC[a-zA-Z0-9_-]{22}$/.test(channelId)) {
    throw new Error("Could not determine the source channel ID.");
  }

  const startMs = Math.round(Number(payload.startMs));
  const endMs = Math.round(Number(payload.endMs));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) {
    throw new Error("Invalid clip time range.");
  }

  const durationMs = endMs - startMs;
  if (durationMs < 5000 || durationMs > 60000) {
    throw new Error("Clips must be between 5 and 60 seconds.");
  }

  return {
    config,
    title,
    videoId,
    channelId,
    startMs,
    endMs
  };
}

async function buildHeaders(config) {
  const contextClient = (config.context && config.context.client) || {};
  const headers = {
    "content-type": "application/json",
    "x-origin": YOUTUBE_ORIGIN,
    "x-youtube-bootstrap-logged-in": "true",
    "x-youtube-client-name": String(config.clientName || contextClient.clientName || "1"),
    "x-youtube-client-version": String(config.clientVersion || contextClient.clientVersion || ""),
    "x-goog-authuser": String(config.sessionIndex || "0")
  };

  if (config.visitorData || contextClient.visitorData) {
    headers["x-goog-visitor-id"] = String(config.visitorData || contextClient.visitorData);
  }
  if (config.identityToken) {
    headers["x-youtube-identity-token"] = String(config.identityToken);
  }
  if (config.delegatedSessionId) {
    headers["x-goog-pageid"] = String(config.delegatedSessionId);
  }

  headers.authorization = await buildSapisidHash();
  return headers;
}

async function buildSapisidHash() {
  const cookies = await chrome.cookies.getAll({ url: YOUTUBE_ORIGIN });
  const cookie = AUTH_COOKIE_NAMES
    .map((name) => cookies.find((candidate) => candidate.name === name))
    .find(Boolean);

  if (!cookie || !cookie.value) {
    throw new Error("Could not find a YouTube auth cookie. Make sure you are signed in on youtube.com.");
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const input = `${timestamp} ${cookie.value} ${YOUTUBE_ORIGIN}`;
  const digest = await sha1Hex(input);
  return `SAPISIDHASH ${timestamp}_${digest}`;
}

async function sha1Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeCreateBackstagePostParams(channelId) {
  const channelBytes = new TextEncoder().encode(channelId);
  const bytes = new Uint8Array(2 + channelBytes.length + 2);
  bytes[0] = 0x0a;
  bytes[1] = channelBytes.length;
  bytes.set(channelBytes, 2);
  bytes[2 + channelBytes.length] = 0x10;
  bytes[3 + channelBytes.length] = 0x01;
  return bytesToBase64(bytes);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractClipUrl(data) {
  if (!data) {
    return null;
  }

  const text = JSON.stringify(data);
  const fullMatch = text.match(/https:\/\/www\.youtube\.com\/clip\/[a-zA-Z0-9_-]+/);
  if (fullMatch) {
    return fullMatch[0];
  }

  const pathMatch = text.match(/\/clip\/[a-zA-Z0-9_-]+/);
  if (pathMatch) {
    return `${YOUTUBE_ORIGIN}${pathMatch[0]}`;
  }

  return null;
}

function summarizeResponse(data, text) {
  if (data && data.error && data.error.message) {
    return data.error.message;
  }
  return String(text || "").slice(0, 500);
}
