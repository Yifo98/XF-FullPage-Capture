const captures = new Map();
const runningTabs = new Set();

let lastVisibleTabCaptureAt = 0;
let visibleTabCaptureQueue = Promise.resolve();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CAPTURE_INTERVAL_MS = 1125;
const MAX_SLICES = 180;
const CAPTURE_INDEX_KEY = "xfCaptureIndex";
const MAX_STORED_CAPTURES = 3;

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) {
    return;
  }

  if (runningTabs.has(tab.id)) {
    showPageAlert(tab.id, "Full page capture is already running for this tab.").catch(() => {});
    return;
  }

  runningTabs.add(tab.id);
  startCapture(tab).catch(async (error) => {
    console.error(error);
    await showPageAlert(tab.id, `Full page capture failed: ${error.message || error}`).catch(() => {});
  }).finally(() => {
    runningTabs.delete(tab.id);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_CAPTURE_META") {
    getCapture(message.captureId).then((payload) => {
      if (!payload) {
        sendResponse({ ok: false, error: "Capture expired. Please run the capture again." });
        return;
      }
      sendResponse({
        ok: true,
        payload: {
          ...payload,
          slices: payload.slices.map(({ dataUrl: _dataUrl, ...slice }) => slice)
        }
      });
    }).catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  }

  if (message?.type === "GET_CAPTURE_SLICE") {
    getCapture(message.captureId).then((payload) => {
      const slice = payload?.slices?.[message.index];
      if (!slice) {
        sendResponse({ ok: false, error: `Slice ${message.index + 1} is missing.` });
        return;
      }
      sendResponse({ ok: true, slice });
    }).catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  }

  if (message?.type === "LIST_CAPTURES") {
    listCaptures().then((captures) => {
      sendResponse({ ok: true, captures });
    }).catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  }

  if (message?.type === "FORGET_CAPTURE") {
    removeCapture(message.captureId).then(() => {
      sendResponse({ ok: true });
    }).catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  }

  if (message?.type === "CLEAR_CAPTURES") {
    clearCaptures().then((captureIds) => {
      sendResponse({ ok: true, captureIds });
    }).catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  }

  return false;
});

async function startCapture(tab) {
  if (!tab?.id || !tab.windowId) {
    throw new Error("No active tab found.");
  }

  if (!canInject(tab.url)) {
    throw new Error("Chrome does not allow capture scripts on this page. Try a normal http/https page.");
  }

  await injectCaptureScripts(tab.id);
  const targetFrame = await chooseCaptureFrame(tab.id);
  const topViewport = await getTopViewport(tab.id);
  const prepared = await sendToFrame(tab.id, targetFrame.frameId, { type: "XF_PREPARE_CAPTURE" });
  if (!prepared?.ok) {
    throw new Error(prepared?.error || "Could not prepare the page.");
  }

  const frameOffset = targetFrame.offset || { x: 0, y: 0 };
  const target = {
    ...prepared.target,
    frameId: targetFrame.frameId,
    frameUrl: targetFrame.url,
    frameLabel: targetFrame.frameId === 0 ? "top frame" : "iframe",
    totalHeight: prepared.target.totalHeight
  };
  const slices = [];
  let nextScrollTop = 0;
  let previousScrollTop = -1;
  let previousTotalHeight = 0;

  try {
    for (let index = 0; index < MAX_SLICES; index += 1) {
      const moved = await sendToFrame(tab.id, targetFrame.frameId, {
        type: "XF_SCROLL_TO",
        step: { scrollTop: nextScrollTop },
        index
      });
      if (!moved?.ok) {
        throw new Error(moved?.error || `Could not scroll to slice ${index + 1}.`);
      }

      if (
        index > 0
        && moved.scrollTop <= previousScrollTop + 1
        && moved.totalHeight <= previousTotalHeight + 1
      ) {
        break;
      }

      const dataUrl = await captureVisibleTabQueued(tab.windowId);
      const totalHeight = Math.max(moved.totalHeight, moved.scrollTop + moved.targetVisibleHeight);
      target.totalHeight = Math.max(target.totalHeight, totalHeight);
      previousScrollTop = moved.scrollTop;
      previousTotalHeight = totalHeight;

      slices.push({
        index: slices.length,
        dataUrl,
        scrollTop: moved.scrollTop,
        cropRect: offsetCropRect(moved.cropRect, frameOffset),
        viewport: topViewport,
        targetVisibleHeight: moved.targetVisibleHeight
      });

      if (moved.isAtEnd || moved.nextScrollTop <= moved.scrollTop + 1) {
        break;
      }
      nextScrollTop = moved.nextScrollTop;
    }
  } finally {
    await sendToFrame(tab.id, targetFrame.frameId, { type: "XF_RESTORE_CAPTURE" }).catch(() => {});
  }

  if (!slices.length) {
    throw new Error("No screenshots were captured.");
  }

  const captureId = crypto.randomUUID();
  const payload = {
    id: captureId,
    capturedAt: new Date().toISOString(),
    source: {
      tabId: tab.id,
      url: tab.url || "",
      title: tab.title || ""
    },
    target,
    slices
  };
  captures.set(captureId, payload);
  await persistCapture(captureId, payload);

  await chrome.tabs.create({
    url: chrome.runtime.getURL(`result/result.html?id=${encodeURIComponent(captureId)}`)
  });
}

async function injectCaptureScripts(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content/capture-target.js"]
    });
  } catch (error) {
    console.warn("Could not inject all frames, falling back to the top frame.", error);
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/capture-target.js"]
    });
  }
}

async function chooseCaptureFrame(tabId) {
  const frames = await getFrames(tabId);
  const measured = [];

  for (const frame of frames) {
    const measurement = await sendToFrame(tabId, frame.frameId, { type: "XF_MEASURE_CAPTURE" }).catch(() => null);
    if (!measurement?.ok) {
      continue;
    }

    const offset = frame.frameId === 0
      ? { x: 0, y: 0, ok: true }
      : await locateFrameOffset(tabId, frames, frame.frameId);
    if (!offset.ok) {
      continue;
    }

    measured.push({
      frameId: frame.frameId,
      parentFrameId: frame.parentFrameId,
      url: frame.url || "",
      offset,
      score: measurement.target.score * (frame.frameId === 0 ? 1 : 1.08),
      target: measurement.target
    });
  }

  measured.sort((a, b) => b.score - a.score);
  const selected = measured[0];
  if (!selected) {
    throw new Error("Could not find a scrollable capture target.");
  }
  return selected;
}

async function getFrames(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  return frames?.length ? frames : [{ frameId: 0, parentFrameId: -1, url: "" }];
}

async function locateFrameOffset(tabId, frames, frameId) {
  let current = frames.find((frame) => frame.frameId === frameId);
  let x = 0;
  let y = 0;

  while (current && current.frameId !== 0) {
    const parent = frames.find((frame) => frame.frameId === current.parentFrameId);
    if (!parent) {
      return { x: 0, y: 0, ok: false };
    }

    const list = await sendToFrame(tabId, parent.frameId, { type: "XF_LIST_IFRAMES" }).catch(() => null);
    const match = findMatchingIframe(list?.frames || [], current);
    if (!match) {
      return { x: 0, y: 0, ok: false };
    }

    x += match.rect.left;
    y += match.rect.top;
    current = parent;
  }

  return { x, y, ok: true };
}

function findMatchingIframe(iframes, frame) {
  const frameUrl = normalizeUrl(frame.url || "");
  return iframes.find((item) => normalizeUrl(item.src || "") === frameUrl)
    || iframes.find((item) => frameUrl && normalizeUrl(item.src || "").startsWith(frameUrl))
    || iframes.find((item) => {
      const src = normalizeUrl(item.src || "");
      return src && frameUrl && frameUrl.startsWith(src);
    });
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url;
  }
}

async function getTopViewport(tabId) {
  const response = await sendToFrame(tabId, 0, { type: "XF_GET_VIEWPORT" });
  if (!response?.ok) {
    throw new Error(response?.error || "Could not read top viewport.");
  }
  return response.viewport;
}

function captureVisibleTabQueued(windowId) {
  const job = visibleTabCaptureQueue.then(async () => {
    await waitForCaptureSlot();
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    lastVisibleTabCaptureAt = Date.now();
    return dataUrl;
  });
  visibleTabCaptureQueue = job.catch(() => {});
  return job;
}

async function waitForCaptureSlot() {
  const elapsed = Date.now() - lastVisibleTabCaptureAt;
  if (elapsed < CAPTURE_INTERVAL_MS) {
    await sleep(CAPTURE_INTERVAL_MS - elapsed);
  }
}

function offsetCropRect(cropRect, offset) {
  return {
    x: cropRect.x + (offset.x || 0),
    y: cropRect.y + (offset.y || 0),
    width: cropRect.width,
    height: cropRect.height
  };
}

async function getCapture(captureId) {
  if (captures.has(captureId)) {
    return captures.get(captureId);
  }
  const stored = await chrome.storage.local.get(storageKey(captureId));
  const payload = stored[storageKey(captureId)];
  if (payload) {
    captures.set(captureId, payload);
  }
  return payload || null;
}

async function listCaptures() {
  const stored = await chrome.storage.local.get(CAPTURE_INDEX_KEY);
  const storedIndex = Array.isArray(stored[CAPTURE_INDEX_KEY]) ? stored[CAPTURE_INDEX_KEY] : [];
  const ids = [...new Set([...storedIndex, ...captures.keys()])];
  const keys = ids.map(storageKey);
  const storedCaptures = keys.length ? await chrome.storage.local.get(keys) : {};
  const staleIds = [];
  const result = [];

  for (const id of ids) {
    const payload = captures.get(id) || storedCaptures[storageKey(id)];
    if (!payload) {
      staleIds.push(id);
      continue;
    }
    result.push(captureMeta(payload));
  }

  if (staleIds.length) {
    await chrome.storage.local.set({
      [CAPTURE_INDEX_KEY]: storedIndex.filter((id) => !staleIds.includes(id))
    });
  }

  return result.sort((a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime());
}

function captureMeta(payload) {
  return {
    id: payload.id,
    capturedAt: payload.capturedAt,
    title: payload.source?.title || "",
    url: payload.source?.url || "",
    targetLabel: payload.target?.label || "",
    targetMode: payload.target?.mode || "",
    sliceCount: payload.slices?.length || 0,
    totalHeight: payload.target?.totalHeight || 0,
    visibleWidth: payload.target?.visibleWidth || 0
  };
}

async function persistCapture(captureId, payload) {
  try {
    const stored = await chrome.storage.local.get(CAPTURE_INDEX_KEY);
    const index = Array.isArray(stored[CAPTURE_INDEX_KEY]) ? stored[CAPTURE_INDEX_KEY] : [];
    const nextIndex = [captureId, ...index.filter((id) => id !== captureId)].slice(0, MAX_STORED_CAPTURES);
    const removeIds = index.filter((id) => !nextIndex.includes(id));
    await chrome.storage.local.set({
      [storageKey(captureId)]: payload,
      [CAPTURE_INDEX_KEY]: nextIndex
    });
    if (removeIds.length) {
      await chrome.storage.local.remove(removeIds.map(storageKey));
    }
  } catch (error) {
    console.warn("Capture persistence failed; keeping in memory only.", error);
  }
}

async function removeCapture(captureId) {
  if (!captureId) {
    return;
  }
  captures.delete(captureId);
  const stored = await chrome.storage.local.get(CAPTURE_INDEX_KEY);
  const index = Array.isArray(stored[CAPTURE_INDEX_KEY]) ? stored[CAPTURE_INDEX_KEY] : [];
  await chrome.storage.local.set({
    [CAPTURE_INDEX_KEY]: index.filter((id) => id !== captureId)
  });
  await chrome.storage.local.remove(storageKey(captureId));
}

async function clearCaptures() {
  const allStored = await chrome.storage.local.get(null);
  const storedIds = Object.keys(allStored)
    .filter((key) => key.startsWith("capture:"))
    .map((key) => key.slice("capture:".length));
  const ids = [...new Set([...storedIds, ...captures.keys()])];
  captures.clear();
  await chrome.storage.local.remove([...ids.map(storageKey), CAPTURE_INDEX_KEY]);
  await chrome.storage.local.set({ [CAPTURE_INDEX_KEY]: [] });
  return ids;
}

function storageKey(captureId) {
  return `capture:${captureId}`;
}

function canInject(url = "") {
  return /^https?:\/\//i.test(url) || /^file:\/\//i.test(url);
}

function sendToFrame(tabId, frameId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, { frameId }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function showPageAlert(tabId, message) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (text) => window.alert(text),
    args: [message]
  });
}
