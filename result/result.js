const params = new URLSearchParams(location.search);
const captureId = params.get("id");

const elements = {
  title: document.querySelector("#title"),
  meta: document.querySelector("#meta"),
  status: document.querySelector("#status"),
  canvas: document.querySelector("#preview"),
  canvasStage: document.querySelector("#canvasStage"),
  cropOverlay: document.querySelector("#cropOverlay"),
  savePng: document.querySelector("#savePng"),
  savePagedPng: document.querySelector("#savePagedPng"),
  saveJpeg: document.querySelector("#saveJpeg"),
  savePagedJpeg: document.querySelector("#savePagedJpeg"),
  savePdf: document.querySelector("#savePdf"),
  paper: document.querySelector("#paper"),
  orientation: document.querySelector("#orientation"),
  smartSplit: document.querySelector("#smartSplit"),
  includeMeta: document.querySelector("#includeMeta"),
  pageGuideInfo: document.querySelector("#pageGuideInfo"),
  enableCrop: document.querySelector("#enableCrop"),
  cropX: document.querySelector("#cropX"),
  cropY: document.querySelector("#cropY"),
  cropWidth: document.querySelector("#cropWidth"),
  cropHeight: document.querySelector("#cropHeight"),
  exportScale: document.querySelector("#exportScale"),
  exportScaleValue: document.querySelector("#exportScaleValue"),
  cropFull: document.querySelector("#cropFull"),
  cropVisible: document.querySelector("#cropVisible"),
  customPagination: document.querySelector("#customPagination"),
  seedPageCuts: document.querySelector("#seedPageCuts"),
  addPageCut: document.querySelector("#addPageCut"),
  deletePageCut: document.querySelector("#deletePageCut"),
  clearPageCuts: document.querySelector("#clearPageCuts"),
  pageRiskInfo: document.querySelector("#pageRiskInfo"),
  pageCutList: document.querySelector("#pageCutList"),
  refreshCaptureCache: document.querySelector("#refreshCaptureCache"),
  clearCaptureCache: document.querySelector("#clearCaptureCache"),
  deleteCaptureCache: document.querySelector("#deleteCaptureCache"),
  cacheList: document.querySelector("#cacheList"),
  cacheInfo: document.querySelector("#cacheInfo"),
  reloadInfo: document.querySelector("#reloadInfo"),
  pageGuideOverlay: document.querySelector("#pageGuideOverlay")
};

const paperSizes = {
  a3: { width: 841.89, height: 1190.55 },
  a4: { width: 595.28, height: 841.89 },
  a5: { width: 419.53, height: 595.28 },
  b5: { width: 498.9, height: 708.66 },
  letter: { width: 612, height: 792 },
  legal: { width: 612, height: 1008 },
  tabloid: { width: 792, height: 1224 }
};

let capture = null;
let canvasScale = 1;
let cropDrag = null;
let pageCutDrag = null;
let lastPreviewPointer = null;
let manualCutFractions = [];
let selectedPageCutIndex = -1;
let editorStateSaveTimer = 0;
let isRestoringEditorState = false;
let isEditorStateReady = false;
let hasDeletedCaptureCache = false;
let compositionInfo = null;

const EDITOR_STATE_VERSION = 1;
const EDITOR_STATE_PREFIX = "xfFullPageCapture:editor:";
const LIFECYCLE_STATE_PREFIX = "xfFullPageCapture:lifecycle:";
const LIFECYCLE_HISTORY_LIMIT = 24;
const MAX_CANVAS_PIXELS = 220_000_000;
const PREVIEW_PIXEL_BUDGET = 200_000_000;
const MAX_CANVAS_SIDE = 65535;
const PDF_PAGE_SAFE_MIN_RATIO = 0.92;
const PDF_PAGE_SAFE_MAX_RATIO = 1.08;
const PDF_RISK_MESSAGE_LIMIT = 2;
const PAGE_SESSION_ID = crypto.randomUUID();
const LOAD_DIAGNOSTICS = readLoadDiagnostics();

init().catch((error) => {
  reportHandledError(error);
  setStatus(error.message || String(error), true);
});

elements.savePng.addEventListener("click", () => {
  downloadEditedCanvas("image/png", "png");
});

elements.savePagedPng.addEventListener("click", async () => {
  try {
    setBusy(true, "正在生成高清分页 PNG ZIP...");
    const zipBytes = await buildPagedPngZip();
    downloadBlob(new Blob([zipBytes], { type: "application/zip" }), `${baseFilename()}-paged-png.zip`);
    setStatus("分页 PNG ZIP 已交给浏览器下载。");
  } catch (error) {
    reportHandledError(error);
    setStatus(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
});

elements.saveJpeg.addEventListener("click", () => {
  downloadEditedCanvas("image/jpeg", "jpg", 0.92);
});

elements.savePagedJpeg.addEventListener("click", async () => {
  try {
    setBusy(true, "正在生成高清分页 JPEG ZIP...");
    const zipBytes = await buildPagedImageZip({
      type: "image/jpeg",
      extension: "jpg",
      quality: 0.92,
      label: "JPEG"
    });
    downloadBlob(new Blob([zipBytes], { type: "application/zip" }), `${baseFilename()}-paged-jpeg.zip`);
    setStatus("分页 JPEG ZIP 已交给浏览器下载。");
  } catch (error) {
    reportHandledError(error);
    setStatus(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
});

elements.savePdf.addEventListener("click", async () => {
  try {
    const pdfRisk = getCurrentPdfRiskAnalysis();
    if (pdfRisk.items.length > 0 && !confirm(buildPdfRiskConfirmMessage(pdfRisk))) {
      setStatus("已取消直接 PDF 导出。建议先导出分页 PNG ZIP，再用图片合并 PDF。");
      return;
    }

    setBusy(true, "正在生成高清分页 PDF...");
    const pdfBytes = await buildPdfBytes();
    downloadBlob(new Blob([pdfBytes], { type: "application/pdf" }), `${baseFilename()}.pdf`);
    setStatus("PDF 已交给浏览器下载。");
  } catch (error) {
    reportHandledError(error);
    setStatus(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
});

for (const input of [elements.cropX, elements.cropY, elements.cropWidth, elements.cropHeight]) {
  input.addEventListener("input", () => {
    if (elements.canvas.width > 0) {
      elements.enableCrop.checked = true;
      applyCropRect(readCropInputs());
    }
  });
}

elements.enableCrop.addEventListener("change", () => {
  updateCropOverlay();
  updatePageGuides();
  scheduleEditorStateSave();
});

elements.cropFull.addEventListener("click", () => {
  resetCropToFull();
});

elements.cropVisible.addEventListener("click", () => {
  cropToVisibleViewport();
});

elements.exportScale.addEventListener("input", () => {
  updateScaleReadout();
  updatePageGuides();
  scheduleEditorStateSave();
});

for (const input of [elements.paper, elements.orientation, elements.smartSplit, elements.includeMeta]) {
  input.addEventListener("change", () => {
    updatePageGuides();
    scheduleEditorStateSave();
  });
}

elements.customPagination.addEventListener("change", () => {
  if (elements.customPagination.checked && manualCutFractions.length === 0) {
    seedManualCutsFromAutomatic();
  }
  updatePaginationControls();
  updatePageGuides();
  saveEditorStateNow();
});

elements.seedPageCuts.addEventListener("click", () => {
  seedManualCutsFromAutomatic();
  elements.customPagination.checked = true;
  updatePaginationControls();
  updatePageGuides();
  saveEditorStateNow();
});

elements.addPageCut.addEventListener("click", () => {
  addManualCutFromKeyboardOrButton();
});

elements.deletePageCut.addEventListener("click", () => {
  deleteSelectedManualCutFromKeyboardOrButton();
});

elements.clearPageCuts.addEventListener("click", () => {
  manualCutFractions = [];
  selectedPageCutIndex = -1;
  elements.customPagination.checked = false;
  updatePaginationControls();
  updatePageGuides();
  saveEditorStateNow();
});

elements.refreshCaptureCache.addEventListener("click", () => {
  refreshCaptureCacheList().catch((error) => {
    reportHandledError(error);
    setStatus(error.message || String(error), true);
  });
});

elements.clearCaptureCache.addEventListener("click", () => {
  clearAllCaptureCaches().catch((error) => {
    reportHandledError(error);
    setStatus(error.message || String(error), true);
  });
});

elements.deleteCaptureCache.addEventListener("click", () => {
  deleteCurrentCaptureCache().catch((error) => {
    reportHandledError(error);
    setStatus(error.message || String(error), true);
  });
});

elements.cacheList.addEventListener("click", (event) => {
  const button = event.target.closest?.("button[data-cache-action]");
  if (!button) {
    return;
  }

  const id = button.dataset.captureId;
  if (!id) {
    return;
  }

  if (button.dataset.cacheAction === "open") {
    window.open(chrome.runtime.getURL(`result/result.html?id=${encodeURIComponent(id)}`), "_blank", "noopener");
    return;
  }

  if (button.dataset.cacheAction === "delete") {
    deleteCaptureCacheById(id).catch((error) => {
      reportHandledError(error);
      setStatus(error.message || String(error), true);
    });
  }
});

elements.canvasStage.addEventListener("pointerdown", startCropDrag);
elements.canvasStage.addEventListener("pointermove", updateCropDrag);
elements.canvasStage.addEventListener("pointerup", finishCropDrag);
elements.canvasStage.addEventListener("pointercancel", finishCropDrag);
elements.canvasStage.addEventListener("pointerdown", startPageCutDrag);
elements.canvasStage.addEventListener("pointermove", rememberPreviewPointer);
elements.canvasStage.addEventListener("pointerdown", rememberPreviewPointer);
elements.canvasStage.addEventListener("pointermove", updatePageCutDrag);
elements.canvasStage.addEventListener("pointerup", finishPageCutDrag);
elements.canvasStage.addEventListener("pointercancel", finishPageCutDrag);
document.addEventListener("keydown", handlePaginationKeydown);

new ResizeObserver(() => {
  updateCropOverlay();
  updatePageGuides();
}).observe(elements.canvasStage);

window.addEventListener("focus", () => markLifecycleEvent("focus"));
window.addEventListener("blur", () => markLifecycleEvent("blur"));
window.addEventListener("pageshow", (event) => {
  markLifecycleEvent("pageshow", { persisted: event.persisted });
});
document.addEventListener("freeze", () => markLifecycleEvent("freeze"));
document.addEventListener("resume", () => markLifecycleEvent("resume"));

window.addEventListener("beforeunload", () => {
  saveEditorStateNow();
  markLifecycleEvent("beforeunload", {
    autosaved: canSaveEditorState(),
    hadEditorWork: hasProtectableEditorWork()
  });
});
window.addEventListener("pagehide", (event) => {
  saveEditorStateNow();
  markLifecycleEvent("pagehide", { persisted: event.persisted });
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    saveEditorStateNow();
    markLifecycleEvent("hidden");
  }
});

async function init() {
  if (!captureId) {
    throw new Error("Missing capture id.");
  }

  const response = await chrome.runtime.sendMessage({ type: "GET_CAPTURE_META", captureId });
  if (!response?.ok) {
    throw new Error(response?.error || "Could not load capture.");
  }

  capture = response.payload;
  markLifecycleEvent("init");
  updateReloadDiagnostics();
  elements.title.textContent = capture.source.title || "完整页面截图";
  elements.meta.textContent = `${capture.target.label} · ${capture.target.mode === "inner-scroll" ? "内层滚动容器" : "页面滚动"} · ${capture.slices.length} 张切片 · ${capture.source.url}`;
  setStatus("正在拼接截图切片...");

  await composePreview();

  const restored = restoreEditorState();
  if (!restored) {
    resetCropToFull();
  }
  isEditorStateReady = true;
  updateScaleReadout();
  updatePaginationControls();
  updatePageGuides();
  setExportControlsEnabled(true);
  updateCacheControls();
  await refreshCaptureCacheList();
  const sizeNote = formatCompositionSizeNote();
  setStatus(restored
    ? `已恢复上次编辑草稿：${elements.canvas.width} x ${elements.canvas.height}px。${sizeNote}`
    : `拼接完成：${elements.canvas.width} x ${elements.canvas.height}px。${sizeNote}`);
  updateReloadDiagnostics();
}

function lifecycleStateKey() {
  return `${LIFECYCLE_STATE_PREFIX}${captureId || "unknown"}`;
}

function readLoadDiagnostics() {
  const navigation = performance.getEntriesByType("navigation")[0];
  return {
    sessionId: PAGE_SESSION_ID,
    loadedAt: new Date().toISOString(),
    navigationType: navigation?.type || "unknown",
    wasDiscarded: Boolean(document.wasDiscarded),
    activationStart: Math.round(navigation?.activationStart || 0),
    previous: readPreviousLifecycleEvent()
  };
}

function readPreviousLifecycleEvent() {
  if (!captureId) {
    return null;
  }
  try {
    const raw = localStorage.getItem(lifecycleStateKey());
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function markLifecycleEvent(eventName, extra = {}) {
  if (!captureId) {
    return;
  }
  const event = {
    eventName,
    sessionId: PAGE_SESSION_ID,
    at: new Date().toISOString(),
    visibilityState: document.visibilityState,
    navigationType: LOAD_DIAGNOSTICS.navigationType,
    wasDiscarded: LOAD_DIAGNOSTICS.wasDiscarded,
    ...extra
  };
  try {
    const previous = readPreviousLifecycleEvent();
    const previousEvents = lifecycleEventsFromState(previous);
    const events = [...previousEvents, event].slice(-LIFECYCLE_HISTORY_LIMIT);
    localStorage.setItem(lifecycleStateKey(), JSON.stringify({ last: event, events }));
  } catch (error) {
    console.warn("Could not save lifecycle diagnostics.", error);
  }
}

function lifecycleEventsFromState(state) {
  if (!state) {
    return [];
  }
  if (Array.isArray(state.events)) {
    return state.events;
  }
  if (state.eventName) {
    return [state];
  }
  return [];
}

function lifecycleLastEvent(state) {
  if (!state) {
    return null;
  }
  if (state.last) {
    return state.last;
  }
  if (state.eventName) {
    return state;
  }
  return null;
}

function updateReloadDiagnostics() {
  if (!elements.reloadInfo) {
    return;
  }
  elements.reloadInfo.textContent = describeReloadDiagnostics();
}

function describeReloadDiagnostics() {
  const parts = [];
  const load = LOAD_DIAGNOSTICS;
  const previous = lifecycleLastEvent(load.previous);
  const previousEvents = lifecycleEventsFromState(load.previous);
  const previousAt = previous?.at ? new Date(previous.at) : null;
  const secondsSincePrevious = previousAt ? Math.max(0, Math.round((Date.now() - previousAt.getTime()) / 1000)) : null;
  const canvasPixels = elements.canvas.width * elements.canvas.height;
  const canvasMp = canvasPixels ? `${Math.round(canvasPixels / 1_000_000)}MP` : "未拼接";
  const canvasMemory = canvasPixels ? `${Math.round(canvasPixels * 4 / 1024 / 1024)}MiB` : "未知";

  parts.push(`本次加载类型：${load.navigationType}`);
  if (load.wasDiscarded) {
    parts.push("Chrome 标记为 wasDiscarded，通常是标签页被内存回收后恢复");
  }
  if (previous) {
    parts.push(`上次页面事件：${previous.eventName}，约 ${secondsSincePrevious} 秒前`);
    const chain = previousEvents.slice(-6).map(formatLifecycleEvent).join(" -> ");
    if (chain) {
      parts.push(`事件链：${chain}`);
    }
  } else {
    parts.push("没有上次离开记录，可能是新打开、扩展重载或浏览器直接恢复");
  }
  parts.push(`画布：${canvasMp}，RGBA 约 ${canvasMemory}`);
  parts.push(`离开前自动保存：${canSaveEditorState() ? "已开启" : "未开启"}`);

  if (load.navigationType === "reload") {
    parts.push("判断：浏览器执行了 reload；当前插件代码没有定时刷新调用");
  } else if (load.navigationType === "back_forward") {
    parts.push("判断：来自历史记录或标签页恢复");
  } else if (load.navigationType === "navigate") {
    parts.push("判断：新导航打开结果页");
  }

  return parts.join("。");
}

function formatLifecycleEvent(event) {
  const flags = [];
  if (event.hadEditorWork || event.protected) {
    flags.push("已编辑");
  }
  if (event.autosaved) {
    flags.push("已保存");
  }
  if (event.persisted) {
    flags.push("BFCache");
  }
  if (event.wasDiscarded) {
    flags.push("丢弃恢复");
  }
  return flags.length ? `${event.eventName}(${flags.join("/")})` : event.eventName;
}

function editorStateKey() {
  return `${EDITOR_STATE_PREFIX}${captureId}`;
}

function restoreEditorState() {
  const state = readSavedEditorState();
  if (!state) {
    return false;
  }

  isRestoringEditorState = true;
  try {
    if (paperSizes[state.paper]) {
      elements.paper.value = state.paper;
    }
    if (state.orientation === "portrait" || state.orientation === "landscape") {
      elements.orientation.value = state.orientation;
    }
    if (typeof state.smartSplit === "boolean") {
      elements.smartSplit.checked = state.smartSplit;
    }
    if (typeof state.includeMeta === "boolean") {
      elements.includeMeta.checked = state.includeMeta;
    }
    elements.exportScale.value = String(clamp(Number(state.exportScale) || 1, 0.5, 2));

    elements.enableCrop.checked = Boolean(state.enableCrop);
    const crop = elements.enableCrop.checked && state.crop && typeof state.crop === "object"
      ? normalizeCropRect(state.crop)
      : { x: 0, y: 0, width: elements.canvas.width || 1, height: elements.canvas.height || 1 };
    elements.cropX.value = String(crop.x);
    elements.cropY.value = String(crop.y);
    elements.cropWidth.value = String(crop.width);
    elements.cropHeight.value = String(crop.height);

    manualCutFractions = Array.isArray(state.manualCutFractions)
      ? state.manualCutFractions.map(Number).filter(Number.isFinite)
      : [];
    normalizeManualCutFractions();
    elements.customPagination.checked = Boolean(state.customPagination && manualCutFractions.length > 0);

    updateCropOverlay();
    updateScaleReadout();
    return true;
  } finally {
    isRestoringEditorState = false;
  }
}

function readSavedEditorState() {
  try {
    const raw = localStorage.getItem(editorStateKey());
    if (!raw) {
      return null;
    }
    const state = JSON.parse(raw);
    return state?.version === EDITOR_STATE_VERSION ? state : null;
  } catch (error) {
    console.warn("Could not restore editor state.", error);
    return null;
  }
}

function scheduleEditorStateSave() {
  if (!canSaveEditorState()) {
    return;
  }
  clearTimeout(editorStateSaveTimer);
  editorStateSaveTimer = setTimeout(saveEditorStateNow, 250);
}

function saveEditorStateNow() {
  if (!canSaveEditorState()) {
    return;
  }

  clearTimeout(editorStateSaveTimer);
  const crop = elements.enableCrop.checked
    ? normalizeCropRect(readCropInputs())
    : { x: 0, y: 0, width: elements.canvas.width || 1, height: elements.canvas.height || 1 };
  const state = {
    version: EDITOR_STATE_VERSION,
    savedAt: new Date().toISOString(),
    canvas: {
      width: elements.canvas.width,
      height: elements.canvas.height
    },
    paper: elements.paper.value,
    orientation: elements.orientation.value,
    smartSplit: elements.smartSplit.checked,
    includeMeta: elements.includeMeta.checked,
    enableCrop: elements.enableCrop.checked,
    crop,
    exportScale: getExportScale(),
    customPagination: elements.customPagination.checked,
    manualCutFractions: [...normalizeManualCutFractions()]
  };

  try {
    localStorage.setItem(editorStateKey(), JSON.stringify(state));
  } catch (error) {
    console.warn("Could not save editor state.", error);
  }
}

function canSaveEditorState() {
  return isEditorStateReady && !isRestoringEditorState && !hasDeletedCaptureCache && Boolean(captureId) && elements.canvas.width > 0;
}

function hasProtectableEditorWork() {
  if (!isEditorStateReady || !elements.canvas.width) {
    return false;
  }
  const crop = getActiveCropRect();
  return (elements.customPagination.checked && manualCutFractions.length > 0)
    || (elements.enableCrop.checked && !isFullCanvasCrop(crop))
    || getExportScale() !== 1
    || elements.paper.value !== "a4"
    || elements.orientation.value !== "portrait";
}

async function refreshCaptureCacheList() {
  const response = await chrome.runtime.sendMessage({ type: "LIST_CAPTURES" });
  if (!response?.ok) {
    throw new Error(response?.error || "Could not list cached captures.");
  }
  renderCaptureCacheList(response.captures || []);
  updateCacheControls(response.captures || []);
}

function renderCaptureCacheList(items) {
  elements.cacheList.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "hint-text";
    empty.textContent = "暂无缓存截图。";
    elements.cacheList.appendChild(empty);
    return;
  }

  for (const item of items) {
    const node = document.createElement("article");
    node.className = `cache-item${item.id === captureId ? " is-current" : ""}`;

    const title = document.createElement("p");
    title.className = "cache-title";
    title.textContent = item.title || "未命名截图";

    const meta = document.createElement("p");
    meta.className = "cache-meta";
    meta.textContent = [
      item.id === captureId ? "当前" : "",
      formatDateTime(item.capturedAt),
      `${item.sliceCount || 0} 张切片`,
      `${Math.round((item.totalHeight || 0) / 100) / 10}k px`
    ].filter(Boolean).join(" · ");

    const actions = document.createElement("div");
    actions.className = "cache-actions";

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.textContent = item.id === captureId ? "当前页" : "打开";
    openButton.dataset.cacheAction = "open";
    openButton.dataset.captureId = item.id;
    openButton.disabled = item.id === captureId;

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.textContent = "删除";
    deleteButton.dataset.cacheAction = "delete";
    deleteButton.dataset.captureId = item.id;

    actions.append(openButton, deleteButton);
    node.append(title, meta, actions);
    elements.cacheList.appendChild(node);
  }
}

function updateCacheControls(items = null) {
  const hasCapture = Boolean(captureId);
  const count = Array.isArray(items) ? items.length : null;
  elements.refreshCaptureCache.disabled = !hasCapture;
  elements.deleteCaptureCache.disabled = !hasCapture || hasDeletedCaptureCache;
  elements.clearCaptureCache.disabled = !hasCapture || count === null || count === 0;
  elements.cacheInfo.textContent = hasDeletedCaptureCache
    ? "本次截图缓存已删除；当前页面未刷新前仍可继续导出。"
    : "关闭结果页后，本次截图缓存仍会暂存在浏览器本机，可在这里查看或删除。";
}

async function deleteCurrentCaptureCache() {
  if (hasDeletedCaptureCache) {
    setStatus("本次截图缓存已经删除。");
    return;
  }
  const ok = window.confirm("删除本次截图缓存？当前页面未刷新前仍可继续导出，但刷新后不能再恢复这次截图。");
  if (!ok) {
    return;
  }
  await deleteCaptureCacheById(captureId);
}

async function deleteCaptureCacheById(id) {
  const response = await chrome.runtime.sendMessage({ type: "FORGET_CAPTURE", captureId: id });
  if (!response?.ok) {
    throw new Error(response?.error || "Could not delete cached capture.");
  }

  removeLocalCaptureState(id);
  if (id === captureId) {
    hasDeletedCaptureCache = true;
  }

  await refreshCaptureCacheList();
  setStatus(id === captureId ? "本次截图缓存已删除，当前预览仍可继续导出。" : "已删除选中的截图缓存。");
}

async function clearAllCaptureCaches() {
  const ok = window.confirm("清空所有截图缓存？当前页面未刷新前仍可继续导出，但历史结果页将无法恢复原始截图。");
  if (!ok) {
    return;
  }
  const response = await chrome.runtime.sendMessage({ type: "CLEAR_CAPTURES" });
  if (!response?.ok) {
    throw new Error(response?.error || "Could not clear cached captures.");
  }
  for (const id of response.captureIds || []) {
    removeLocalCaptureState(id);
  }
  if ((response.captureIds || []).includes(captureId)) {
    hasDeletedCaptureCache = true;
  }
  await refreshCaptureCacheList();
  setStatus("所有截图缓存已清空。");
}

function removeLocalCaptureState(id) {
  try {
    localStorage.removeItem(`${EDITOR_STATE_PREFIX}${id}`);
    localStorage.removeItem(`${LIFECYCLE_STATE_PREFIX}${id}`);
  } catch (error) {
    console.warn("Could not remove local capture state.", error);
  }
}

async function composePreview() {
  const firstSlice = await fetchSlice(0);
  const first = stripSliceData(firstSlice);
  const firstImage = await loadImage(firstSlice.dataUrl);
  const naturalCanvasScale = firstImage.naturalWidth / first.viewport.width;

  const naturalWidth = Math.round(capture.target.visibleWidth * naturalCanvasScale);
  const naturalHeight = Math.round(capture.target.totalHeight * naturalCanvasScale);
  const downscale = getSafePreviewDownscale(naturalWidth, naturalHeight);
  canvasScale = naturalCanvasScale * downscale;

  const width = Math.max(1, Math.round(capture.target.visibleWidth * canvasScale));
  const height = Math.max(1, Math.round(capture.target.totalHeight * canvasScale));

  assertCanvasSize(width, height);
  compositionInfo = {
    naturalCanvasScale,
    naturalWidth,
    naturalHeight,
    width,
    height,
    downscale
  };

  elements.canvas.width = width;
  elements.canvas.height = height;

  const context = elements.canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);

  for (let index = 0; index < capture.slices.length; index += 1) {
    const sliceWithData = index === 0 ? firstSlice : await fetchSlice(index);
    const slice = stripSliceData(sliceWithData);
    const image = index === 0 ? firstImage : await loadImage(sliceWithData.dataUrl);
    const scaleX = image.naturalWidth / slice.viewport.width;
    const scaleY = image.naturalHeight / slice.viewport.height;
    const sx = Math.round(slice.cropRect.x * scaleX);
    const sy = Math.round(slice.cropRect.y * scaleY);
    const sw = Math.round(slice.cropRect.width * scaleX);
    const sh = Math.round(Math.min(slice.cropRect.height, slice.targetVisibleHeight) * scaleY);
    const dx = 0;
    const dy = Math.round(slice.scrollTop * canvasScale);
    const dw = Math.round(slice.cropRect.width * canvasScale);
    const dh = Math.round(Math.min(slice.cropRect.height, slice.targetVisibleHeight) * canvasScale);

    context.drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh);
    setStatus(`正在拼接截图切片 ${index + 1}/${capture.slices.length}...${formatCompositionSizeNote()}`);
  }
}

async function fetchSlice(index) {
  const response = await chrome.runtime.sendMessage({
    type: "GET_CAPTURE_SLICE",
    captureId,
    index
  });
  if (!response?.ok) {
    throw new Error(response?.error || `Could not load slice ${index + 1}.`);
  }
  return response.slice;
}

function stripSliceData(slice) {
  const { dataUrl: _dataUrl, ...metadata } = slice;
  return metadata;
}

function getSafePreviewDownscale(width, height) {
  const pixelScale = width * height > PREVIEW_PIXEL_BUDGET
    ? Math.sqrt(PREVIEW_PIXEL_BUDGET / (width * height))
    : 1;
  const sideScale = Math.min(1, MAX_CANVAS_SIDE / Math.max(width, height));
  return Math.min(1, pixelScale, sideScale);
}

function formatCompositionSizeNote() {
  if (!compositionInfo || compositionInfo.downscale >= 0.999) {
    return "";
  }
  const naturalMp = Math.round((compositionInfo.naturalWidth * compositionInfo.naturalHeight) / 1_000_000);
  const previewMp = Math.round((compositionInfo.width * compositionInfo.height) / 1_000_000);
  return ` 超长页面已自动缩放到 ${Math.round(compositionInfo.downscale * 100)}% 预览（原始约 ${naturalMp}MP，当前约 ${previewMp}MP）；分页导出会使用原始切片。`;
}

function assertCanvasSize(width, height) {
  if (width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE) {
    throw new Error(`页面太长，浏览器画布单边限制约 ${MAX_CANVAS_SIDE}px。当前需要 ${width} x ${height}px，请先缩小选区后再导出。`);
  }
  if (width * height > MAX_CANVAS_PIXELS) {
    throw new Error(`页面太长，拼接画布约 ${Math.round(width * height / 1_000_000)}MP。先降低导出缩放或缩小裁切范围会更稳。`);
  }
}

async function downloadEditedCanvas(type, extension, quality) {
  try {
    setBusy(true, `正在生成 ${extension.toUpperCase()}...`);
    const canvas = getEditedCanvas();
    const blob = await canvasToBlob(canvas, type, quality);
    downloadBlob(blob, `${baseFilename()}.${extension}`);
    setStatus(`${extension.toUpperCase()} 已交给浏览器下载。`);
  } catch (error) {
    reportHandledError(error);
    setStatus(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
}

async function buildPagedPngZip() {
  return buildPagedImageZip({
    type: "image/png",
    extension: "png",
    label: "PNG"
  });
}

async function buildPagedImageZip({ type, extension, quality, label }) {
  const exportState = getHighResExportState();
  const cuts = getHighResExportPageCuts(exportState);
  const pageCount = cuts.length - 1;
  const pad = Math.max(2, String(pageCount).length);
  const rootName = zipPageRootName();
  const files = [];

  for (let i = 0; i < pageCount; i += 1) {
    const pageCanvas = await renderHighResPagedImagePage(exportState, cuts[i], cuts[i + 1], i + 1, pageCount);
    const blob = await canvasToBlob(pageCanvas, type, quality);
    files.push({
      name: `${rootName}-page-${String(i + 1).padStart(pad, "0")}.${extension}`,
      bytes: new Uint8Array(await blob.arrayBuffer())
    });
    setStatus(`正在生成分页 ${label} ${i + 1}/${pageCount}...`);
  }

  return buildZip(files);
}

async function buildPdfBytes() {
  const exportState = getHighResExportState();
  const sourceWidth = exportState.outputWidth;
  const pdf = new SimplePdf();
  const pageSize = getPageSize();
  const margin = 24;
  const footerHeight = elements.includeMeta.checked ? 20 : 0;
  const imageWidthPt = pageSize.width - margin * 2;
  const imageHeightPt = pageSize.height - margin * 2 - footerHeight;
  const cuts = getHighResExportPageCuts(exportState);

  for (let i = 0; i < cuts.length - 1; i += 1) {
    const pageCanvas = await renderHighResCanvasSlice(exportState, cuts[i], cuts[i + 1]);
    const imageData = dataUrlToBytes(pageCanvas.toDataURL("image/jpeg", 0.92));
    const drawnHeightPt = Math.min(imageHeightPt, imageWidthPt * (pageCanvas.height / sourceWidth));
    pdf.addImagePage({
      pageWidth: pageSize.width,
      pageHeight: pageSize.height,
      imageBytes: imageData,
      imageWidth: pageCanvas.width,
      imageHeight: pageCanvas.height,
      x: margin,
      y: pageSize.height - margin - drawnHeightPt,
      width: imageWidthPt,
      height: drawnHeightPt,
      footer: elements.includeMeta.checked ? footerText(i + 1, cuts.length - 1) : ""
    });
  }

  return pdf.build();
}

function getEditedCanvas() {
  const sourceCanvas = elements.canvas;
  const crop = getActiveCropRect();
  const scale = getExportScale();
  const width = Math.max(1, Math.round(crop.width * scale));
  const height = Math.max(1, Math.round(crop.height * scale));

  assertCanvasSize(width, height);

  if (scale === 1 && isFullCanvasCrop(crop)) {
    return sourceCanvas;
  }

  const editedCanvas = document.createElement("canvas");
  editedCanvas.width = width;
  editedCanvas.height = height;
  const context = editedCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(sourceCanvas, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
  return editedCanvas;
}

function getHighResExportState() {
  if (!compositionInfo?.naturalCanvasScale || !canvasScale) {
    throw new Error("截图还没有完成拼接，暂时不能导出。");
  }

  const previewCrop = getActiveCropRect();
  const logicalCrop = {
    x: previewCrop.x / canvasScale,
    y: previewCrop.y / canvasScale,
    width: previewCrop.width / canvasScale,
    height: previewCrop.height / canvasScale
  };
  const outputScale = compositionInfo.naturalCanvasScale * getExportScale();
  const outputWidth = Math.max(1, Math.round(logicalCrop.width * outputScale));
  const outputHeight = Math.max(1, Math.round(logicalCrop.height * outputScale));

  return {
    previewCrop,
    logicalCrop,
    outputScale,
    outputWidth,
    outputHeight
  };
}

function getHighResExportPageCuts(exportState) {
  if (elements.customPagination.checked && manualCutFractions.length > 0) {
    return getManualPageCuts(exportState.outputHeight);
  }
  if (!elements.smartSplit.checked) {
    return buildRegularPageCuts(exportState.outputWidth, exportState.outputHeight);
  }
  return buildSmartHighResPageCuts(exportState);
}

function buildSmartHighResPageCuts(exportState) {
  const cuts = [0];
  const pageHeightPx = getPageHeightPx(exportState.outputWidth);
  const minPage = Math.max(320, Math.floor(pageHeightPx * 0.72));
  let cursor = 0;

  while (cursor + pageHeightPx < exportState.outputHeight) {
    const target = cursor + pageHeightPx;
    const split = findQuietHighResSplit(exportState, target, Math.floor(pageHeightPx * 0.14), minPage, cursor);
    cursor = Math.min(Math.max(split, cursor + minPage), exportState.outputHeight);
    cuts.push(cursor);
  }

  if (cuts.at(-1) !== exportState.outputHeight) {
    cuts.push(exportState.outputHeight);
  }

  return cuts;
}

function findQuietHighResSplit(exportState, targetY, radius, minPageHeight, pageStart) {
  const context = elements.canvas.getContext("2d", { willReadFrequently: true });
  const crop = exportState.previewCrop;
  const cropX = Math.round(crop.x);
  const cropWidth = Math.max(1, Math.min(Math.round(crop.width), elements.canvas.width - cropX));
  const startOutput = Math.max(pageStart + minPageHeight, targetY - radius);
  const endOutput = Math.min(exportState.outputHeight - 1, targetY + radius);
  const startPreview = clamp(Math.round(outputYToPreviewY(exportState, startOutput)), Math.round(crop.y), Math.round(crop.y + crop.height - 1));
  const endPreview = clamp(Math.round(outputYToPreviewY(exportState, endOutput)), startPreview, Math.round(crop.y + crop.height - 1));
  const sampleStepX = Math.max(4, Math.floor(cropWidth / 180));
  const band = Math.max(2, Math.min(6, Math.floor(crop.height)));
  let bestY = targetY;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let previewY = startPreview; previewY <= endPreview; previewY += 3) {
    const imageData = context.getImageData(cropX, previewY, cropWidth, Math.min(band, elements.canvas.height - previewY)).data;
    let score = 0;
    let count = 0;

    for (let row = 0; row < band && previewY + row < elements.canvas.height; row += 1) {
      let previous = null;
      for (let x = 0; x < cropWidth; x += sampleStepX) {
        const offset = (row * cropWidth + x) * 4;
        const luminance = imageData[offset] * 0.2126 + imageData[offset + 1] * 0.7152 + imageData[offset + 2] * 0.0722;
        if (previous !== null) {
          score += Math.abs(luminance - previous);
        }
        previous = luminance;
        count += 1;
      }
    }

    const outputY = previewYToOutputY(exportState, previewY);
    const distancePenalty = Math.abs(outputY - targetY) * 0.08;
    const normalized = score / Math.max(count, 1) + distancePenalty;
    if (normalized < bestScore) {
      bestScore = normalized;
      bestY = outputY;
    }
  }

  return Math.round(bestY);
}

function outputYToPreviewY(exportState, outputY) {
  return exportState.previewCrop.y + (outputY / Math.max(1, exportState.outputHeight)) * exportState.previewCrop.height;
}

function previewYToOutputY(exportState, previewY) {
  return ((previewY - exportState.previewCrop.y) / Math.max(1, exportState.previewCrop.height)) * exportState.outputHeight;
}

async function renderHighResCanvasSlice(exportState, startY, endY) {
  const contentHeight = Math.max(1, endY - startY);
  assertCanvasSize(exportState.outputWidth, contentHeight);
  const pageCanvas = document.createElement("canvas");
  pageCanvas.width = exportState.outputWidth;
  pageCanvas.height = contentHeight;
  const context = pageCanvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
  await drawHighResContent(context, exportState, startY, endY, 0);
  return pageCanvas;
}

async function renderHighResPagedImagePage(exportState, startY, endY, page, total) {
  const contentHeight = Math.max(1, endY - startY);
  const footerHeight = getPageLayoutPx(exportState.outputWidth).footerHeight;
  assertCanvasSize(exportState.outputWidth, contentHeight + footerHeight);
  const pageCanvas = document.createElement("canvas");
  pageCanvas.width = exportState.outputWidth;
  pageCanvas.height = contentHeight + footerHeight;
  const context = pageCanvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
  await drawHighResContent(context, exportState, startY, endY, 0);

  if (footerHeight > 0) {
    drawPageFooter(context, exportState.outputWidth, contentHeight, footerHeight, footerText(page, total));
  }

  return pageCanvas;
}

async function drawHighResContent(context, exportState, startY, endY, offsetY) {
  const pageLogicalTop = exportState.logicalCrop.y + startY / exportState.outputScale;
  const pageLogicalBottom = exportState.logicalCrop.y + endY / exportState.outputScale;
  const cropLogicalBottom = exportState.logicalCrop.y + exportState.logicalCrop.height;

  for (let index = 0; index < capture.slices.length; index += 1) {
    const slice = capture.slices[index];
    const sliceLogicalHeight = Math.min(slice.cropRect.height, slice.targetVisibleHeight);
    const sliceTop = slice.scrollTop;
    const sliceBottom = sliceTop + sliceLogicalHeight;
    const overlapTop = Math.max(pageLogicalTop, exportState.logicalCrop.y, sliceTop);
    const overlapBottom = Math.min(pageLogicalBottom, cropLogicalBottom, sliceBottom);
    if (overlapBottom <= overlapTop) {
      continue;
    }

    const sliceWithData = await fetchSlice(index);
    const image = await loadImage(sliceWithData.dataUrl);
    const scaleX = image.naturalWidth / slice.viewport.width;
    const scaleY = image.naturalHeight / slice.viewport.height;
    const sx = Math.round((slice.cropRect.x + exportState.logicalCrop.x) * scaleX);
    const sy = Math.round((slice.cropRect.y + overlapTop - sliceTop) * scaleY);
    const sw = Math.round(exportState.logicalCrop.width * scaleX);
    const sh = Math.round((overlapBottom - overlapTop) * scaleY);
    const dy = Math.round(offsetY + (overlapTop - pageLogicalTop) * exportState.outputScale);
    const dh = Math.round((overlapBottom - overlapTop) * exportState.outputScale);

    context.drawImage(image, sx, sy, sw, sh, 0, dy, exportState.outputWidth, dh);
  }
}

function drawPageFooter(context, width, contentHeight, footerHeight, text) {
  const fontSize = Math.max(16, Math.round(width / 96));
  const left = Math.max(20, Math.round(width * 0.035));
  context.strokeStyle = "#d8dee4";
  context.lineWidth = Math.max(1, Math.round(width / 1800));
  context.beginPath();
  context.moveTo(0, contentHeight + 0.5);
  context.lineTo(width, contentHeight + 0.5);
  context.stroke();
  context.fillStyle = "#3f4a54";
  context.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  context.textBaseline = "middle";
  context.fillText(text, left, contentHeight + footerHeight / 2);
}

function getPageHeightPx(sourceWidth) {
  return getPageLayoutPx(sourceWidth).contentHeight;
}

function getPageLayoutPx(sourceWidth) {
  const pageSize = getPageSize();
  const margin = 24;
  const footerHeight = elements.includeMeta.checked ? 20 : 0;
  const imageWidthPt = pageSize.width - margin * 2;
  const imageHeightPt = pageSize.height - margin * 2 - footerHeight;
  return {
    contentHeight: Math.max(1, Math.floor(sourceWidth * (imageHeightPt / imageWidthPt))),
    footerHeight: elements.includeMeta.checked ? Math.max(36, Math.ceil(sourceWidth * (footerHeight / imageWidthPt))) : 0
  };
}

function renderCanvasSlice(sourceCanvas, startY, endY) {
  const sliceHeight = Math.max(1, endY - startY);
  const pageCanvas = document.createElement("canvas");
  pageCanvas.width = sourceCanvas.width;
  pageCanvas.height = sliceHeight;
  const pageContext = pageCanvas.getContext("2d", { alpha: false });
  pageContext.fillStyle = "#ffffff";
  pageContext.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
  pageContext.drawImage(sourceCanvas, 0, startY, sourceCanvas.width, sliceHeight, 0, 0, sourceCanvas.width, sliceHeight);
  return pageCanvas;
}

function renderPagedImagePage(sourceCanvas, startY, endY, page, total) {
  const contentHeight = Math.max(1, endY - startY);
  const footerHeight = getPageLayoutPx(sourceCanvas.width).footerHeight;
  const pageCanvas = document.createElement("canvas");
  pageCanvas.width = sourceCanvas.width;
  pageCanvas.height = contentHeight + footerHeight;
  const context = pageCanvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
  context.drawImage(sourceCanvas, 0, startY, sourceCanvas.width, contentHeight, 0, 0, sourceCanvas.width, contentHeight);

  if (footerHeight > 0) {
    const fontSize = Math.max(16, Math.round(sourceCanvas.width / 96));
    const left = Math.max(20, Math.round(sourceCanvas.width * 0.035));
    context.strokeStyle = "#d8dee4";
    context.lineWidth = Math.max(1, Math.round(sourceCanvas.width / 1800));
    context.beginPath();
    context.moveTo(0, contentHeight + 0.5);
    context.lineTo(sourceCanvas.width, contentHeight + 0.5);
    context.stroke();
    context.fillStyle = "#3f4a54";
    context.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    context.textBaseline = "middle";
    context.fillText(footerText(page, total), left, contentHeight + footerHeight / 2);
  }

  return pageCanvas;
}

function getPageSize() {
  const selected = paperSizes[elements.paper.value] || paperSizes.a4;
  if (elements.orientation.value === "landscape") {
    return { width: selected.height, height: selected.width };
  }
  return selected;
}

function getExportPageCuts(sourceCanvas) {
  if (elements.customPagination.checked && manualCutFractions.length > 0) {
    return getManualPageCuts(sourceCanvas.height);
  }
  return buildPageCuts(sourceCanvas, getPageHeightPx(sourceCanvas.width));
}

function getManualPageCuts(height) {
  const innerCuts = normalizeManualCutFractions()
    .map((fraction) => clamp(Math.round(fraction * height), 1, Math.max(1, height - 1)));
  const cuts = [0];
  for (const cut of innerCuts) {
    if (cut > cuts.at(-1) && cut < height) {
      cuts.push(cut);
    }
  }
  if (cuts.at(-1) !== height) {
    cuts.push(height);
  }
  return cuts;
}

function buildRegularPageCuts(width, height) {
  const pageHeightPx = getPageHeightPx(width);
  const cuts = [0];
  let cursor = pageHeightPx;
  while (cursor < height) {
    cuts.push(cursor);
    cursor += pageHeightPx;
  }
  cuts.push(height);
  return cuts;
}

function buildPageCuts(canvas, pageHeightPx) {
  const cuts = [0];
  let cursor = 0;
  const minPage = Math.max(320, Math.floor(pageHeightPx * 0.72));

  while (cursor + pageHeightPx < canvas.height) {
    const target = cursor + pageHeightPx;
    const split = elements.smartSplit.checked
      ? findQuietSplit(canvas, target, Math.floor(pageHeightPx * 0.14), minPage, cursor)
      : target;
    cursor = Math.min(Math.max(split, cursor + minPage), canvas.height);
    cuts.push(cursor);
  }

  if (cuts.at(-1) !== canvas.height) {
    cuts.push(canvas.height);
  }

  return cuts;
}

function findQuietSplit(canvas, targetY, radius, minPageHeight, pageStart) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const start = Math.max(pageStart + minPageHeight, targetY - radius);
  const end = Math.min(canvas.height - 1, targetY + radius);
  const sampleStepX = Math.max(4, Math.floor(canvas.width / 180));
  const band = 6;
  let bestY = targetY;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let y = start; y <= end; y += 3) {
    const imageData = context.getImageData(0, y, canvas.width, Math.min(band, canvas.height - y)).data;
    let score = 0;
    let count = 0;

    for (let row = 0; row < band && y + row < canvas.height; row += 1) {
      let previous = null;
      for (let x = 0; x < canvas.width; x += sampleStepX) {
        const offset = (row * canvas.width + x) * 4;
        const luminance = imageData[offset] * 0.2126 + imageData[offset + 1] * 0.7152 + imageData[offset + 2] * 0.0722;
        if (previous !== null) {
          score += Math.abs(luminance - previous);
        }
        previous = luminance;
        count += 1;
      }
    }

    const distancePenalty = Math.abs(y - targetY) * 0.08;
    const normalized = score / Math.max(count, 1) + distancePenalty;
    if (normalized < bestScore) {
      bestScore = normalized;
      bestY = y;
    }
  }

  return bestY;
}

function seedManualCutsFromAutomatic() {
  const crop = getActiveCropRect();
  const scale = getExportScale();
  const outputWidth = Math.max(1, Math.round(crop.width * scale));
  const outputHeight = Math.max(1, Math.round(crop.height * scale));
  const cuts = buildRegularPageCuts(outputWidth, outputHeight);
  manualCutFractions = cuts.slice(1, -1).map((cut) => cut / outputHeight);
  selectedPageCutIndex = -1;
  normalizeManualCutFractions();
}

function addManualCutAtPreferredPosition() {
  if (!elements.canvas.width) {
    setStatus("截图还没有完成拼接，暂时不能新增分页线。", true);
    return false;
  }

  const preferred = getPreferredManualCutFraction();
  const inserted = insertManualCutAtFraction(preferred.fraction);
  if (!inserted.ok) {
    setStatus("当前分页线已经太密，暂时不能继续新增。", true);
    return false;
  }

  selectedPageCutIndex = inserted.index;
  return preferred.source;
}

function insertManualCutAtFraction(fraction) {
  const bounds = [0, ...normalizeManualCutFractions(), 1];
  let target = Number.isFinite(fraction) ? fraction : getLargestManualCutGap(bounds).center;
  target = clamp(target, 0.01, 0.99);

  let insertAt = bounds.findIndex((value) => value > target) - 1;
  if (insertAt < 0) {
    insertAt = bounds.length - 2;
  }

  const previous = bounds[insertAt];
  const next = bounds[insertAt + 1];
  if (next - previous <= 0.02) {
    const largest = getLargestManualCutGap(bounds);
    if (largest.end - largest.start <= 0.02) {
      return { ok: false, index: -1 };
    }
    target = largest.center;
  } else {
    target = clamp(target, previous + 0.01, next - 0.01);
  }

  manualCutFractions.push(target);
  normalizeManualCutFractions();
  const rounded = Math.round(clamp(target, 0.01, 0.99) * 10000) / 10000;
  return {
    ok: true,
    index: manualCutFractions.indexOf(rounded)
  };
}

function getLargestManualCutGap(bounds) {
  let start = bounds[0];
  let end = bounds[1];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    if (bounds[i + 1] - bounds[i] > end - start) {
      start = bounds[i];
      end = bounds[i + 1];
    }
  }
  return {
    start,
    end,
    center: (start + end) / 2
  };
}

function getPreferredManualCutFraction() {
  const pointerFraction = getManualCutFractionFromLastPointer();
  if (Number.isFinite(pointerFraction)) {
    return { fraction: pointerFraction, source: "pointer" };
  }

  const visibleFraction = getManualCutFractionFromVisibleCenter();
  if (Number.isFinite(visibleFraction)) {
    return { fraction: visibleFraction, source: "visible-center" };
  }

  return { fraction: null, source: "largest-gap" };
}

function getManualCutFractionFromLastPointer() {
  if (!lastPreviewPointer || Date.now() - lastPreviewPointer.at > 8000) {
    return null;
  }
  return previewFractionFromClientPoint(lastPreviewPointer.clientX, lastPreviewPointer.clientY);
}

function getManualCutFractionFromVisibleCenter() {
  const crop = getActiveCropRect();
  const canvasRect = elements.canvas.getBoundingClientRect();
  const wrapRect = document.querySelector(".preview-wrap").getBoundingClientRect();
  const displayScale = canvasRect.width / Math.max(1, elements.canvas.width);
  const cropTop = canvasRect.top + crop.y * displayScale;
  const cropBottom = canvasRect.top + (crop.y + crop.height) * displayScale;
  const visibleTop = Math.max(cropTop, wrapRect.top);
  const visibleBottom = Math.min(cropBottom, wrapRect.bottom);
  if (visibleBottom <= visibleTop) {
    return null;
  }

  return clamp(((visibleTop + visibleBottom) / 2 - cropTop) / Math.max(1, cropBottom - cropTop), 0.01, 0.99);
}

function previewFractionFromClientPoint(clientX, clientY) {
  if (!elements.canvas.width) {
    return null;
  }
  const crop = getActiveCropRect();
  const canvasRect = elements.canvas.getBoundingClientRect();
  if (
    clientX < canvasRect.left
    || clientX > canvasRect.right
    || clientY < canvasRect.top
    || clientY > canvasRect.bottom
  ) {
    return null;
  }

  const x = ((clientX - canvasRect.left) / Math.max(1, canvasRect.width)) * elements.canvas.width;
  const y = ((clientY - canvasRect.top) / Math.max(1, canvasRect.height)) * elements.canvas.height;
  if (
    x < crop.x
    || x > crop.x + crop.width
    || y < crop.y
    || y > crop.y + crop.height
  ) {
    return null;
  }

  return clamp((y - crop.y) / Math.max(1, crop.height), 0.01, 0.99);
}

function addManualCutFromKeyboardOrButton() {
  const source = addManualCutAtPreferredPosition();
  if (!source) {
    return;
  }

  elements.customPagination.checked = true;
  updatePaginationControls();
  updatePageGuides();
  saveEditorStateNow();
  const sourceText = source === "pointer"
    ? "鼠标位置"
    : source === "visible-center"
      ? "当前可见区域中心"
      : "最大空段中心";
  setStatus(`已在${sourceText}新增分页线。`);
}

function deleteSelectedManualCut() {
  normalizeManualCutFractions();
  if (selectedPageCutIndex < 0 || selectedPageCutIndex >= manualCutFractions.length) {
    setStatus("先在右侧预览里选中一条自定义分页线。", true);
    return false;
  }

  manualCutFractions.splice(selectedPageCutIndex, 1);
  if (manualCutFractions.length === 0) {
    selectedPageCutIndex = -1;
    elements.customPagination.checked = false;
  } else {
    selectedPageCutIndex = Math.min(selectedPageCutIndex, manualCutFractions.length - 1);
  }
  setStatus("已删除选中的分页线。");
  return true;
}

function deleteSelectedManualCutFromKeyboardOrButton() {
  deleteSelectedManualCut();
  updatePaginationControls();
  updatePageGuides();
  saveEditorStateNow();
}

function handlePaginationKeydown(event) {
  if (
    event.defaultPrevented
    || event.repeat
    || event.metaKey
    || event.ctrlKey
    || event.altKey
    || isEditableShortcutTarget(event.target)
  ) {
    return;
  }

  if (event.key === "Delete" || event.key === "Backspace") {
    if (!elements.customPagination.checked || manualCutFractions.length === 0) {
      return;
    }
    event.preventDefault();
    deleteSelectedManualCutFromKeyboardOrButton();
    return;
  }

  if (event.key === "a" || event.key === "A" || event.key === "+" || event.key === "=") {
    if (!elements.canvas.width) {
      return;
    }
    event.preventDefault();
    addManualCutFromKeyboardOrButton();
  }
}

function isEditableShortcutTarget(target) {
  const element = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
  if (!element) {
    return false;
  }

  if (element.closest?.("textarea, select, [contenteditable=''], [contenteditable='true']")) {
    return true;
  }

  const input = element.closest?.("input");
  if (!input) {
    return false;
  }

  const type = (input.getAttribute("type") || "text").toLowerCase();
  return !["button", "checkbox", "radio"].includes(type);
}

function rememberPreviewPointer(event) {
  if (previewFractionFromClientPoint(event.clientX, event.clientY) === null) {
    return;
  }
  lastPreviewPointer = {
    clientX: event.clientX,
    clientY: event.clientY,
    at: Date.now()
  };
}

function normalizeManualCutFractions() {
  manualCutFractions = [...new Set(manualCutFractions
    .map((value) => Math.round(clamp(Number(value) || 0, 0.01, 0.99) * 10000) / 10000))]
    .sort((a, b) => a - b);
  return manualCutFractions;
}

function updatePaginationControls() {
  const enabled = elements.canvas.width > 0;
  if (selectedPageCutIndex >= manualCutFractions.length) {
    selectedPageCutIndex = manualCutFractions.length - 1;
  }
  elements.seedPageCuts.disabled = !enabled;
  elements.addPageCut.disabled = !enabled;
  elements.deletePageCut.disabled = !enabled
    || !elements.customPagination.checked
    || selectedPageCutIndex < 0
    || selectedPageCutIndex >= manualCutFractions.length;
  elements.clearPageCuts.disabled = !enabled || manualCutFractions.length === 0;
}

function updatePageGuides() {
  if (!elements.canvas.width || !elements.pageGuideOverlay) {
    return;
  }

  const crop = getActiveCropRect();
  const scale = getExportScale();
  const outputWidth = Math.max(1, Math.round(crop.width * scale));
  const outputHeight = Math.max(1, Math.round(crop.height * scale));
  const isCustom = elements.customPagination.checked && manualCutFractions.length > 0;
  const cuts = isCustom
    ? getManualPageCuts(outputHeight)
    : buildRegularPageCuts(outputWidth, outputHeight);
  const pdfRisk = isCustom ? analyzePdfPageDistortion(cuts, outputWidth) : createEmptyPdfRiskAnalysis();

  renderPageGuides(cuts, crop, outputHeight, isCustom, pdfRisk);
  updatePageGuideText(cuts, isCustom, pdfRisk);
  updatePaginationControls();
}

function renderPageGuides(cuts, crop, outputHeight, isCustom, pdfRisk) {
  if (cuts.length <= 2) {
    elements.pageGuideOverlay.replaceChildren();
    return;
  }

  const fragment = document.createDocumentFragment();
  const canvasRect = elements.canvas.getBoundingClientRect();
  const stageRect = elements.canvasStage.getBoundingClientRect();
  const displayScale = canvasRect.width / Math.max(1, elements.canvas.width);
  const left = canvasRect.left - stageRect.left + crop.x * displayScale;
  const width = crop.width * displayScale;

  if (isCustom) {
    renderPdfSafeBands(fragment, crop, outputHeight, pdfRisk, {
      canvasTop: canvasRect.top - stageRect.top,
      displayScale,
      left,
      width
    });
  }

  for (let i = 1; i < cuts.length - 1; i += 1) {
    const lineRisk = pdfRisk.lineWarnings[i - 1] || null;
    const fraction = cuts[i] / outputHeight;
    const sourceY = crop.y + crop.height * fraction;
    const line = document.createElement("div");
    line.className = `page-guide ${isCustom ? "is-custom" : "is-automatic"}`;
    if (lineRisk) {
      line.classList.add("is-risk", `is-${lineRisk.type}`);
    }
    if (isCustom && i - 1 === selectedPageCutIndex) {
      line.classList.add("is-selected");
    }
    line.style.left = `${left}px`;
    line.style.top = `${canvasRect.top - stageRect.top + sourceY * displayScale}px`;
    line.style.width = `${width}px`;
    if (isCustom) {
      line.dataset.cutIndex = String(i - 1);
    }

    const label = document.createElement("span");
    label.className = "page-guide-label";
    label.textContent = lineRisk ? `${i + 1} · ${lineRisk.label}` : `${i + 1}`;
    line.appendChild(label);
    fragment.appendChild(line);
  }

  elements.pageGuideOverlay.replaceChildren(fragment);
}

function renderPdfSafeBands(parent, crop, outputHeight, pdfRisk, layout) {
  for (const band of pdfRisk.bands) {
    const topOutput = clamp(band.start, 0, Math.max(0, outputHeight - 1));
    const bottomOutput = Math.min(outputHeight, Math.max(topOutput + 1, band.end));
    const top = layout.canvasTop + (crop.y + crop.height * (topOutput / outputHeight)) * layout.displayScale;
    const height = Math.max(10, (crop.height * ((bottomOutput - topOutput) / outputHeight)) * layout.displayScale);
    const bandElement = document.createElement("div");
    bandElement.className = `page-guide-safe-band ${band.isWarning ? "is-warning" : ""}`;
    bandElement.style.left = `${layout.left}px`;
    bandElement.style.top = `${top}px`;
    bandElement.style.width = `${layout.width}px`;
    bandElement.style.height = `${height}px`;

    const label = document.createElement("span");
    label.className = "page-guide-safe-label";
    label.textContent = "PDF参考区";
    bandElement.appendChild(label);
    parent.appendChild(bandElement);
  }
}

function updatePageGuideText(cuts, isCustom, pdfRisk) {
  const pageCount = Math.max(1, cuts.length - 1);
  const orientationLabel = elements.orientation.value === "landscape" ? "横版" : "竖版";
  const paperLabel = elements.paper.selectedOptions[0]?.textContent || "A4";
  elements.pageGuideInfo.textContent = `${paperLabel} ${orientationLabel}：约 ${pageCount} 页`;
  if (isCustom) {
    const parts = normalizeManualCutFractions().map((fraction) => `${Math.round(fraction * 100)}%`);
    const selected = selectedPageCutIndex >= 0 && selectedPageCutIndex < parts.length
      ? `。已选中第 ${selectedPageCutIndex + 1} 条`
      : "";
    elements.pageCutList.textContent = parts.length > 0 ? `${parts.length} 条：${parts.join(" / ")}${selected}` : "自定义单页。";
    updatePageRiskInfo(pdfRisk);
    if (pageCutDrag) {
      setStatus(
        pdfRisk.items.length > 0
          ? buildPdfRiskSummary(pdfRisk)
          : "分页线在 PDF 参考区内。若要彻底避开直接 PDF 缩放风险，可以先导出分页 PNG ZIP 再合并 PDF。",
        pdfRisk.items.length > 0
      );
    }
  } else {
    elements.pageCutList.textContent = `自动分页：约 ${pageCount} 页。`;
    updatePageRiskInfo(null);
  }
}

function createEmptyPdfRiskAnalysis() {
  return {
    items: [],
    lineWarnings: [],
    bands: [],
    idealHeight: 0
  };
}

function analyzePdfPageDistortion(cuts, outputWidth) {
  const idealHeight = Math.max(1, getPageHeightPx(outputWidth));
  const safeMin = idealHeight * PDF_PAGE_SAFE_MIN_RATIO;
  const safeMax = idealHeight * PDF_PAGE_SAFE_MAX_RATIO;
  const analysis = createEmptyPdfRiskAnalysis();
  analysis.idealHeight = idealHeight;

  for (let pageIndex = 0; pageIndex < cuts.length - 1; pageIndex += 1) {
    const start = cuts[pageIndex];
    const end = cuts[pageIndex + 1];
    const pageHeight = Math.max(1, end - start);
    const ratio = pageHeight / idealHeight;
    const isLastPage = pageIndex === cuts.length - 2;
    const tooShort = ratio < PDF_PAGE_SAFE_MIN_RATIO && !isLastPage;
    const tooTall = ratio > PDF_PAGE_SAFE_MAX_RATIO;
    let warning = null;

    if (tooShort) {
      warning = {
        page: pageIndex + 1,
        type: "too-short",
        label: "偏短",
        ratio,
        message: `第 ${pageIndex + 1} 页低于 PDF 参考区，直接导出 PDF 可能被放大拉伸或出现明显留白。`
      };
    } else if (tooTall) {
      warning = {
        page: pageIndex + 1,
        type: "too-tall",
        label: "偏长",
        ratio,
        message: `第 ${pageIndex + 1} 页超过 PDF 参考区，直接导出 PDF 可能被纵向压缩变形。`
      };
    }

    if (pageIndex < cuts.length - 2) {
      analysis.bands.push({
        cutIndex: pageIndex,
        start: start + safeMin,
        end: start + safeMax,
        isWarning: Boolean(warning)
      });
    }

    if (warning) {
      analysis.items.push(warning);
      if (pageIndex < cuts.length - 2) {
        analysis.lineWarnings[pageIndex] = warning;
      }
    }
  }

  return analysis;
}

function updatePageRiskInfo(pdfRisk) {
  if (!elements.pageRiskInfo) {
    return;
  }

  elements.pageRiskInfo.classList.remove("is-ok", "is-warning");
  if (!pdfRisk) {
    elements.pageRiskInfo.textContent = "开启自定义分页线后，会在右侧显示 PDF 参考区。";
    return;
  }

  if (pdfRisk.items.length === 0) {
    elements.pageRiskInfo.classList.add("is-ok");
    elements.pageRiskInfo.textContent = "当前分页线在 PDF 参考区内。若要彻底避开直接 PDF 缩放风险，可以先导出分页 PNG ZIP，再用图片合并 PDF。";
    return;
  }

  elements.pageRiskInfo.classList.add("is-warning");
  elements.pageRiskInfo.textContent = buildPdfRiskSummary(pdfRisk);
}

function buildPdfRiskSummary(pdfRisk) {
  const messages = pdfRisk.items
    .slice(0, PDF_RISK_MESSAGE_LIMIT)
    .map((item) => item.message);
  const remaining = pdfRisk.items.length > PDF_RISK_MESSAGE_LIMIT
    ? ` 另有 ${pdfRisk.items.length - PDF_RISK_MESSAGE_LIMIT} 页也偏离参考区。`
    : "";
  return `${messages.join(" ")}${remaining} 建议先导出分页 PNG ZIP，再用图片合并 PDF，可避开直接 PDF 的缩放变形风险。`;
}

function buildPdfRiskConfirmMessage(pdfRisk) {
  return `${buildPdfRiskSummary(pdfRisk)}\n\n仍然直接导出分页 PDF？`;
}

function getCurrentPdfRiskAnalysis() {
  if (!elements.canvas.width || !elements.customPagination.checked || manualCutFractions.length === 0) {
    return createEmptyPdfRiskAnalysis();
  }

  const exportState = getHighResExportState();
  const cuts = getHighResExportPageCuts(exportState);
  return analyzePdfPageDistortion(cuts, exportState.outputWidth);
}

function resetCropToFull() {
  elements.enableCrop.checked = true;
  applyCropRect({ x: 0, y: 0, width: elements.canvas.width || 1, height: elements.canvas.height || 1 }, false);
}

function cropToVisibleViewport() {
  const canvasRect = elements.canvas.getBoundingClientRect();
  const wrapRect = document.querySelector(".preview-wrap").getBoundingClientRect();
  const left = Math.max(canvasRect.left, wrapRect.left);
  const top = Math.max(canvasRect.top, wrapRect.top);
  const right = Math.min(canvasRect.right, wrapRect.right);
  const bottom = Math.min(canvasRect.bottom, wrapRect.bottom);

  if (right <= left || bottom <= top) {
    setStatus("当前可见区域没有覆盖截图画布。", true);
    return;
  }

  const scale = elements.canvas.width / Math.max(1, canvasRect.width);
  elements.enableCrop.checked = true;
  applyCropRect({
    x: (left - canvasRect.left) * scale,
    y: (top - canvasRect.top) * scale,
    width: (right - left) * scale,
    height: (bottom - top) * scale
  });
}

function startCropDrag(event) {
  if (event.target.closest?.(".page-guide")) {
    return;
  }
  if (elements.canvas.width <= 0 || event.button !== 0) {
    return;
  }

  let action = cropActionFromEvent(event);
  const point = canvasPointFromEvent(event);
  const currentCrop = getActiveCropRect();
  if (action === "move" && isFullCanvasCrop(currentCrop)) {
    action = "new";
  }

  elements.enableCrop.checked = true;
  cropDrag = {
    action,
    moved: false,
    startPoint: point,
    startRect: action === "new" ? { ...point, width: 1, height: 1 } : currentCrop
  };
  elements.canvasStage.setPointerCapture(event.pointerId);
  event.preventDefault();

  if (action === "new") {
    applyCropRect(cropDrag.startRect);
  }
}

function updateCropDrag(event) {
  if (!cropDrag) {
    return;
  }
  event.preventDefault();
  const point = canvasPointFromEvent(event);
  cropDrag.moved = cropDrag.moved
    || Math.abs(point.x - cropDrag.startPoint.x) > 3
    || Math.abs(point.y - cropDrag.startPoint.y) > 3;
  applyCropRect(rectFromCropDrag(cropDrag, point));
}

function finishCropDrag(event) {
  if (!cropDrag) {
    return;
  }
  if (elements.canvasStage.hasPointerCapture(event.pointerId)) {
    elements.canvasStage.releasePointerCapture(event.pointerId);
  }
  if (cropDrag.action === "new" && !cropDrag.moved) {
    resetCropToFull();
  }
  cropDrag = null;
  saveEditorStateNow();
}

function cropActionFromEvent(event) {
  const actionTarget = event.target.closest?.("[data-crop-action]");
  if (actionTarget && elements.cropOverlay.contains(actionTarget)) {
    return actionTarget.dataset.cropAction;
  }
  if (event.target === elements.cropOverlay) {
    return "move";
  }
  return "new";
}

function rectFromCropDrag(drag, point) {
  if (drag.action === "new") {
    return rectFromPoints(drag.startPoint, point);
  }

  const dx = point.x - drag.startPoint.x;
  const dy = point.y - drag.startPoint.y;
  if (drag.action === "move") {
    return moveCropRect(drag.startRect, dx, dy);
  }
  return resizeCropRect(drag.startRect, drag.action, dx, dy);
}

function rectFromPoints(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.max(8, Math.abs(b.x - a.x)),
    height: Math.max(8, Math.abs(b.y - a.y))
  };
}

function moveCropRect(rect, dx, dy) {
  return {
    x: clamp(rect.x + dx, 0, Math.max(0, elements.canvas.width - rect.width)),
    y: clamp(rect.y + dy, 0, Math.max(0, elements.canvas.height - rect.height)),
    width: rect.width,
    height: rect.height
  };
}

function resizeCropRect(rect, action, dx, dy) {
  const minSize = 8;
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;

  if (action.includes("w")) {
    left = clamp(rect.x + dx, 0, right - minSize);
  }
  if (action.includes("e")) {
    right = clamp(rect.x + rect.width + dx, left + minSize, elements.canvas.width);
  }
  if (action.includes("n")) {
    top = clamp(rect.y + dy, 0, bottom - minSize);
  }
  if (action.includes("s")) {
    bottom = clamp(rect.y + rect.height + dy, top + minSize, elements.canvas.height);
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

function startPageCutDrag(event) {
  const guide = event.target.closest?.(".page-guide.is-custom");
  if (!guide || !elements.customPagination.checked) {
    return;
  }

  pageCutDrag = {
    index: Number(guide.dataset.cutIndex)
  };
  selectedPageCutIndex = pageCutDrag.index;
  updatePageGuides();
  elements.canvasStage.setPointerCapture(event.pointerId);
  event.preventDefault();
  event.stopPropagation();
}

function updatePageCutDrag(event) {
  if (!pageCutDrag) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  const crop = getActiveCropRect();
  const point = canvasPointFromEvent(event);
  const index = pageCutDrag.index;
  const previous = index > 0 ? manualCutFractions[index - 1] : 0;
  const next = index < manualCutFractions.length - 1 ? manualCutFractions[index + 1] : 1;
  const fraction = (point.y - crop.y) / Math.max(1, crop.height);
  manualCutFractions[index] = clamp(fraction, previous + 0.01, next - 0.01);
  updatePageGuides();
  scheduleEditorStateSave();
}

function finishPageCutDrag(event) {
  if (!pageCutDrag) {
    return;
  }

  if (elements.canvasStage.hasPointerCapture(event.pointerId)) {
    elements.canvasStage.releasePointerCapture(event.pointerId);
  }
  pageCutDrag = null;
  normalizeManualCutFractions();
  updatePageGuides();
  saveEditorStateNow();
}

function readCropInputs() {
  return {
    x: Number(elements.cropX.value),
    y: Number(elements.cropY.value),
    width: Number(elements.cropWidth.value),
    height: Number(elements.cropHeight.value)
  };
}

function applyCropRect(rect, updateToggle = true) {
  if (updateToggle) {
    elements.enableCrop.checked = true;
  }
  const crop = normalizeCropRect(rect);
  elements.cropX.value = String(crop.x);
  elements.cropY.value = String(crop.y);
  elements.cropWidth.value = String(crop.width);
  elements.cropHeight.value = String(crop.height);
  updateCropOverlay();
  updatePageGuides();
  scheduleEditorStateSave();
}

function getActiveCropRect() {
  if (!elements.enableCrop.checked) {
    return { x: 0, y: 0, width: elements.canvas.width, height: elements.canvas.height };
  }
  return normalizeCropRect(readCropInputs());
}

function isFullCanvasCrop(crop) {
  return crop.x === 0 && crop.y === 0 && crop.width === elements.canvas.width && crop.height === elements.canvas.height;
}

function normalizeCropRect(rect) {
  const canvasWidth = Math.max(1, elements.canvas.width);
  const canvasHeight = Math.max(1, elements.canvas.height);
  const x = clamp(Math.round(Number(rect.x) || 0), 0, canvasWidth - 1);
  const y = clamp(Math.round(Number(rect.y) || 0), 0, canvasHeight - 1);
  const width = clamp(Math.round(Number(rect.width) || 1), 1, canvasWidth - x);
  const height = clamp(Math.round(Number(rect.height) || 1), 1, canvasHeight - y);
  return { x, y, width, height };
}

function updateCropOverlay() {
  const crop = getActiveCropRect();
  if (!elements.enableCrop.checked || !elements.canvas.width) {
    elements.cropOverlay.hidden = true;
    elements.canvasStage.classList.remove("is-cropping");
    return;
  }

  const canvasRect = elements.canvas.getBoundingClientRect();
  const stageRect = elements.canvasStage.getBoundingClientRect();
  const displayScale = canvasRect.width / Math.max(1, elements.canvas.width);
  elements.cropOverlay.hidden = false;
  elements.canvasStage.classList.add("is-cropping");
  elements.cropOverlay.style.left = `${canvasRect.left - stageRect.left + crop.x * displayScale}px`;
  elements.cropOverlay.style.top = `${canvasRect.top - stageRect.top + crop.y * displayScale}px`;
  elements.cropOverlay.style.width = `${crop.width * displayScale}px`;
  elements.cropOverlay.style.height = `${crop.height * displayScale}px`;
}

function canvasPointFromEvent(event) {
  const rect = elements.canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * elements.canvas.width;
  const y = ((event.clientY - rect.top) / Math.max(1, rect.height)) * elements.canvas.height;
  return {
    x: clamp(Math.round(x), 0, Math.max(0, elements.canvas.width - 1)),
    y: clamp(Math.round(y), 0, Math.max(0, elements.canvas.height - 1))
  };
}

function getExportScale() {
  return clamp(Number(elements.exportScale.value) || 1, 0.5, 2);
}

function updateScaleReadout() {
  elements.exportScaleValue.textContent = `${Math.round(getExportScale() * 100)}%`;
}

function footerText(page, total) {
  return `${page}/${total}  ${formatDateTime(capture.capturedAt)}`;
}

function formatDateTime(value) {
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function baseFilename() {
  const title = capture?.source?.title || "full-page-capture";
  const safeTitle = title
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${safeTitle || "full-page-capture"}-${stamp}`;
}

function zipPageRootName() {
  const title = capture?.source?.title || "full-page-capture";
  const asciiTitle = title
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${asciiTitle || "capture"}-${stamp}`;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Could not encode image."));
        return;
      }
      resolve(blob);
    }, type, quality);
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load screenshot slice."));
    image.src = src;
  });
}

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(",")[1] || "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function buildZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const crc = crc32(file.bytes);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, file.bytes.length, true);
    localView.setUint32(22, file.bytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);
    localParts.push(localHeader, file.bytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, file.bytes.length, true);
    centralView.setUint32(24, file.bytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + file.bytes.length;
  }

  const centralOffset = offset;
  const centralBytes = concatBytes(centralParts);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralBytes.length, true);
  endView.setUint32(16, centralOffset, true);
  endView.setUint16(20, 0, true);

  return concatBytes([...localParts, centralBytes, end]);
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  return { date: dosDate, time: dosTime };
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let j = 0; j < 8; j += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function setBusy(isBusy, message) {
  setExportControlsEnabled(!isBusy);
  if (message) {
    setStatus(message);
  }
}

function setExportControlsEnabled(enabled) {
  for (const button of [elements.savePng, elements.savePagedPng, elements.saveJpeg, elements.savePagedJpeg, elements.savePdf, elements.cropFull, elements.cropVisible]) {
    button.disabled = !enabled;
  }
  if (enabled) {
    updatePaginationControls();
  } else {
    for (const button of [elements.seedPageCuts, elements.addPageCut, elements.deletePageCut, elements.clearPageCuts]) {
      button.disabled = true;
    }
  }
}

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.style.color = isError ? "#b42318" : "";
}

function reportHandledError(error) {
  if (console.debug) {
    console.debug("Handled XF FullPage Capture error:", error);
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

class SimplePdf {
  constructor() {
    this.objects = [];
    this.pages = [];
  }

  addObject(content) {
    this.objects.push(content);
    return this.objects.length;
  }

  addImagePage(options) {
    const imageObject = this.addObject({
      type: "stream",
      dictionary: `<< /Type /XObject /Subtype /Image /Width ${options.imageWidth} /Height ${options.imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${options.imageBytes.length} >>`,
      bytes: options.imageBytes
    });

    const imageName = `Im${this.pages.length + 1}`;
    const footerOps = options.footer
      ? `BT /F1 8 Tf 0.45 g 24 14 Td (${escapePdfText(options.footer.slice(0, 120))}) Tj ET\n`
      : "";
    const content = [
      "q",
      `${formatNumber(options.width)} 0 0 ${formatNumber(options.height)} ${formatNumber(options.x)} ${formatNumber(options.y)} cm`,
      `/${imageName} Do`,
      "Q",
      footerOps
    ].join("\n");
    const contentBytes = stringToBytes(content);

    const contentObject = this.addObject({
      type: "stream",
      dictionary: `<< /Length ${contentBytes.length} >>`,
      bytes: contentBytes
    });

    const pageObject = this.addObject(`<< /Type /Page /Parent 0 0 R /MediaBox [0 0 ${formatNumber(options.pageWidth)} ${formatNumber(options.pageHeight)}] /Resources << /XObject << /${imageName} ${imageObject} 0 R >> /Font << /F1 0 0 R >> >> /Contents ${contentObject} 0 R >>`);
    this.pages.push({ id: pageObject, imageObject, contentObject });
  }

  build() {
    const fontObject = this.addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    const pagesObject = this.addObject(`<< /Type /Pages /Kids [${this.pages.map((page) => `${page.id} 0 R`).join(" ")}] /Count ${this.pages.length} >>`);

    for (const page of this.pages) {
      this.objects[page.id - 1] = this.objects[page.id - 1]
        .replace("/Parent 0 0 R", `/Parent ${pagesObject} 0 R`)
        .replace("/F1 0 0 R", `/F1 ${fontObject} 0 R`);
    }

    const catalogObject = this.addObject(`<< /Type /Catalog /Pages ${pagesObject} 0 R >>`);
    const chunks = [stringToBytes("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")];
    const offsets = [0];
    let length = chunks[0].length;

    this.objects.forEach((object, index) => {
      offsets.push(length);
      const objectHeader = stringToBytes(`${index + 1} 0 obj\n`);
      const objectFooter = stringToBytes("\nendobj\n");
      chunks.push(objectHeader);
      length += objectHeader.length;

      if (typeof object === "string") {
        const bytes = stringToBytes(object);
        chunks.push(bytes);
        length += bytes.length;
      } else {
        const dictBytes = stringToBytes(`${object.dictionary}\nstream\n`);
        const streamFooter = stringToBytes("\nendstream");
        chunks.push(dictBytes, object.bytes, streamFooter);
        length += dictBytes.length + object.bytes.length + streamFooter.length;
      }

      chunks.push(objectFooter);
      length += objectFooter.length;
    });

    const xrefOffset = length;
    const xrefLines = [
      "xref",
      `0 ${this.objects.length + 1}`,
      "0000000000 65535 f "
    ];
    for (let i = 1; i < offsets.length; i += 1) {
      xrefLines.push(`${String(offsets[i]).padStart(10, "0")} 00000 n `);
    }
    xrefLines.push(
      "trailer",
      `<< /Size ${this.objects.length + 1} /Root ${catalogObject} 0 R >>`,
      "startxref",
      String(xrefOffset),
      "%%EOF"
    );
    chunks.push(stringToBytes(`${xrefLines.join("\n")}\n`));

    return concatBytes(chunks);
  }
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function stringToBytes(text) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function escapePdfText(text) {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/[^\x20-\x7E]/g, "?");
}

function formatNumber(value) {
  return Number(value).toFixed(2).replace(/\.?0+$/, "");
}
