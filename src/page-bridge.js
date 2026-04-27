(() => {
  const SOURCE = "reclip-page-bridge";
  const TARGET = "reclip-content";
  const YOUTUBE_ORIGIN = "https://www.youtube.com";
  const CREATE_POST_PATH = "/youtubei/v1/backstage/create_post";
  const AUTH_COOKIE_NAMES = ["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"];
  const PANEL_ID = "engagement-panel-clip-create";
  const BUTTON_TARGET_ID = "reclip-native-clip-button";
  const FALLBACK_BUTTON_ID = "reclip-native-action";
  const MIN_CLIP_LENGTH_MS = 5000;
  const MAX_CLIP_LENGTH_MS = 60000;
  const DEFAULT_CLIP_LENGTH_MS = 15000;
  const BUTTON_TRACKING_PARAMS = "RECLIP_NATIVE_CLIP";
  const LOOP_CLEANUP_WINDOW_MS = 2500;
  const LOOP_CLEANUP_DELAYS_MS = [0, 100, 300, 750, 1500, 2500];

  let nativePanel = null;
  let nativeClipElement = null;
  let nativePanelVideoId = "";
  let ensureRunId = 0;
  let postingChannelIdPromise = null;
  let nativeFlowEnabled = false;
  let clipLoopCleanupArmed = false;
  let clipLoopCleanupUntil = 0;
  let nativeClipSessionStarted = false;

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== "reclip-content") {
      return;
    }

    if (event.data.type === "RECLIP_ENSURE_NATIVE_FLOW") {
      nativeFlowEnabled = true;
      void ensureNativeClipFlow();
      return;
    }

    if (event.data.type === "RECLIP_DISABLE_NATIVE_FLOW") {
      nativeFlowEnabled = false;
      disableNativeFlow(event.data.reason || "toggle");
      return;
    }

    if (event.data.type === "RECLIP_GET_PAGE_STATE") {
      postMessageToContent("RECLIP_PAGE_STATE", event.data.requestId, getPageState());
      return;
    }

    if (event.data.type === "RECLIP_CREATE_CLIP") {
      createClip(event.data.payload)
        .then((result) => {
          postMessageToContent("RECLIP_CREATE_RESULT", event.data.requestId, {
            ok: true,
            result
          });
        })
        .catch((error) => {
          postMessageToContent("RECLIP_CREATE_RESULT", event.data.requestId, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
        });
    }
  });

  window.addEventListener("yt-navigate-start", () => {
    resetClipPanelForNavigation("passive");
  });

  window.addEventListener("yt-navigate-finish", () => {
    resetClipPanelForNavigation("passive");
    if (nativeFlowEnabled) {
      setTimeout(() => void ensureNativeClipFlow(), 600);
    }
  });

  function postMessageToContent(type, requestId, payload) {
    window.postMessage({
      source: SOURCE,
      target: TARGET,
      requestId,
      type,
      payload
    }, "*");
  }

  async function ensureNativeClipFlow() {
    const runId = ++ensureRunId;
    if (!nativeFlowEnabled) {
      disableNativeFlow("page");
      return;
    }

    if (!isYouTubeVideoPage()) {
      disableNativeFlow("page");
      return;
    }

    const state = getPageState();
    if (!state.video.videoId) {
      return;
    }

    installNativeClipButton();
    bindNativeClipButtons();
    await delay(0);
    if (runId !== ensureRunId) {
      return;
    }

    installNativeClipButton();
    bindNativeClipButtons();
  }

  function disableNativeFlow(reason = "toggle") {
    if (reason === "page") {
      resetClipPanelForNavigation("passive");
      removeNativeClipButtonData();
      document.getElementById(FALLBACK_BUTTON_ID)?.remove();
      return;
    }

    const panel = findNativeClipPanelElement();
    if (panel) {
      collapseNativeClipPanel(panel);
    } else if (shouldCleanupClipLoop()) {
      queueClipLoopCleanup();
    }
    removeNativeClipButtonData();
    document.getElementById(FALLBACK_BUTTON_ID)?.remove();
    if (nativePanel && nativePanel.id === "reclip-native-clip-panel") {
      nativePanel.remove();
    }
    nativePanel = null;
    nativeClipElement = null;
    nativePanelVideoId = "";
    nativeClipSessionStarted = false;
  }

  function resetClipPanelForNavigation(mode = "active") {
    const panel = findNativeClipPanelElement();
    if (mode === "active" && panel && nativeClipSessionStarted && isNativeClipPanelOpen(panel)) {
      collapseNativeClipPanel(panel);
    } else if (shouldCleanupClipLoop()) {
      queueClipLoopCleanup();
    }
    if (nativePanel && nativePanel.id === "reclip-native-clip-panel") {
      nativePanel.remove();
    }
    nativePanel = null;
    nativeClipElement = null;
    nativePanelVideoId = "";
    nativeClipSessionStarted = false;
  }

  async function ensureNativePanel(state, options = {}) {
    const existingPanel = findNativeClipPanelElement();
    if (existingPanel) {
      nativePanel = existingPanel;
      bindNativePanel(existingPanel);
      if (getPanelVideoId(existingPanel) !== state.video.videoId) {
        setPanelData(existingPanel, await buildPanelData(state));
      }
      nativeClipElement = existingPanel.querySelector("yt-clip-creation-renderer");
      if (nativeClipElement) {
        bindNativeClipElement(nativeClipElement);
        setNativePlayer(nativeClipElement);
      }
      nativePanelVideoId = state.video.videoId;
      return existingPanel;
    }

    const host = findPanelHost();
    if (!host) {
      return null;
    }

    if (!nativePanel || !nativePanel.isConnected) {
      nativePanel = document.createElement("ytd-engagement-panel-section-list-renderer");
      nativePanel.id = "reclip-native-clip-panel";
      host.append(nativePanel);
      bindNativePanel(nativePanel);
    } else if (nativePanel.parentElement !== host) {
      host.append(nativePanel);
      bindNativePanel(nativePanel);
    }

    const panelData = await buildPanelData(state);
    setPanelData(nativePanel, panelData);
    nativePanelVideoId = state.video.videoId;

    await nextFrame();
    await nextFrame();

    nativeClipElement = await waitForElement(nativePanel, "yt-clip-creation-renderer", 1500);
    if (nativeClipElement) {
      bindNativeClipElement(nativeClipElement);
      setNativePlayer(nativeClipElement);
    }

    return nativePanel;
  }

  async function buildPanelData(state) {
    const nativeData = findNativeClipPanelData();
    if (nativeData && getPanelDataVideoId(nativeData) === state.video.videoId) {
      return nativeData;
    }

    return {
      panelIdentifier: PANEL_ID,
      targetId: PANEL_ID,
      identifier: {
        surface: "ENGAGEMENT_PANEL_SURFACE_WATCH",
        tag: PANEL_ID
      },
      visibility: "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN",
      header: {
        engagementPanelTitleHeaderRenderer: {
          title: {
            runs: [
              {
                text: "Clip"
              }
            ]
          },
          visibilityButton: {
            buttonRenderer: {
              style: "STYLE_DEFAULT",
              size: "SIZE_DEFAULT",
              icon: {
                iconType: "CLOSE"
              },
              accessibilityData: {
                accessibilityData: {
                  label: "Close"
                }
              },
              command: {
                changeEngagementPanelVisibilityAction: {
                  targetId: PANEL_ID,
                  visibility: "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"
                }
              }
            }
          }
        }
      },
      content: {
        clipSectionRenderer: {
          contents: [
            {
              clipCreationRenderer: await buildNativeClipData(state)
            }
          ]
        }
      },
      onShowCommands: [
        {
          scrollToEngagementPanelCommand: {
            targetId: PANEL_ID
          }
        }
      ]
    };
  }

  async function buildNativeClipData(state) {
    const video = state.video;
    const durationMs = getDurationMs(video);
    const defaultLengthMs = Math.min(
      DEFAULT_CLIP_LENGTH_MS,
      Math.max(MIN_CLIP_LENGTH_MS, Number.isFinite(durationMs) ? durationMs : DEFAULT_CLIP_LENGTH_MS)
    );
    const saveCommand = await buildCreateBackstagePostCommand(state.config).catch(() => null);

    return {
      externalVideoId: video.videoId,
      displayName: {
        simpleText: video.author || "YouTube"
      },
      userAvatar: buildThumbnail(getAuthorAvatarUrl()),
      publicityLabel: "Public",
      titleInput: {
        clipCreationTextInputRenderer: {
          placeholderText: {
            simpleText: "Add a clip title"
          },
          maxCharacterLimit: 140
        }
      },
      scrubber: {
        clipCreationScrubberRenderer: {
          minLengthMs: MIN_CLIP_LENGTH_MS,
          maxLengthMs: MAX_CLIP_LENGTH_MS,
          defaultLengthMs,
          windowSizeMs: 120000,
          lengthTemplate: "$clip_length seconds",
          startAccessibility: {
            accessibilityData: {
              label: "Start time"
            }
          },
          endAccessibility: {
            accessibilityData: {
              label: "End time"
            }
          },
          durationAccessibility: {
            accessibilityData: {
              label: "Clip duration"
            }
          }
        }
      },
      saveButton: {
        buttonRenderer: {
          style: "STYLE_BLUE_TEXT",
          size: "SIZE_DEFAULT",
          text: {
            runs: [
              {
                text: "Share clip"
              }
            ]
          },
          accessibilityData: {
            accessibilityData: {
              label: "Share clip"
            }
          },
          command: saveCommand || undefined
        }
      },
      cancelButton: {
        buttonRenderer: {
          style: "STYLE_TEXT",
          size: "SIZE_DEFAULT",
          text: {
            runs: [
              {
                text: "Cancel"
              }
            ]
          },
          command: {
            changeEngagementPanelVisibilityAction: {
              targetId: PANEL_ID,
              visibility: "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"
            }
          }
        }
      },
      adStateOverlay: {
        clipAdStateRenderer: {
          title: {
            simpleText: "Clip creation is unavailable during ads"
          },
          body: {
            simpleText: "Wait until the ad is over, then try again."
          }
        }
      }
    };
  }

  async function buildCreateBackstagePostCommand(config) {
    const postingChannelId = await resolvePostingChannelIdCached(config);
    return {
      commandMetadata: {
        webCommandMetadata: {
          sendPost: true,
          apiUrl: CREATE_POST_PATH
        }
      },
      createBackstagePostEndpoint: {
        createBackstagePostParams: encodeCreateBackstagePostParams(postingChannelId)
      }
    };
  }

  function setPanelData(panel, data) {
    setPolymerProperty(panel, "isWatch", true);
    setPolymerProperty(panel, "data", data);
    setPolymerProperty(panel, "visibility", data.visibility || "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
    if (typeof panel.dataChanged === "function") {
      panel.dataChanged();
    }
    if (typeof panel.updateChildVisibilityProperties === "function") {
      panel.updateChildVisibilityProperties();
    }
  }

  function installNativeClipButton() {
    const menu = findWatchMenuRenderer();
    if (menu && menu.data) {
      const currentButtons = Array.isArray(menu.data.topLevelButtons) ? menu.data.topLevelButtons : [];
      const filteredButtons = currentButtons.filter((button) => !isReclipButtonData(button));
      const clipButton = createTopLevelClipButtonData();
      const shareIndex = filteredButtons.findIndex((button) => /share/i.test(getRendererText(button)));
      const insertIndex = shareIndex >= 0 ? shareIndex + 1 : filteredButtons.length;
      filteredButtons.splice(insertIndex, 0, clipButton);
      setPolymerProperty(menu, "data.topLevelButtons", filteredButtons);
      setPolymerProperty(menu, "topLevelButtonData", filteredButtons);
      if (typeof menu.requestUpdate === "function") {
        menu.requestUpdate();
      }
      if (typeof menu.notifyPath === "function") {
        menu.notifyPath("data.topLevelButtons");
      }
      waitForButtonStamp()
        .then((button) => {
          if (!button) {
            installFallbackNativeButton();
          }
          bindNativeClipButtons();
        })
        .catch(() => {
          installFallbackNativeButton();
          bindNativeClipButtons();
        });
      return;
    }

    installFallbackNativeButton();
  }

  function removeNativeClipButtonData() {
    for (const menu of document.querySelectorAll("ytd-menu-renderer")) {
      if (!menu.data || !Array.isArray(menu.data.topLevelButtons)) {
        continue;
      }
      const filteredButtons = menu.data.topLevelButtons.filter((button) => !isReclipButtonData(button));
      if (filteredButtons.length !== menu.data.topLevelButtons.length) {
        setPolymerProperty(menu, "data.topLevelButtons", filteredButtons);
        setPolymerProperty(menu, "topLevelButtonData", filteredButtons);
      }
    }
  }

  function installFallbackNativeButton() {
    const host = findTopLevelButtonsHost();
    if (!host || document.getElementById(FALLBACK_BUTTON_ID)) {
      return;
    }

    const renderer = document.createElement("ytd-button-renderer");
    renderer.id = FALLBACK_BUTTON_ID;
    renderer.classList.add("style-scope", "ytd-menu-renderer");
    setPolymerProperty(renderer, "data", createTopLevelClipButtonData().buttonRenderer);
    placeFallbackNativeButton(host, renderer);
    bindNativeClipButtons();
  }

  function placeFallbackNativeButton(host, renderer) {
    const shareButton = Array.from(host.children).find((child) => /share/i.test(child.textContent || ""));
    if (shareButton && shareButton.nextSibling) {
      host.insertBefore(renderer, shareButton.nextSibling);
      return;
    }
    host.append(renderer);
  }

  function createTopLevelClipButtonData() {
    return {
      buttonRenderer: {
        style: "STYLE_DEFAULT",
        size: "SIZE_DEFAULT",
        targetId: BUTTON_TARGET_ID,
        icon: {
          iconType: "CONTENT_CUT"
        },
        text: {
          runs: [
            {
              text: "Clip"
            }
          ]
        },
        tooltip: "Clip",
        trackingParams: BUTTON_TRACKING_PARAMS,
        accessibilityData: {
          accessibilityData: {
            label: "Create clip"
          }
        },
        command: {
          commandExecutorCommand: {
            commands: [
              {
                changeEngagementPanelVisibilityAction: {
                  targetId: PANEL_ID,
                  visibility: "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"
                }
              },
              {
                scrollToEngagementPanelCommand: {
                  targetId: PANEL_ID
                }
              }
            ]
          }
        }
      }
    };
  }

  async function waitForButtonStamp() {
    const start = Date.now();
    while (Date.now() - start < 1200) {
      const buttons = findNativeClipButtonElements();
      if (buttons.length) {
        return buttons[0];
      }
      await nextFrame();
    }
    return null;
  }

  function bindNativeClipButtons() {
    for (const button of findNativeClipButtonElements()) {
      if (button.dataset.reclipBound === "true") {
        continue;
      }
      button.dataset.reclipBound = "true";
      const activate = (event) => {
        if (isReclipButtonElement(button)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        void openNativeClipPanel();
      };
      button.addEventListener("click", activate, true);
      button.addEventListener("tap", activate, true);
    }
  }

  function findNativeClipButtonElements() {
    const hosts = [
      ...document.querySelectorAll("ytd-watch-metadata #top-level-buttons-computed"),
      ...document.querySelectorAll("ytd-video-primary-info-renderer #top-level-buttons-computed"),
      ...document.querySelectorAll("#top-level-buttons-computed")
    ];
    const buttons = [];

    for (const host of hosts) {
      for (const child of host.children) {
        if (child.id === FALLBACK_BUTTON_ID || isNativeClipButtonElement(child)) {
          buttons.push(child);
        }
      }
    }

    return [...new Set(buttons)];
  }

  function isNativeClipButtonElement(element) {
    const text = String(element.textContent || "").trim();
    const data = element.data || element.buttonRenderer || null;
    return text === "Clip" || isReclipButtonRenderer(data) || element.id === FALLBACK_BUTTON_ID;
  }

  function isReclipButtonElement(element) {
    const data = element?.data || element?.buttonRenderer || null;
    return element?.id === FALLBACK_BUTTON_ID ||
      isReclipButtonRenderer(data) ||
      isReclipButtonRenderer(data?.buttonRenderer) ||
      isReclipButtonRenderer(data?.buttonViewModel);
  }

  async function openNativeClipPanel() {
    const state = getPageState();
    if (!state.video.videoId) {
      return;
    }

    if (!await waitForNativePanelComponents(3500)) {
      return;
    }

    if (!nativePanel || !nativePanel.isConnected || nativePanelVideoId !== state.video.videoId) {
      await ensureNativePanel(state, { open: true });
    }

    if (!nativePanel) {
      return;
    }

    const wasOpen = nativePanelVideoId === state.video.videoId && isNativeClipPanelOpen(nativePanel);
    hideOtherEngagementPanels(nativePanel);
    setPanelVisibility(nativePanel, "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
    setPanelContentVisible(nativePanel, true);
    await nextFrame();
    nativeClipElement = nativePanel.querySelector("yt-clip-creation-renderer");
    if (nativeClipElement) {
      bindNativeClipElement(nativeClipElement);
      setNativePlayer(nativeClipElement);
      clipLoopCleanupArmed = true;
      nativeClipSessionStarted = true;
      if (!wasOpen) {
        setNativeClipVisible(true);
      }
    }
  }

  function hideOtherEngagementPanels(activePanel) {
    for (const panel of document.querySelectorAll("ytd-engagement-panel-section-list-renderer")) {
      if (panel !== activePanel && panel.visibility === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED") {
        setPanelVisibility(panel, "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
      }
    }
  }

  function collapseNativeClipPanel(panel) {
    if (!panel) {
      return;
    }
    setPanelVisibility(panel, "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
    finishNativeClipSession(panel);
  }

  function setPanelVisibility(panel, visibility) {
    if (visibility === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED" && typeof panel.showPanel === "function") {
      panel.showPanel();
    } else if (visibility === "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN" && typeof panel.hidePanel === "function") {
      panel.hidePanel();
    } else {
      setPolymerProperty(panel, "data.visibility", visibility);
      setPolymerProperty(panel, "visibility", visibility);
      if (typeof panel.visibilityChanged === "function") {
        panel.visibilityChanged();
      }
      if (typeof panel.notifyVisibilityChanged === "function") {
        panel.notifyVisibilityChanged(visibility);
      }
    }

    setPolymerProperty(panel, "data.visibility", visibility);
    if (visibility === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED") {
      panel.removeAttribute("hidden");
    } else if (visibility === "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN") {
      panel.setAttribute("hidden", "");
    }
    if (typeof panel.updateChildVisibilityProperties === "function") {
      panel.updateChildVisibilityProperties();
    }
  }

  function setPanelContentVisible(panel, visible) {
    if (!panel) {
      return;
    }
    const section = panel.querySelector("ytd-clip-section-renderer");
    if (!section) {
      return;
    }
    setPolymerProperty(section, "panelContentVisible", visible);
    if (typeof section.onPanelContentVisibleChanged === "function") {
      section.onPanelContentVisibleChanged();
    }
  }

  function bindNativeClipElement(element) {
    if (element.dataset.reclipBound === "true") {
      return;
    }
    element.dataset.reclipBound = "true";
    element.addEventListener("click", onNativeClipActivate, true);
    element.addEventListener("tap", onNativeClipActivate, true);
  }

  function bindNativePanel(panel) {
    if (panel.dataset.reclipPanelBound === "true") {
      return;
    }
    panel.dataset.reclipPanelBound = "true";
    panel.addEventListener("click", onNativePanelActivate, true);
    panel.addEventListener("tap", onNativePanelActivate, true);
    const observer = new MutationObserver(() => {
      if (clipLoopCleanupArmed && !isNativeClipPanelOpen(panel)) {
        queueClipLoopCleanup();
      }
    });
    observer.observe(panel, {
      attributes: true,
      attributeFilter: ["hidden", "style", "class"]
    });
    panel.__reclipPanelObserver = observer;
  }

  function onNativePanelActivate(event) {
    if (!isCloseOrCancelActivation(event)) {
      return;
    }
    setTimeout(() => {
      finishNativeClipSession(nativePanel);
    }, 0);
  }

  function onNativeClipActivate(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const clickedShare = path.some((element) => element && element.id === "share");
    const clickedCancel = path.some((element) => element && element.id === "cancel");

    if (clickedCancel && !hasNativeCancelCommand()) {
      event.preventDefault();
      event.stopPropagation();
      if (nativePanel) {
        collapseNativeClipPanel(nativePanel);
      }
      return;
    }

    if (clickedCancel) {
      setTimeout(() => {
        finishNativeClipSession(nativePanel);
      }, 0);
    }

    if (clickedShare && !hasNativeSubmitCommand()) {
      event.preventDefault();
      event.stopPropagation();
      void createClipFromNative();
    }
  }

  function hasNativeSubmitCommand() {
    return Boolean(
      nativeClipElement &&
      (nativeClipElement.submitCommand_ || nativeClipElement.data?.saveButton?.buttonRenderer?.command)
    );
  }

  function hasNativeCancelCommand() {
    return Boolean(nativeClipElement && nativeClipElement.data?.cancelButton?.buttonRenderer?.command);
  }

  async function createClipFromNative() {
    const state = getPageState();
    const nativeState = readNativeClipState();
    const payload = {
      config: state.config,
      title: nativeState.title,
      videoId: nativeState.videoId || state.video.videoId,
      channelId: state.video.channelId,
      startMs: nativeState.startMs,
      endMs: nativeState.endMs
    };
    const result = await createClip(payload);
    await navigator.clipboard.writeText(result.clipUrl).catch(() => {});
    if (nativePanel) {
      setPanelVisibility(nativePanel, "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
      finishNativeClipSession(nativePanel);
    }
    showNativeToast("Clip link copied.", result.clipUrl);
  }

  function readNativeClipState() {
    const titleInput = nativeClipElement && nativeClipElement.querySelector("ytd-clip-creation-text-input-renderer");
    const scrubber = nativeClipElement && nativeClipElement.querySelector("yt-clip-creation-scrubber-renderer");
    const title = String(
      nativeClipElement && nativeClipElement.titleValue ||
      titleInput && titleInput.value ||
      ""
    );
    const start = Number(
      nativeClipElement && nativeClipElement.start ||
      scrubber && scrubber.start ||
      0
    );
    const end = Number(
      nativeClipElement && nativeClipElement.end ||
      scrubber && scrubber.end ||
      0
    );

    return {
      title,
      videoId: String(nativeClipElement && nativeClipElement.videoId || ""),
      startMs: Math.round(start * 1000),
      endMs: Math.round(end * 1000)
    };
  }

  function setNativePlayer(element) {
    const player = document.querySelector("#movie_player");
    if (!player) {
      return;
    }

    for (const candidate of [element, ...element.querySelectorAll("*")]) {
      if (typeof candidate.setPlayer === "function") {
        candidate.setPlayer(player);
      }
    }
  }

  function setNativeClipVisible(visible) {
    if (!nativeClipElement) {
      return;
    }

    for (const element of [nativeClipElement, ...nativeClipElement.querySelectorAll("*")]) {
      if (typeof element.onVisibilityChangedAction_ === "function") {
        element.onVisibilityChangedAction_({ visible });
      }
      if (typeof element.onClipCreationVisibilityChange === "function") {
        element.onClipCreationVisibilityChange({ visible });
      }
    }
  }

  function finishNativeClipSession(panel) {
    if (panel) {
      setPanelContentVisible(panel, false);
    }
    const clipElement = panel?.querySelector("yt-clip-creation-renderer");
    if (clipElement) {
      const previousClipElement = nativeClipElement;
      nativeClipElement = clipElement;
      setNativeClipVisible(false);
      nativeClipElement = previousClipElement;
    } else {
      setNativeClipVisible(false);
    }
    queueClipLoopCleanup();
  }

  function isCloseOrCancelActivation(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    return path.some((element) => {
      if (!element || typeof element.getAttribute !== "function") {
        return false;
      }
      const tagName = String(element.tagName || "");
      const isActionElement = element.id === "cancel" ||
        element.getAttribute("role") === "button" ||
        tagName === "BUTTON" ||
        /BUTTON/.test(tagName);
      if (!isActionElement) {
        return false;
      }
      const label = [
        element.id,
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.textContent
      ].filter(Boolean).join(" ").trim();
      return /(^|\s)(close|cancel)(\s|$)/i.test(label);
    });
  }

  function isNativeClipPanelOpen(panel) {
    if (!panel || !panel.isConnected || panel.hasAttribute("hidden")) {
      return false;
    }
    const visibility = panel.visibility || panel.data?.visibility || "";
    return visibility === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED" || !visibility;
  }

  function clearClipLoopRange() {
    const player = document.querySelector("#movie_player");
    if (!player || typeof player.setLoopRange !== "function") {
      if (Date.now() > clipLoopCleanupUntil) {
        clipLoopCleanupArmed = false;
      }
      return;
    }

    const cleanupActive = clipLoopCleanupArmed || Date.now() <= clipLoopCleanupUntil;
    const loopRange = callPlayer(player, "getLoopRange");
    const shouldClear = loopRange
      ? isClipLoopRange(loopRange, cleanupActive)
      : cleanupActive;
    if (shouldClear) {
      callPlayer(player, "setLoopRange", null);
    }
    if (Date.now() > clipLoopCleanupUntil) {
      clipLoopCleanupArmed = false;
    }
  }

  function queueClipLoopCleanup() {
    if (!shouldCleanupClipLoop()) {
      return;
    }
    clipLoopCleanupArmed = true;
    clipLoopCleanupUntil = Math.max(clipLoopCleanupUntil, Date.now() + LOOP_CLEANUP_WINDOW_MS);
    for (const delayMs of LOOP_CLEANUP_DELAYS_MS) {
      setTimeout(clearClipLoopRange, delayMs);
    }
  }

  function shouldCleanupClipLoop() {
    return nativeClipSessionStarted ||
      clipLoopCleanupArmed ||
      Date.now() <= clipLoopCleanupUntil;
  }

  function isClipLoopRange(loopRange, cleanupActive) {
    if (!loopRange || typeof loopRange !== "object") {
      return false;
    }
    if (loopRange.type === "clips") {
      return true;
    }
    if (loopRange.type) {
      return false;
    }
    return cleanupActive && isClipLengthLoopRange(loopRange);
  }

  function isClipLengthLoopRange(loopRange) {
    const startMs = Number(loopRange.startTimeMs);
    const endMs = Number(loopRange.endTimeMs);
    return Number.isFinite(startMs) &&
      Number.isFinite(endMs) &&
      endMs > startMs &&
      endMs - startMs >= MIN_CLIP_LENGTH_MS &&
      endMs - startMs <= MAX_CLIP_LENGTH_MS;
  }

  function showNativeToast(message, clipUrl) {
    if (!customElements.get("yt-notification-action-renderer")) {
      if (clipUrl) {
        window.open(clipUrl, "_blank", "noopener,noreferrer");
      }
      return;
    }

    const toast = document.createElement("yt-notification-action-renderer");
    setPolymerProperty(toast, "data", {
      responseText: {
        runs: [
          {
            text: message
          }
        ]
      },
      actionButton: clipUrl ? {
        buttonRenderer: {
          text: {
            runs: [
              {
                text: "Open"
              }
            ]
          },
          navigationEndpoint: {
            commandMetadata: {
              webCommandMetadata: {
                url: clipUrl,
                webPageType: "WEB_PAGE_TYPE_UNKNOWN",
                rootVe: 83769
              }
            },
            urlEndpoint: {
              url: clipUrl,
              target: "TARGET_NEW_WINDOW"
            }
          }
        }
      } : undefined
    });
    document.body.append(toast);
    if (typeof toast.open === "function") {
      toast.open(5000);
    }
    setTimeout(() => toast.remove(), 6000);
  }

  function findNativeClipPanelElement() {
    return Array.from(document.querySelectorAll("ytd-engagement-panel-section-list-renderer"))
      .find((panel) => {
        const data = panel.data || {};
        return data.panelIdentifier === PANEL_ID ||
          data.targetId === PANEL_ID ||
          data.identifier?.tag === PANEL_ID ||
          Boolean(data.content?.clipSectionRenderer);
      }) || null;
  }

  function getPanelVideoId(panel) {
    return getPanelDataVideoId(panel?.data) ||
      String(panel?.querySelector("yt-clip-creation-renderer")?.videoId || "");
  }

  function getPanelDataVideoId(data) {
    if (!data || typeof data !== "object") {
      return "";
    }
    const contents = data.content?.clipSectionRenderer?.contents;
    if (!Array.isArray(contents)) {
      return "";
    }
    for (const item of contents) {
      const videoId = item?.clipCreationRenderer?.externalVideoId;
      if (videoId) {
        return String(videoId);
      }
    }
    return "";
  }

  function findNativeClipPanelData() {
    const sources = [
      window.ytInitialData,
      window.ytInitialPlayerResponse
    ];

    for (const source of sources) {
      const match = findFirst(source, (value) => {
        const renderer = value && value.engagementPanelSectionListRenderer;
        if (!renderer) {
          return false;
        }
        return renderer.panelIdentifier === PANEL_ID ||
          renderer.targetId === PANEL_ID ||
          renderer.identifier?.tag === PANEL_ID ||
          Boolean(renderer.content?.clipSectionRenderer);
      });
      if (match?.engagementPanelSectionListRenderer) {
        return structuredCloneSafe(match.engagementPanelSectionListRenderer);
      }
    }

    return null;
  }

  function findFirst(value, predicate, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) {
      return null;
    }
    seen.add(value);
    if (predicate(value)) {
      return value;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findFirst(item, predicate, seen);
        if (found) {
          return found;
        }
      }
      return null;
    }
    for (const item of Object.values(value)) {
      const found = findFirst(item, predicate, seen);
      if (found) {
        return found;
      }
    }
    return null;
  }

  function structuredCloneSafe(value) {
    try {
      return structuredClone(value);
    } catch {
      return JSON.parse(JSON.stringify(value));
    }
  }

  function findPanelHost() {
    const selectors = [
      "ytd-watch-flexy #panels",
      "ytd-watch-grid #panels",
      "ytd-watch-learning-journey #panels",
      "#secondary-inner #panels",
      "#panels"
    ];

    for (const selector of selectors) {
      const host = document.querySelector(selector);
      if (host && host.isConnected) {
        return host;
      }
    }

    return null;
  }

  function findWatchMenuRenderer() {
    const selectors = [
      "ytd-watch-metadata #actions ytd-menu-renderer",
      "ytd-watch-metadata #menu ytd-menu-renderer",
      "ytd-watch-metadata ytd-menu-renderer",
      "ytd-video-primary-info-renderer ytd-menu-renderer",
      "#menu ytd-menu-renderer",
      "ytd-menu-renderer"
    ];

    const menus = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    return [...new Set(menus)].find((menu) => {
      if (!menu || !menu.isConnected || !menu.data) {
        return false;
      }
      const text = `${menu.textContent || ""} ${JSON.stringify(menu.data).slice(0, 12000)}`;
      return Array.isArray(menu.data.topLevelButtons) && /share|save|download|like/i.test(text);
    }) || null;
  }

  function findTopLevelButtonsHost() {
    const selectors = [
      "ytd-watch-metadata #actions-inner #menu #top-level-buttons-computed",
      "ytd-watch-metadata #actions #top-level-buttons-computed",
      "ytd-watch-metadata #top-level-buttons-computed",
      "ytd-video-primary-info-renderer #top-level-buttons-computed",
      "#top-level-buttons-computed"
    ];

    for (const selector of selectors) {
      const host = document.querySelector(selector);
      if (host && host.isConnected) {
        return host;
      }
    }

    return null;
  }

  function isReclipButtonData(button) {
    return isReclipButtonRenderer(button?.buttonRenderer) || isReclipButtonRenderer(button?.buttonViewModel);
  }

  function isReclipButtonRenderer(renderer) {
    if (!renderer || typeof renderer !== "object") {
      return false;
    }
    return renderer.targetId === BUTTON_TARGET_ID || renderer.trackingParams === BUTTON_TRACKING_PARAMS;
  }

  function getRendererText(renderer) {
    if (!renderer || typeof renderer !== "object") {
      return "";
    }
    const target = renderer.buttonRenderer || renderer.buttonViewModel || renderer.toggleButtonRenderer || renderer;
    return [
      getText(target.text),
      getText(target.title),
      target.tooltip,
      target.accessibilityData?.accessibilityData?.label,
      target.accessibility?.label
    ].filter(Boolean).join(" ");
  }

  function getText(value) {
    if (!value) {
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    if (typeof value.content === "string") {
      return value.content;
    }
    if (typeof value.simpleText === "string") {
      return value.simpleText;
    }
    if (typeof value.text === "string") {
      return value.text;
    }
    if (Array.isArray(value.runs)) {
      return value.runs.map((run) => run.text || "").join("");
    }
    return "";
  }

  function setPolymerProperty(element, path, value) {
    if (!element) {
      return;
    }
    if (typeof element.set === "function") {
      element.set(path, value);
      return;
    }
    assignPath(element, path, value);
  }

  function assignPath(object, path, value) {
    const parts = String(path).split(".");
    let target = object;
    for (const part of parts.slice(0, -1)) {
      if (!target[part] || typeof target[part] !== "object") {
        target[part] = {};
      }
      target = target[part];
    }
    target[parts[parts.length - 1]] = value;
  }

  async function waitForNativePanelComponents(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (
        customElements.get("ytd-engagement-panel-section-list-renderer") &&
        customElements.get("yt-clip-creation-renderer") &&
        customElements.get("yt-clip-creation-scrubber-renderer") &&
        customElements.get("ytd-clip-creation-text-input-renderer") &&
        customElements.get("ytd-clip-section-renderer")
      ) {
        return true;
      }
      await delay(100);
    }
    return false;
  }

  async function waitForElement(root, selector, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const element = root.querySelector(selector);
      if (element) {
        return element;
      }
      await nextFrame();
    }
    return null;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  function isYouTubeVideoPage() {
    return location.hostname.endsWith("youtube.com") && location.pathname === "/watch" && new URL(location.href).searchParams.has("v");
  }

  function getYtcfgValue(key) {
    try {
      return window.ytcfg && typeof window.ytcfg.get === "function" ? window.ytcfg.get(key) : undefined;
    } catch {
      return undefined;
    }
  }

  function findYtcfgChannelId() {
    const direct = [
      getYtcfgValue("CHANNEL_ID"),
      getYtcfgValue("CURRENT_CHANNEL_ID"),
      getYtcfgValue("ACCOUNT_CHANNEL_ID"),
      getYtcfgValue("DELEGATED_SESSION_ID")
    ].find(isChannelId);

    if (direct) {
      return direct;
    }

    try {
      const data = window.ytcfg && window.ytcfg.data_;
      if (!data || typeof data !== "object") {
        return "";
      }

      for (const [key, value] of Object.entries(data)) {
        if (/(CHANNEL|DELEGATED)/.test(key) && isChannelId(value)) {
          return value;
        }
      }
    } catch {
      return "";
    }

    return "";
  }

  function isChannelId(value) {
    return /^UC[a-zA-Z0-9_-]{22}$/.test(String(value || ""));
  }

  function getPageState() {
    const ytcfgGet = getYtcfgValue;
    const player = document.querySelector("#movie_player");
    const videoData = callPlayer(player, "getVideoData") || {};
    const playerResponse = getPlayerResponse(player);
    const videoDetails = (playerResponse && playerResponse.videoDetails) || {};
    const loopRange = callPlayer(player, "getLoopRange") || null;
    const currentTime = Number(callPlayer(player, "getCurrentTime")) || 0;
    const duration = Number(callPlayer(player, "getDuration")) || Number(videoDetails.lengthSeconds) || 0;
    const context = ytcfgGet("INNERTUBE_CONTEXT");
    const contextClient = (context && context.client) || {};

    return {
      url: location.href,
      config: {
        apiKey: ytcfgGet("INNERTUBE_API_KEY"),
        context,
        visitorData: ytcfgGet("VISITOR_DATA") || contextClient.visitorData,
        sessionIndex: ytcfgGet("SESSION_INDEX"),
        delegatedSessionId: ytcfgGet("DELEGATED_SESSION_ID"),
        identityToken: ytcfgGet("ID_TOKEN"),
        clientName: ytcfgGet("INNERTUBE_CONTEXT_CLIENT_NAME") || ytcfgGet("INNERTUBE_CLIENT_NAME") || contextClient.clientName,
        clientVersion: ytcfgGet("INNERTUBE_CLIENT_VERSION") || contextClient.clientVersion,
        loggedIn: Boolean(ytcfgGet("LOGGED_IN")),
        postingChannelId: findYtcfgChannelId()
      },
      video: {
        videoId: videoData.video_id || videoDetails.videoId || getVideoIdFromUrl(),
        channelId: videoData.ucid || videoDetails.channelId || getChannelIdFromInitialData(),
        title: videoData.title || videoDetails.title || document.title.replace(/ - YouTube$/, ""),
        author: videoData.author || videoDetails.author || "",
        currentTime,
        duration,
        loopRange: normalizeLoopRange(loopRange)
      }
    };
  }

  function callPlayer(player, method, ...args) {
    try {
      return player && typeof player[method] === "function" ? player[method](...args) : undefined;
    } catch {
      return undefined;
    }
  }

  function getPlayerResponse(player) {
    const fromPlayer = callPlayer(player, "getPlayerResponse");
    if (fromPlayer) {
      return fromPlayer;
    }
    return window.ytInitialPlayerResponse || null;
  }

  function normalizeLoopRange(loopRange) {
    if (!loopRange || typeof loopRange !== "object") {
      return null;
    }

    const startMs = Number(loopRange.startTimeMs);
    const endMs = Number(loopRange.endTimeMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return null;
    }

    return {
      startMs,
      endMs,
      type: loopRange.type || ""
    };
  }

  function getDurationMs(video) {
    const durationMs = Number(video.duration || 0) * 1000;
    return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : Number.MAX_SAFE_INTEGER;
  }

  function getAuthorAvatarUrl() {
    const img = document.querySelector("ytd-video-owner-renderer #avatar img, #owner #avatar img, ytd-channel-name img");
    return img && img.src ? img.src : "";
  }

  function buildThumbnail(url) {
    if (!url) {
      return {
        thumbnails: []
      };
    }

    return {
      thumbnails: [
        {
          url,
          width: 64,
          height: 64
        }
      ]
    };
  }

  async function createClip(payload) {
    const input = validatePayload(payload);
    const headers = await buildHeaders(input.config);
    const postingChannelId = await resolvePostingChannelIdCached(input.config);
    const url = `${YOUTUBE_ORIGIN}${CREATE_POST_PATH}?key=${encodeURIComponent(input.config.apiKey)}&prettyPrint=false`;
    const body = {
      context: input.config.context,
      createBackstagePostParams: encodeCreateBackstagePostParams(postingChannelId),
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
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      throw new Error("Could not determine the source video ID.");
    }

    const startMs = Math.round(Number(payload.startMs));
    const endMs = Math.round(Number(payload.endMs));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) {
      throw new Error("Invalid clip time range.");
    }

    const durationMs = endMs - startMs;
    if (durationMs < MIN_CLIP_LENGTH_MS || durationMs > MAX_CLIP_LENGTH_MS) {
      throw new Error("Clips must be between 5 and 60 seconds.");
    }

    return {
      config,
      title,
      videoId,
      startMs,
      endMs
    };
  }

  async function resolvePostingChannelIdCached(config) {
    const direct = [
      config.postingChannelId,
      config.delegatedSessionId,
      getYtcfgValue("CHANNEL_ID"),
      getYtcfgValue("CURRENT_CHANNEL_ID"),
      getYtcfgValue("ACCOUNT_CHANNEL_ID")
    ].find(isChannelId);

    if (direct) {
      return direct;
    }

    if (!postingChannelIdPromise) {
      postingChannelIdPromise = fetchAccountAdvancedChannelId();
    }
    return postingChannelIdPromise;
  }

  async function fetchAccountAdvancedChannelId() {
    const response = await fetch(`${YOUTUBE_ORIGIN}/account_advanced`, {
      credentials: "include"
    });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`Could not load YouTube account settings: HTTP ${response.status}`);
    }

    const channelId = extractAccountAdvancedChannelId(text);
    if (!channelId) {
      throw new Error("Could not determine your signed-in YouTube channel ID.");
    }
    return channelId;
  }

  function extractAccountAdvancedChannelId(text) {
    const channelLabelIndex = text.indexOf("Channel ID");
    const scopedText = channelLabelIndex >= 0 ? text.slice(channelLabelIndex, channelLabelIndex + 20000) : text;
    const match = scopedText.match(/UC[a-zA-Z0-9_-]{22}/);
    return match ? match[0] : "";
  }

  async function buildHeaders(config) {
    const contextClient = (config.context && config.context.client) || {};
    const headers = {
      "authorization": await buildSapisidHash(),
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

    return headers;
  }

  async function buildSapisidHash() {
    const cookieValue = AUTH_COOKIE_NAMES.map(getCookieValue).find(Boolean);
    if (!cookieValue) {
      throw new Error("Could not find a YouTube auth cookie. Make sure you are signed in on youtube.com.");
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const input = `${timestamp} ${cookieValue} ${YOUTUBE_ORIGIN}`;
    const digest = await sha1Hex(input);
    return `SAPISIDHASH ${timestamp}_${digest}`;
  }

  function getCookieValue(name) {
    const prefix = `${name}=`;
    return document.cookie
      .split(";")
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith(prefix))
      ?.slice(prefix.length) || "";
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

    for (const serializedShareEntity of findSerializedShareEntities(data)) {
      const clipId = extractClipIdFromSerializedShareEntity(serializedShareEntity);
      if (clipId) {
        return `${YOUTUBE_ORIGIN}/clip/${clipId}`;
      }
    }

    return null;
  }

  function findSerializedShareEntities(value, results = []) {
    if (!value || typeof value !== "object") {
      return results;
    }

    if (typeof value.serializedShareEntity === "string") {
      results.push(value.serializedShareEntity);
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        findSerializedShareEntities(item, results);
      }
      return results;
    }

    for (const item of Object.values(value)) {
      findSerializedShareEntities(item, results);
    }
    return results;
  }

  function extractClipIdFromSerializedShareEntity(value) {
    const decoded = decodeBase64ToBinaryString(value);
    const match = decoded.match(/Ug[a-zA-Z0-9_-]{20,}/);
    return match ? match[0] : "";
  }

  function decodeBase64ToBinaryString(value) {
    try {
      const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
      return atob(padded);
    } catch {
      return "";
    }
  }

  function summarizeResponse(data, text) {
    if (data && data.error && data.error.message) {
      return data.error.message;
    }
    return String(text || "").slice(0, 500);
  }

  function getVideoIdFromUrl() {
    const url = new URL(location.href);
    return url.searchParams.get("v") || "";
  }

  function getChannelIdFromInitialData() {
    const text = JSON.stringify(window.ytInitialPlayerResponse || window.ytInitialData || {});
    const match = text.match(/"channelId":"(UC[a-zA-Z0-9_-]{22})"/);
    return match ? match[1] : "";
  }
})();
