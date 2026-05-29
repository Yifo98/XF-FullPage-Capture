(() => {
  const VERSION = "0.2.0";
  const SCROLL_STRIDE_RATIO = 0.92;
  const STABILITY_SAMPLE_MS = 120;

  if (window.__xfFullPageCaptureVersion === VERSION) {
    return;
  }
  window.__xfFullPageCaptureVersion = VERSION;

  const state = {
    target: null,
    isWindow: true,
    originalScrollTop: 0,
    originalOverflowAnchor: "",
    originalTargetScrollBehavior: "",
    styleNode: null,
    hiddenNodes: new Map()
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "XF_MEASURE_CAPTURE") {
      Promise.resolve().then(measureCapture).then(sendResponse).catch((error) => {
        sendResponse({ ok: false, error: error.message || String(error) });
      });
      return true;
    }

    if (message?.type === "XF_PREPARE_CAPTURE") {
      Promise.resolve().then(prepareCapture).then(sendResponse).catch((error) => {
        sendResponse({ ok: false, error: error.message || String(error) });
      });
      return true;
    }

    if (message?.type === "XF_SCROLL_TO") {
      Promise.resolve().then(() => scrollToStep(message.step, message.index)).then(sendResponse).catch((error) => {
        sendResponse({ ok: false, error: error.message || String(error) });
      });
      return true;
    }

    if (message?.type === "XF_RESTORE_CAPTURE") {
      restoreCapture();
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === "XF_LIST_IFRAMES") {
      sendResponse({ ok: true, frames: listIframes() });
      return true;
    }

    if (message?.type === "XF_GET_VIEWPORT") {
      sendResponse({ ok: true, viewport: getViewport() });
      return true;
    }

    return false;
  });

  async function measureCapture() {
    const targetInfo = findBestScrollTarget();
    const metrics = getMetricsFor(targetInfo.element, targetInfo.isWindow);
    return {
      ok: true,
      target: buildTargetPayload(targetInfo, metrics)
    };
  }

  async function prepareCapture() {
    restoreCapture();

    const targetInfo = findBestScrollTarget();
    state.target = targetInfo.element;
    state.isWindow = targetInfo.isWindow;
    state.originalScrollTop = getScrollTop();
    state.originalOverflowAnchor = document.documentElement.style.overflowAnchor;
    state.originalTargetScrollBehavior = state.target?.style?.scrollBehavior || "";
    document.documentElement.style.overflowAnchor = "none";
    if (state.target?.style) {
      state.target.style.scrollBehavior = "auto";
    }

    state.styleNode = document.createElement("style");
    state.styleNode.id = "xf-fullpage-capture-style";
    state.styleNode.textContent = `
      html {
        scroll-behavior: auto !important;
      }
      *, *::before, *::after {
        scroll-behavior: auto !important;
        animation-play-state: paused !important;
        transition-duration: 0s !important;
      }
    `;
    document.documentElement.appendChild(state.styleNode);

    const metrics = await waitForStableMetrics();
    return {
      ok: true,
      target: buildTargetPayload(targetInfo, metrics)
    };
  }

  async function scrollToStep(step, index) {
    setScrollTop(step.scrollTop);
    updateRepeatedFixedVisibility(index);
    const metrics = await waitForStableMetrics();
    const scrollTop = getScrollTop();
    const targetVisibleHeight = Math.min(metrics.visibleHeight, Math.max(0, metrics.totalHeight - scrollTop));
    const isAtEnd = scrollTop + metrics.visibleHeight >= metrics.totalHeight - 2;
    const stride = Math.max(260, Math.floor(metrics.visibleHeight * SCROLL_STRIDE_RATIO));
    const lastTop = Math.max(0, metrics.totalHeight - metrics.visibleHeight);
    const nextScrollTop = isAtEnd ? scrollTop : Math.min(scrollTop + stride, lastTop);

    return {
      ok: true,
      scrollTop,
      nextScrollTop,
      isAtEnd,
      totalHeight: metrics.totalHeight,
      cropRect: metrics.cropRect,
      viewport: getViewport(),
      targetVisibleHeight
    };
  }

  function restoreCapture() {
    for (const [node, previous] of state.hiddenNodes) {
      node.style.visibility = previous.visibility;
    }
    state.hiddenNodes.clear();

    if (state.target) {
      setScrollTop(state.originalScrollTop);
      if (state.target.style) {
        state.target.style.scrollBehavior = state.originalTargetScrollBehavior || "";
      }
    }
    if (state.styleNode?.isConnected) {
      state.styleNode.remove();
    }
    document.documentElement.style.overflowAnchor = state.originalOverflowAnchor || "";

    state.target = null;
    state.isWindow = true;
    state.originalScrollTop = 0;
    state.originalOverflowAnchor = "";
    state.originalTargetScrollBehavior = "";
    state.styleNode = null;
  }

  function findBestScrollTarget() {
    const scrollingElement = document.scrollingElement || document.documentElement;
    const windowScore = scoreWindow(scrollingElement);
    const candidates = [];

    for (const element of document.body?.querySelectorAll("*") || []) {
      const style = window.getComputedStyle(element);
      const overflowY = style.overflowY;
      if (!/(auto|scroll|overlay)/.test(overflowY)) {
        continue;
      }
      if (element.scrollHeight - element.clientHeight < 220) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width < 320 || rect.height < 260) {
        continue;
      }
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) {
        continue;
      }
      const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
      const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
      if (visibleHeight <= 0 || visibleWidth <= 0) {
        continue;
      }
      const scrollableRatio = element.scrollHeight / Math.max(element.clientHeight, 1);
      const viewportCoverage = (visibleHeight * visibleWidth) / Math.max(window.innerWidth * window.innerHeight, 1);
      const score = element.scrollHeight * visibleWidth * Math.min(scrollableRatio, 10) * Math.min(Math.max(viewportCoverage, 0.15), 1);
      candidates.push({ element, rect, score, label: labelFor(element), isWindow: false });
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    if (best && best.score > windowScore * 1.05) {
      return best;
    }

    return {
      isWindow: true,
      element: scrollingElement,
      label: "Page window",
      score: windowScore
    };
  }

  function scoreWindow(scrollingElement) {
    const scrollableHeight = Math.max(scrollingElement.scrollHeight - window.innerHeight, 0);
    const scrollableRatio = scrollingElement.scrollHeight / Math.max(window.innerHeight, 1);
    return Math.max(scrollingElement.scrollHeight * window.innerWidth * Math.min(scrollableRatio, 10), scrollableHeight * 1000);
  }

  function buildTargetPayload(targetInfo, metrics) {
    return {
      mode: targetInfo.isWindow ? "window" : "inner-scroll",
      label: targetInfo.label,
      score: targetInfo.score,
      totalHeight: metrics.totalHeight,
      totalWidth: metrics.totalWidth,
      visibleHeight: metrics.visibleHeight,
      visibleWidth: metrics.visibleWidth,
      frameUrl: location.href,
      isTopFrame: window.top === window
    };
  }

  function labelFor(element) {
    const parts = [];
    if (element.id) {
      parts.push(`#${element.id}`);
    }
    if (element.className && typeof element.className === "string") {
      parts.push(`.${element.className.trim().split(/\s+/).slice(0, 3).join(".")}`);
    }
    return parts.join("") || element.tagName.toLowerCase();
  }

  function getMetrics() {
    return getMetricsFor(state.target || document.scrollingElement || document.documentElement, state.isWindow);
  }

  function getMetricsFor(target, isWindow) {
    if (isWindow) {
      const scrollingElement = target || document.scrollingElement || document.documentElement;
      return {
        totalHeight: scrollingElement.scrollHeight,
        totalWidth: Math.min(scrollingElement.scrollWidth, window.innerWidth),
        visibleHeight: window.innerHeight,
        visibleWidth: window.innerWidth,
        cropRect: {
          x: 0,
          y: 0,
          width: window.innerWidth,
          height: window.innerHeight
        }
      };
    }

    const rect = target.getBoundingClientRect();
    const left = clamp(rect.left, 0, window.innerWidth);
    const top = clamp(rect.top, 0, window.innerHeight);
    const right = clamp(rect.right, 0, window.innerWidth);
    const bottom = clamp(rect.bottom, 0, window.innerHeight);

    return {
      totalHeight: target.scrollHeight,
      totalWidth: Math.min(target.scrollWidth, right - left),
      visibleHeight: Math.max(0, bottom - top),
      visibleWidth: Math.max(0, right - left),
      cropRect: {
        x: left,
        y: top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top)
      }
    };
  }

  function getScrollTop() {
    if (state.isWindow) {
      return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    }
    return state.target.scrollTop;
  }

  function setScrollTop(value) {
    if (state.isWindow) {
      window.scrollTo(0, value);
      return;
    }
    state.target.scrollTop = value;
  }

  async function waitForStableMetrics() {
    await waitForPaint();
    let previous = metricsKey(getMetrics());
    let stableCount = 0;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await sleep(STABILITY_SAMPLE_MS);
      await waitForPaint();
      const next = metricsKey(getMetrics());
      if (next === previous) {
        stableCount += 1;
        if (stableCount >= 2) {
          break;
        }
      } else {
        stableCount = 0;
      }
      previous = next;
    }

    return getMetrics();
  }

  function metricsKey(metrics) {
    return [
      Math.round(getScrollTop()),
      Math.round(metrics.totalHeight),
      Math.round(metrics.visibleHeight),
      Math.round(metrics.cropRect.y),
      Math.round(metrics.cropRect.height)
    ].join(":");
  }

  function updateRepeatedFixedVisibility(index) {
    const fixedNodes = Array.from(document.body?.querySelectorAll("*") || []).filter((node) => {
      if (!state.isWindow && !state.target.contains(node)) {
        return false;
      }
      const position = window.getComputedStyle(node).position;
      if (position !== "fixed" && position !== "sticky") {
        return false;
      }
      const rect = node.getBoundingClientRect();
      const cropRect = getMetrics().cropRect;
      const intersectsCrop = rect.right > cropRect.x
        && rect.left < cropRect.x + cropRect.width
        && rect.bottom > cropRect.y
        && rect.top < cropRect.y + cropRect.height;
      return intersectsCrop && rect.width > 80 && rect.height > 24;
    });

    for (const node of fixedNodes) {
      if (!state.hiddenNodes.has(node)) {
        state.hiddenNodes.set(node, { visibility: node.style.visibility });
      }
      node.style.visibility = index === 0 ? state.hiddenNodes.get(node).visibility : "hidden";
    }
  }

  function listIframes() {
    return Array.from(document.querySelectorAll("iframe, frame")).map((element, index) => {
      const rect = element.getBoundingClientRect();
      return {
        index,
        src: element.src || element.getAttribute("src") || "",
        id: element.id || "",
        name: element.name || "",
        title: element.title || "",
        rect: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height
        }
      };
    });
  }

  function getViewport() {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1
    };
  }

  function waitForPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
})();
