const params = new URLSearchParams(location.search);
const sectionIds = (params.get("ids") || "").split(",").map((id) => id.trim()).filter(Boolean);
const fromCaptureId = params.get("from") || sectionIds[0] || "";

const elements = {
  meta: document.querySelector("#meta"),
  status: document.querySelector("#status"),
  backToResult: document.querySelector("#backToResult"),
  exportPagedPng: document.querySelector("#exportPagedPng"),
  exportPagedJpeg: document.querySelector("#exportPagedJpeg"),
  exportPdf: document.querySelector("#exportPdf"),
  paper: document.querySelector("#paper"),
  orientation: document.querySelector("#orientation"),
  includeMeta: document.querySelector("#includeMeta"),
  previewZoom: document.querySelector("#previewZoom"),
  previewZoomValue: document.querySelector("#previewZoomValue"),
  previewLayout: document.querySelector("#previewLayout"),
  fitWidth: document.querySelector("#fitWidth"),
  activeSection: document.querySelector("#activeSection"),
  moveUp: document.querySelector("#moveUp"),
  moveDown: document.querySelector("#moveDown"),
  applyActiveToAll: document.querySelector("#applyActiveToAll"),
  sectionList: document.querySelector("#sectionList"),
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
  pageRangeMode: document.querySelector("#pageRangeMode"),
  pageRiskInfo: document.querySelector("#pageRiskInfo"),
  seedPageCuts: document.querySelector("#seedPageCuts"),
  addPageCut: document.querySelector("#addPageCut"),
  deletePageCut: document.querySelector("#deletePageCut"),
  clearPageCuts: document.querySelector("#clearPageCuts"),
  pageCutList: document.querySelector("#pageCutList"),
  cacheUsage: document.querySelector("#cacheUsage"),
  autoClearAfterExport: document.querySelector("#autoClearAfterExport"),
  refreshCacheUsage: document.querySelector("#refreshCacheUsage"),
  deleteSelectedCaches: document.querySelector("#deleteSelectedCaches"),
  sectionGrid: document.querySelector("#sectionGrid"),
  loadingOverlay: document.querySelector("#loadingOverlay"),
  loadingTitle: document.querySelector("#loadingTitle"),
  loadingDetail: document.querySelector("#loadingDetail")
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

const EDITOR_STATE_VERSION = 1;
const EDITOR_STATE_PREFIX = "xfFullPageCapture:editor:";
const PREVIEW_PIXEL_BUDGET = 90_000_000;
const MAX_CANVAS_PIXELS = 220_000_000;
const MAX_CANVAS_SIDE = 65535;
const PDF_PAGE_SAFE_MIN_RATIO = 0.92;
const PDF_PAGE_SAFE_MAX_RATIO = 1.08;
const PDF_RISK_MESSAGE_LIMIT = 2;

let sections = [];
let activeSectionId = "";
let isUpdatingControls = false;
let activeDrag = null;
let previewScale = 0.5;

init().catch((error) => {
  reportHandledError(error);
  setBusy(false);
  setStatus(error.message || String(error), true);
});

elements.backToResult.addEventListener("click", () => {
  if (fromCaptureId) {
    location.href = chrome.runtime.getURL(`result/result.html?id=${encodeURIComponent(fromCaptureId)}`);
  }
});

elements.exportPagedPng.addEventListener("click", () => {
  exportMergedPagedImages({
    type: "image/png",
    extension: "png",
    label: "PNG"
  }).catch((error) => {
    reportHandledError(error);
    setStatus(error.message || String(error), true);
    setBusy(false);
  });
});

elements.exportPagedJpeg.addEventListener("click", () => {
  exportMergedPagedImages({
    type: "image/jpeg",
    extension: "jpg",
    quality: 0.92,
    label: "JPEG"
  }).catch((error) => {
    reportHandledError(error);
    setStatus(error.message || String(error), true);
    setBusy(false);
  });
});

elements.exportPdf.addEventListener("click", () => {
  exportMergedPdf().catch((error) => {
    reportHandledError(error);
    setStatus(error.message || String(error), true);
    setBusy(false);
  });
});

for (const input of [elements.paper, elements.orientation, elements.includeMeta]) {
  input.addEventListener("change", () => {
    syncAutoPageCutsForAllSections();
    updateAllPageOverlays();
    renderActiveControls();
    saveAllSectionStates();
  });
}

elements.pageRangeMode.addEventListener("change", () => {
  updateAllPageOverlays();
  renderActiveControls();
});

elements.activeSection.addEventListener("change", () => {
  setActiveSection(elements.activeSection.value);
});

elements.previewZoom.addEventListener("input", () => {
  previewScale = getPreviewScaleFromInput();
  applyPreviewScale();
});

elements.previewLayout.addEventListener("change", () => {
  updatePreviewLayout();
  requestAnimationFrame(() => fitPreviewWidth({ onlyIfOverflowing: true }));
});

elements.fitWidth.addEventListener("click", () => {
  fitPreviewWidth();
});

elements.moveUp.addEventListener("click", () => {
  moveActiveSection(-1);
});

elements.moveDown.addEventListener("click", () => {
  moveActiveSection(1);
});

elements.applyActiveToAll.addEventListener("click", () => {
  applyActiveStateToAll();
});

elements.enableCrop.addEventListener("change", () => {
  const section = getActiveSection();
  if (!section) {
    return;
  }
  section.state.enableCrop = elements.enableCrop.checked;
  if (section.state.enableCrop && (!section.state.crop || isFullPreviewCrop(section, section.state.crop))) {
    section.state.crop = visiblePreviewCrop(section);
  }
  syncAutoPageCutsForSection(section);
  updateSectionOverlay(section);
  renderActiveControls();
  saveSectionState(section);
});

for (const input of [elements.cropX, elements.cropY, elements.cropWidth, elements.cropHeight]) {
  input.addEventListener("input", () => {
    if (isUpdatingControls) {
      return;
    }
    const section = getActiveSection();
    if (!section) {
      return;
    }
    section.state.enableCrop = true;
    section.state.crop = normalizePreviewCrop(section, readCropInputs());
    syncAutoPageCutsForSection(section);
    updateSectionOverlay(section);
    renderActiveControls();
    saveSectionState(section);
  });
}

elements.exportScale.addEventListener("input", () => {
  const section = getActiveSection();
  if (!section) {
    return;
  }
  section.state.exportScale = getActiveExportScale();
  updateScaleReadout();
  syncAutoPageCutsForSection(section);
  updateSectionPageOverlay(section);
  renderPageCutInfo(section);
  saveSectionState(section);
});

elements.cropFull.addEventListener("click", () => {
  const section = getActiveSection();
  if (!section) {
    return;
  }
  section.state.enableCrop = false;
  section.state.crop = fullPreviewCrop(section);
  syncAutoPageCutsForSection(section);
  updateSectionOverlay(section);
  renderActiveControls();
  saveSectionState(section);
});

elements.cropVisible.addEventListener("click", () => {
  const section = getActiveSection();
  if (!section) {
    return;
  }
  section.state.enableCrop = true;
  section.state.crop = visiblePreviewCrop(section);
  syncAutoPageCutsForSection(section);
  updateSectionOverlay(section);
  renderActiveControls();
  saveSectionState(section);
});

elements.customPagination.addEventListener("change", () => {
  const section = getActiveSection();
  if (!section) {
    return;
  }
  section.state.customPagination = elements.customPagination.checked;
  if (section.state.customPagination && (section.state.manualCutFractions.length === 0 || section.state.manualCutMode === "auto")) {
    seedSectionPageCuts(section);
  }
  if (!section.state.customPagination) {
    section.state.manualCutMode = "auto";
  }
  section.state.selectedPageCutIndex = -1;
  updateSectionPageOverlay(section);
  renderActiveControls();
  saveSectionState(section);
});

elements.seedPageCuts.addEventListener("click", () => {
  const section = getActiveSection();
  if (!section) {
    return;
  }
  section.state.customPagination = true;
  seedSectionPageCuts(section);
  updateSectionPageOverlay(section);
  renderActiveControls();
  saveSectionState(section);
});

elements.addPageCut.addEventListener("click", () => {
  const section = getActiveSection();
  if (!section) {
    return;
  }
  section.state.customPagination = true;
  const fraction = preferredPageCutFraction(section);
  insertManualCut(section, fraction);
  markSectionPageCutsEdited(section);
  updateSectionPageOverlay(section);
  renderActiveControls();
  saveSectionState(section);
});

elements.deletePageCut.addEventListener("click", () => {
  const section = getActiveSection();
  if (!section || section.state.selectedPageCutIndex < 0) {
    return;
  }
  section.state.manualCutFractions.splice(section.state.selectedPageCutIndex, 1);
  markSectionPageCutsEdited(section);
  section.state.selectedPageCutIndex = Math.min(section.state.selectedPageCutIndex, section.state.manualCutFractions.length - 1);
  if (!section.state.manualCutFractions.length) {
    section.state.customPagination = false;
    section.state.manualCutMode = "auto";
    section.state.selectedPageCutIndex = -1;
  }
  updateSectionPageOverlay(section);
  renderActiveControls();
  saveSectionState(section);
});

elements.clearPageCuts.addEventListener("click", () => {
  const section = getActiveSection();
  if (!section) {
    return;
  }
  section.state.customPagination = false;
  section.state.manualCutFractions = [];
  section.state.manualCutMode = "auto";
  section.state.selectedPageCutIndex = -1;
  updateSectionPageOverlay(section);
  renderActiveControls();
  saveSectionState(section);
});

elements.refreshCacheUsage.addEventListener("click", () => {
  refreshCacheUsage().catch((error) => {
    reportHandledError(error);
    setStatus(error.message || String(error), true);
  });
});

elements.deleteSelectedCaches.addEventListener("click", () => {
  deleteSelectedCaches().catch((error) => {
    reportHandledError(error);
    setStatus(error.message || String(error), true);
  });
});

document.addEventListener("keydown", handleEditorKeydown);
document.addEventListener("pointermove", updateDrag);
document.addEventListener("pointerup", finishDrag);
document.addEventListener("pointercancel", finishDrag);

async function init() {
  if (!sectionIds.length) {
    throw new Error("缺少要合并的截图节。请回到结果页重新选择。");
  }

  setBusy(true, "正在加载分节截图...", "正在读取分节信息，请稍等。");
  sections = await Promise.all(sectionIds.map(loadSection));
  activeSectionId = sections[0]?.id || "";
  renderSectionCards();
  renderSectionNavigation();
  updatePreviewLayout();

  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i];
    updateLoadingMessage(
      `正在拼接第 ${i + 1}/${sections.length} 节预览...`,
      "长图预览需要逐张读取并拼接切片，页面短暂变慢是正常的。"
    );
    setStatus(`正在拼接第 ${i + 1}/${sections.length} 节预览...`);
    await composeSectionPreview(section);
    section.state = normalizeEditorState(section, readSavedEditorState(section.id));
    updateSectionOverlay(section);
  }

  fitPreviewWidth({ silent: true });
  await refreshCacheUsage();

  const firstState = readSavedEditorState(sections[0]?.id);
  if (paperSizes[firstState?.paper]) {
    elements.paper.value = firstState.paper;
  }
  if (firstState?.orientation === "portrait" || firstState?.orientation === "landscape") {
    elements.orientation.value = firstState.orientation;
  }
  if (typeof firstState?.includeMeta === "boolean") {
    elements.includeMeta.checked = firstState.includeMeta;
  }

  renderSectionNavigation();
  setActiveSection(activeSectionId, { skipScroll: true });
  setBusy(false, `已加载 ${sections.length} 节。可在同一页分别调整后合并。`);
}

async function loadSection(id) {
  const capture = await fetchCaptureMeta(id);
  return {
    id,
    capture,
    state: null,
    canvasScale: 1,
    naturalCanvasScale: 1,
    targetWidth: capture.target?.visibleWidth || 1,
    targetHeight: capture.target?.totalHeight || 1,
    card: null,
    canvasScroll: null,
    scaleFrame: null,
    stage: null,
    canvas: null,
    cropBox: null,
    pageOverlay: null
  };
}

function renderSectionCards() {
  elements.sectionGrid.replaceChildren();
  for (const section of sections) {
    const card = document.createElement("article");
    card.className = "section-card";
    card.dataset.sectionId = section.id;

    const header = document.createElement("div");
    header.className = "section-card-header";

    const titleWrap = document.createElement("div");
    const title = document.createElement("p");
    title.className = "section-title";
    title.textContent = section.capture.source?.title || "未命名截图";
    const meta = document.createElement("p");
    meta.className = "section-meta";
    meta.textContent = sectionMetaText(section);
    titleWrap.append(title, meta);

    const badge = document.createElement("span");
    badge.className = "section-badge";
    badge.textContent = section.capture.segment?.part ? `第 ${section.capture.segment.part} 节` : "分节";
    header.append(titleWrap, badge);

    const scroll = document.createElement("div");
    scroll.className = "canvas-scroll";

    const scaleFrame = document.createElement("div");
    scaleFrame.className = "canvas-scale-frame";

    const stage = document.createElement("div");
    stage.className = "canvas-stage";

    const canvas = document.createElement("canvas");
    const cropBox = document.createElement("div");
    cropBox.className = "crop-box";
    cropBox.hidden = true;
    cropBox.dataset.cropAction = "move";
    for (const action of ["n", "e", "s", "w"]) {
      const edge = document.createElement("span");
      edge.className = `crop-edge crop-edge-${action}`;
      edge.dataset.cropAction = action;
      cropBox.appendChild(edge);
    }
    for (const action of ["n", "e", "s", "w", "nw", "ne", "se", "sw"]) {
      const handle = document.createElement("span");
      handle.className = `crop-handle crop-handle-${action}`;
      handle.dataset.cropAction = action;
      cropBox.appendChild(handle);
    }

    const pageOverlay = document.createElement("div");
    pageOverlay.className = "page-overlay";

    stage.append(canvas, cropBox, pageOverlay);
    scaleFrame.appendChild(stage);
    scroll.appendChild(scaleFrame);
    card.append(header, scroll);
    elements.sectionGrid.appendChild(card);

    section.card = card;
    section.canvasScroll = scroll;
    section.scaleFrame = scaleFrame;
    section.stage = stage;
    section.canvas = canvas;
    section.cropBox = cropBox;
    section.pageOverlay = pageOverlay;

    card.addEventListener("click", () => setActiveSection(section.id));
    cropBox.addEventListener("pointerdown", (event) => {
      startCropDrag(event, section, event.target.dataset.cropAction || "move");
    });
  }
}

async function composeSectionPreview(section) {
  const firstSlice = await fetchCaptureSlice(section.id, 0);
  const firstImage = await loadImage(firstSlice.dataUrl);
  const first = stripSliceData(firstSlice);
  section.naturalCanvasScale = firstImage.naturalWidth / first.viewport.width;
  section.targetWidth = section.capture.target?.visibleWidth || first.cropRect.width || first.viewport.width;
  section.targetHeight = section.capture.target?.totalHeight || first.targetVisibleHeight || first.cropRect.height;

  const naturalWidth = Math.round(section.targetWidth * section.naturalCanvasScale);
  const naturalHeight = Math.round(section.targetHeight * section.naturalCanvasScale);
  const downscale = getSafePreviewDownscale(naturalWidth, naturalHeight);
  section.canvasScale = section.naturalCanvasScale * downscale;

  const width = Math.max(1, Math.round(section.targetWidth * section.canvasScale));
  const height = Math.max(1, Math.round(section.targetHeight * section.canvasScale));
  assertCanvasSize(width, height);

  section.canvas.width = width;
  section.canvas.height = height;
  section.stage.style.width = `${width}px`;
  section.stage.style.height = `${height}px`;
  updateSectionPreviewScale(section);
  const context = section.canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);

  for (let index = 0; index < section.capture.slices.length; index += 1) {
    const sliceWithData = index === 0 ? firstSlice : await fetchCaptureSlice(section.id, index);
    const slice = stripSliceData(sliceWithData);
    const image = index === 0 ? firstImage : await loadImage(sliceWithData.dataUrl);
    const scaleX = image.naturalWidth / slice.viewport.width;
    const scaleY = image.naturalHeight / slice.viewport.height;
    const sx = Math.round(slice.cropRect.x * scaleX);
    const sy = Math.round(slice.cropRect.y * scaleY);
    const sw = Math.round(slice.cropRect.width * scaleX);
    const sh = Math.round(Math.min(slice.cropRect.height, slice.targetVisibleHeight) * scaleY);
    const dy = Math.round(slice.scrollTop * section.canvasScale);
    const dw = Math.round(slice.cropRect.width * section.canvasScale);
    const dh = Math.round(Math.min(slice.cropRect.height, slice.targetVisibleHeight) * section.canvasScale);
    context.drawImage(image, sx, sy, sw, sh, 0, dy, dw, dh);
  }
}

function renderSectionNavigation() {
  elements.activeSection.replaceChildren();
  elements.sectionList.replaceChildren();

  sections.forEach((section, index) => {
    const option = document.createElement("option");
    option.value = section.id;
    option.textContent = `${index + 1}. ${section.capture.source?.title || "未命名截图"}`;
    elements.activeSection.appendChild(option);

    const button = document.createElement("button");
    button.type = "button";
    button.className = `section-list-item${section.id === activeSectionId ? " is-active" : ""}`;
    button.dataset.sectionId = section.id;

    const title = document.createElement("p");
    title.className = "section-list-title";
    title.textContent = section.capture.source?.title || "未命名截图";
    const meta = document.createElement("p");
    meta.className = "section-list-meta";
    meta.textContent = sectionMetaText(section);

    button.append(title, meta);
    button.addEventListener("click", () => setActiveSection(section.id));
    elements.sectionList.appendChild(button);

    if (section.card) {
      section.card.classList.toggle("is-active", section.id === activeSectionId);
    }
  });

  elements.activeSection.value = activeSectionId;
  const activeIndex = sections.findIndex((section) => section.id === activeSectionId);
  elements.moveUp.disabled = activeIndex <= 0;
  elements.moveDown.disabled = activeIndex < 0 || activeIndex >= sections.length - 1;
  elements.applyActiveToAll.disabled = sections.length < 2 || activeIndex < 0;
}

function setActiveSection(id, options = {}) {
  activeSectionId = id;
  renderSectionNavigation();
  renderActiveControls();
  if (!options.skipScroll) {
    scrollActiveSectionIntoView();
  }
}

function scrollActiveSectionIntoView() {
  const section = getActiveSection();
  if (!section?.card) {
    return;
  }
  section.card.scrollIntoView({
    behavior: "smooth",
    block: "start",
    inline: elements.previewLayout.value === "single" ? "nearest" : "center"
  });
}

function getActiveSection() {
  return sections.find((section) => section.id === activeSectionId) || null;
}

function getPreviewScaleFromInput() {
  return clamp(Number(elements.previewZoom.value) || 0.5, 0.15, 1);
}

function updatePreviewLayout() {
  elements.sectionGrid.dataset.layout = elements.previewLayout.value || "double";
}

function applyPreviewScale() {
  elements.previewZoom.value = String(previewScale);
  elements.previewZoomValue.textContent = `${Math.round(previewScale * 100)}%`;
  for (const section of sections) {
    updateSectionPreviewScale(section);
    updateSectionOverlay(section);
  }
}

function updateSectionPreviewScale(section) {
  if (!section.scaleFrame || !section.stage || !section.canvas?.width) {
    return;
  }
  const scaledWidth = Math.max(1, Math.round(section.canvas.width * previewScale));
  const scaledHeight = Math.max(1, Math.round(section.canvas.height * previewScale));
  section.scaleFrame.style.width = `${scaledWidth}px`;
  section.scaleFrame.style.height = `${scaledHeight}px`;
  section.stage.style.transform = `scale(${previewScale})`;
}

function fitPreviewWidth(options = {}) {
  const availableScales = sections
    .filter((section) => section.canvas?.width && section.canvasScroll?.clientWidth)
    .map((section) => (section.canvasScroll.clientWidth - 16) / section.canvas.width);
  if (!availableScales.length) {
    return;
  }
  const target = clamp(Math.min(...availableScales), 0.15, 1);
  if (options.onlyIfOverflowing && target >= previewScale) {
    return;
  }
  previewScale = target;
  applyPreviewScale();
  if (!options.silent) {
    setStatus(`预览已适配到 ${Math.round(previewScale * 100)}%。`);
  }
}

function renderActiveControls() {
  const section = getActiveSection();
  const enabled = Boolean(section?.state);
  for (const input of [
    elements.enableCrop,
    elements.cropX,
    elements.cropY,
    elements.cropWidth,
    elements.cropHeight,
    elements.exportScale,
    elements.customPagination,
    elements.pageRangeMode,
    elements.seedPageCuts,
    elements.addPageCut,
    elements.deletePageCut,
    elements.clearPageCuts,
    elements.cropFull,
    elements.cropVisible
  ]) {
    input.disabled = !enabled;
  }

  if (!enabled) {
    return;
  }

  isUpdatingControls = true;
  const state = section.state;
  const crop = state.enableCrop ? state.crop : fullPreviewCrop(section);
  elements.enableCrop.checked = state.enableCrop;
  elements.cropX.value = String(Math.round(crop.x));
  elements.cropY.value = String(Math.round(crop.y));
  elements.cropWidth.value = String(Math.round(crop.width));
  elements.cropHeight.value = String(Math.round(crop.height));
  elements.exportScale.value = String(state.exportScale);
  elements.customPagination.checked = state.customPagination;
  updateScaleReadout();
  isUpdatingControls = false;

  elements.deletePageCut.disabled = !state.customPagination || state.selectedPageCutIndex < 0;
  elements.clearPageCuts.disabled = !state.customPagination || state.manualCutFractions.length === 0;
  elements.pageRangeMode.disabled = !state.customPagination;
  renderPageCutInfo(section);
  updateSectionOverlay(section);
}

function updateScaleReadout() {
  elements.exportScaleValue.textContent = `${Math.round(getActiveExportScale() * 100)}%`;
}

function renderPageCutInfo(section) {
  if (!section.state.customPagination || section.state.manualCutFractions.length === 0) {
    elements.pageCutList.textContent = "自动分页。";
    updatePageRiskInfo(null);
    return;
  }
  normalizeManualCutFractions(section);
  const fractions = section.state.manualCutFractions.map((fraction) => `${Math.round(fraction * 100)}%`);
  const selected = section.state.selectedPageCutIndex >= 0 && section.state.selectedPageCutIndex < fractions.length
    ? `。已选中第 ${section.state.selectedPageCutIndex + 1} 条`
    : "";
  const exportState = getSectionExportState(section);
  const cuts = [0, ...section.state.manualCutFractions, 1];
  const analysis = analyzeSectionPageRanges(section, cuts, exportState);
  elements.pageCutList.textContent = `${fractions.length} 条：${fractions.join(" / ")}${selected}`;
  updatePageRiskInfo(analysis);
}

function moveActiveSection(direction) {
  const index = sections.findIndex((section) => section.id === activeSectionId);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= sections.length) {
    return;
  }
  [sections[index], sections[nextIndex]] = [sections[nextIndex], sections[index]];
  for (const section of sections) {
    elements.sectionGrid.appendChild(section.card);
  }
  renderSectionNavigation();
}

function handleEditorKeydown(event) {
  if (isEditableTarget(event.target)) {
    return;
  }
  const section = getActiveSection();
  if (!section?.state) {
    return;
  }

  if (event.key === "a" || event.key === "A" || event.key === "+" || event.key === "=") {
    event.preventDefault();
    section.state.customPagination = true;
    insertManualCut(section, preferredPageCutFraction(section));
    markSectionPageCutsEdited(section);
    updateSectionPageOverlay(section);
    renderActiveControls();
    saveSectionState(section);
    setStatus("已在当前可见区域新增分页线。");
    return;
  }

  if (event.key === "Delete" || event.key === "Backspace") {
    if (!section.state.customPagination || section.state.selectedPageCutIndex < 0) {
      return;
    }
    event.preventDefault();
    section.state.manualCutFractions.splice(section.state.selectedPageCutIndex, 1);
    markSectionPageCutsEdited(section);
    section.state.selectedPageCutIndex = Math.min(section.state.selectedPageCutIndex, section.state.manualCutFractions.length - 1);
    if (!section.state.manualCutFractions.length) {
      section.state.customPagination = false;
      section.state.manualCutMode = "auto";
      section.state.selectedPageCutIndex = -1;
    }
    updateSectionPageOverlay(section);
    renderActiveControls();
    saveSectionState(section);
    setStatus("已删除选中的分页线。");
  }
}

function isEditableTarget(target) {
  return target instanceof HTMLInputElement
    || target instanceof HTMLSelectElement
    || target instanceof HTMLTextAreaElement
    || Boolean(target?.isContentEditable);
}

function applyActiveStateToAll() {
  const source = getActiveSection();
  if (!source?.state) {
    return;
  }
  for (const section of sections) {
    if (section.id === source.id) {
      continue;
    }
    section.state = copyStateBetweenSections(source, section);
    updateSectionOverlay(section);
    saveSectionState(section);
  }
  saveSectionState(source);
  renderActiveControls();
  setStatus("已把当前节参数套用到全部分节。");
}

function copyStateBetweenSections(source, target) {
  const sourceState = source.state;
  const sourceCrop = sourceState.crop || fullPreviewCrop(source);
  const xRatio = sourceCrop.x / source.canvas.width;
  const yRatio = sourceCrop.y / source.canvas.height;
  const widthRatio = sourceCrop.width / source.canvas.width;
  const heightRatio = sourceCrop.height / source.canvas.height;
  return {
    enableCrop: sourceState.enableCrop,
    crop: normalizePreviewCrop(target, {
      x: xRatio * target.canvas.width,
      y: yRatio * target.canvas.height,
      width: widthRatio * target.canvas.width,
      height: heightRatio * target.canvas.height
    }),
    exportScale: sourceState.exportScale,
    customPagination: sourceState.customPagination,
    manualCutMode: sourceState.manualCutMode === "auto" ? "auto" : "manual",
    manualCutFractions: [...sourceState.manualCutFractions],
    selectedPageCutIndex: -1
  };
}

function updateSectionOverlay(section) {
  updateSectionCropOverlay(section);
  updateSectionPageOverlay(section);
}

function updateSectionCropOverlay(section) {
  if (!section.state?.enableCrop) {
    section.cropBox.hidden = true;
    return;
  }
  const crop = normalizePreviewCrop(section, section.state.crop || fullPreviewCrop(section));
  section.state.crop = crop;
  section.cropBox.hidden = false;
  section.cropBox.style.left = `${crop.x}px`;
  section.cropBox.style.top = `${crop.y}px`;
  section.cropBox.style.width = `${crop.width}px`;
  section.cropBox.style.height = `${crop.height}px`;
}

function updateSectionPageOverlay(section) {
  section.pageOverlay.replaceChildren();
  if (!section.state?.customPagination) {
    return;
  }

  normalizeManualCutFractions(section);
  const cuts = [0, ...section.state.manualCutFractions, 1];
  const exportState = getSectionExportState(section);
  const analysis = analyzeSectionPageRanges(section, cuts, exportState);
  const pageRangeMode = elements.pageRangeMode.value || "all";

  if (pageRangeMode !== "off") {
    for (let index = 0; index < cuts.length - 1; index += 1) {
      const lineIndex = index;
      if (pageRangeMode === "selected"
        && section.state.selectedPageCutIndex >= 0
        && lineIndex !== section.state.selectedPageCutIndex) {
        continue;
      }
      const start = cuts[index];
      const end = cuts[index + 1];
      const page = analysis.pages[index];
      const zone = document.createElement("div");
      zone.className = `page-zone${page?.warning?.type === "too-short" ? " is-short" : ""}${page?.warning?.type === "too-tall" ? " is-tall" : ""}`;
      zone.style.top = `${Math.round(start * section.canvas.height)}px`;
      zone.style.height = `${Math.max(1, Math.round((end - start) * section.canvas.height))}px`;

      const label = document.createElement("span");
      label.className = "page-zone-label";
      label.textContent = pageZoneLabel(index + 1, page?.ratio || 1);
      zone.appendChild(label);
      section.pageOverlay.appendChild(zone);
    }

    for (const band of analysis.bands) {
      if (pageRangeMode === "selected"
        && section.state.selectedPageCutIndex >= 0
        && band.cutIndex !== section.state.selectedPageCutIndex) {
        continue;
      }
      const bandElement = document.createElement("div");
      bandElement.className = `page-safe-band${band.isWarning ? " is-warning" : ""}`;
      bandElement.style.top = `${Math.round(band.start * section.canvas.height)}px`;
      bandElement.style.height = `${Math.max(10, Math.round((band.end - band.start) * section.canvas.height))}px`;

      const label = document.createElement("span");
      label.className = "page-safe-label";
      label.textContent = "PDF参考区";
      bandElement.appendChild(label);
      section.pageOverlay.appendChild(bandElement);
    }
  }

  section.state.manualCutFractions.forEach((fraction, index) => {
    const lineRisk = analysis.lineWarnings[index] || null;
    const line = document.createElement("div");
    line.className = `page-line${index === section.state.selectedPageCutIndex ? " is-active" : ""}`;
    if (lineRisk) {
      line.classList.add("is-risk", `is-${lineRisk.type}`);
    }
    line.dataset.label = lineRisk ? `自定义 P${index + 1} · ${lineRisk.label}` : `自定义 P${index + 1}`;
    line.style.top = `${Math.round(fraction * section.canvas.height)}px`;
    line.addEventListener("pointerdown", (event) => startPageCutDrag(event, section, index));
    section.pageOverlay.appendChild(line);
  });
}

function pageZoneLabel(page, ratio) {
  if (ratio > PDF_PAGE_SAFE_MAX_RATIO) {
    return `第 ${page} 页 · 偏长，PDF 可能缩小`;
  }
  if (ratio < PDF_PAGE_SAFE_MIN_RATIO) {
    return `第 ${page} 页 · 偏短，PDF 可能拉长/留白`;
  }
  return `第 ${page} 页 · 接近纸张范围`;
}

function analyzeSectionPageRanges(section, cuts, exportState) {
  const idealHeight = Math.max(1, getPageLayoutPx(exportState.outputWidth).contentHeight);
  const safeMin = idealHeight * PDF_PAGE_SAFE_MIN_RATIO;
  const safeMax = idealHeight * PDF_PAGE_SAFE_MAX_RATIO;
  const analysis = {
    items: [],
    pages: [],
    lineWarnings: [],
    bands: []
  };

  for (let pageIndex = 0; pageIndex < cuts.length - 1; pageIndex += 1) {
    const start = cuts[pageIndex];
    const end = cuts[pageIndex + 1];
    const startPx = start * exportState.outputHeight;
    const endPx = end * exportState.outputHeight;
    const ratio = Math.max(1, endPx - startPx) / idealHeight;
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
        message: `第 ${pageIndex + 1} 页低于 PDF 参考区，导出 PDF 可能被放大或出现明显留白。`
      };
    } else if (tooTall) {
      warning = {
        page: pageIndex + 1,
        type: "too-tall",
        label: "偏长",
        ratio,
        message: `第 ${pageIndex + 1} 页超过 PDF 参考区，导出 PDF 可能被纵向压缩。`
      };
    }

    analysis.pages[pageIndex] = { ratio, warning };

    if (pageIndex < cuts.length - 2) {
      analysis.bands.push({
        cutIndex: pageIndex,
        start: clamp((startPx + safeMin) / exportState.outputHeight, 0, 0.999),
        end: clamp((startPx + safeMax) / exportState.outputHeight, 0.001, 1),
        isWarning: Boolean(warning)
      });
      if (warning) {
        analysis.lineWarnings[pageIndex] = warning;
      }
    }

    if (warning) {
      analysis.items.push(warning);
    }
  }

  return analysis;
}

function updatePageRiskInfo(analysis) {
  elements.pageRiskInfo.classList.remove("is-ok", "is-warning");
  if (!analysis) {
    elements.pageRiskInfo.textContent = "开启自定义分页线后，预览里会显示 PDF 参考区。";
    return;
  }
  if (analysis.items.length === 0) {
    elements.pageRiskInfo.classList.add("is-ok");
    elements.pageRiskInfo.textContent = "当前节分页线在 PDF 参考区内。";
    return;
  }
  elements.pageRiskInfo.classList.add("is-warning");
  elements.pageRiskInfo.textContent = buildPageRiskSummary(analysis);
}

function buildPageRiskSummary(analysis) {
  const messages = analysis.items
    .slice(0, PDF_RISK_MESSAGE_LIMIT)
    .map((item) => item.message);
  const remaining = analysis.items.length > PDF_RISK_MESSAGE_LIMIT
    ? ` 另有 ${analysis.items.length - PDF_RISK_MESSAGE_LIMIT} 页也偏离参考区。`
    : "";
  return `${messages.join(" ")}${remaining}`;
}

function updateAllPageOverlays() {
  for (const section of sections) {
    updateSectionPageOverlay(section);
  }
}

function readCropInputs() {
  return {
    x: Number(elements.cropX.value) || 0,
    y: Number(elements.cropY.value) || 0,
    width: Number(elements.cropWidth.value) || 1,
    height: Number(elements.cropHeight.value) || 1
  };
}

function fullPreviewCrop(section) {
  return {
    x: 0,
    y: 0,
    width: Math.max(1, section.canvas.width),
    height: Math.max(1, section.canvas.height)
  };
}

function visiblePreviewCrop(section) {
  const visible = visibleStageRect(section);
  return normalizePreviewCrop(section, {
    x: visible.x,
    y: visible.y,
    width: visible.width,
    height: visible.height
  });
}

function visibleStageRect(section) {
  const scrollRect = section.canvasScroll.getBoundingClientRect();
  const stageRect = section.stage.getBoundingClientRect();
  const scaleX = stageRect.width / Math.max(1, section.canvas.width);
  const scaleY = stageRect.height / Math.max(1, section.canvas.height);
  return normalizePreviewCrop(section, {
    x: (scrollRect.left - stageRect.left) / Math.max(0.001, scaleX),
    y: (scrollRect.top - stageRect.top) / Math.max(0.001, scaleY),
    width: section.canvasScroll.clientWidth / Math.max(0.001, scaleX),
    height: section.canvasScroll.clientHeight / Math.max(0.001, scaleY)
  });
}

function normalizePreviewCrop(section, crop) {
  const maxWidth = Math.max(1, section.canvas.width);
  const maxHeight = Math.max(1, section.canvas.height);
  const x = clamp(Math.round(Number(crop.x) || 0), 0, Math.max(0, maxWidth - 1));
  const y = clamp(Math.round(Number(crop.y) || 0), 0, Math.max(0, maxHeight - 1));
  return {
    x,
    y,
    width: clamp(Math.round(Number(crop.width) || maxWidth), 1, Math.max(1, maxWidth - x)),
    height: clamp(Math.round(Number(crop.height) || maxHeight), 1, Math.max(1, maxHeight - y))
  };
}

function isFullPreviewCrop(section, crop) {
  const normalized = normalizePreviewCrop(section, crop || fullPreviewCrop(section));
  return normalized.x === 0
    && normalized.y === 0
    && normalized.width === section.canvas.width
    && normalized.height === section.canvas.height;
}

function getActiveExportScale() {
  return clamp(Number(elements.exportScale.value) || 1, 0.5, 2);
}

function startCropDrag(event, section, action) {
  if (!section.state?.enableCrop) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  setActiveSection(section.id, { skipScroll: true });
  activeDrag = {
    type: "crop",
    section,
    action,
    start: pointerToStage(section, event),
    crop: { ...section.state.crop }
  };
  capturePointer(event);
}

function startPageCutDrag(event, section, index) {
  event.preventDefault();
  event.stopPropagation();
  setActiveSection(section.id, { skipScroll: true });
  section.state.selectedPageCutIndex = index;
  activeDrag = {
    type: "page",
    section,
    index
  };
  updateSectionPageOverlay(section);
  renderActiveControls();
  capturePointer(event);
}

function updateDrag(event) {
  if (!activeDrag) {
    return;
  }
  const section = activeDrag.section;
  const point = pointerToStage(section, event);
  if (activeDrag.type === "page") {
    updateDraggedPageCut(section, activeDrag.index, point.y / section.canvas.height);
  } else {
    updateDraggedCrop(section, point);
    syncAutoPageCutsForSection(section);
  }
  updateSectionOverlay(section);
  renderActiveControls();
}

function finishDrag() {
  if (!activeDrag) {
    return;
  }
  saveSectionState(activeDrag.section);
  activeDrag = null;
}

function updateDraggedCrop(section, point) {
  const original = activeDrag.crop;
  const dx = point.x - activeDrag.start.x;
  const dy = point.y - activeDrag.start.y;
  let crop = { ...original };

  if (activeDrag.action === "move") {
    crop.x = original.x + dx;
    crop.y = original.y + dy;
  } else {
    if (activeDrag.action.includes("w")) {
      crop.x = original.x + dx;
      crop.width = original.width - dx;
    }
    if (activeDrag.action.includes("e")) {
      crop.width = original.width + dx;
    }
    if (activeDrag.action.includes("n")) {
      crop.y = original.y + dy;
      crop.height = original.height - dy;
    }
    if (activeDrag.action.includes("s")) {
      crop.height = original.height + dy;
    }
  }

  section.state.crop = normalizePreviewCrop(section, crop);
}

function pointerToStage(section, event) {
  const rect = section.stage.getBoundingClientRect();
  const scaleX = rect.width / Math.max(1, section.canvas.width);
  const scaleY = rect.height / Math.max(1, section.canvas.height);
  return {
    x: clamp((event.clientX - rect.left) / Math.max(0.001, scaleX), 0, section.canvas.width),
    y: clamp((event.clientY - rect.top) / Math.max(0.001, scaleY), 0, section.canvas.height)
  };
}

function capturePointer(event) {
  const target = event.target;
  if (target instanceof Element && typeof target.setPointerCapture === "function") {
    try {
      target.setPointerCapture(event.pointerId);
    } catch (error) {
      if (error?.name !== "InvalidStateError") {
        throw error;
      }
    }
  }
}

function seedPageCutFractions(section) {
  const exportState = getSectionExportState(section);
  const cuts = buildRegularPageCuts(exportState.outputWidth, exportState.outputHeight);
  return cuts.slice(1, -1).map((cut) => cut / exportState.outputHeight);
}

function seedSectionPageCuts(section) {
  section.state.manualCutFractions = seedPageCutFractions(section);
  section.state.manualCutMode = "auto";
  section.state.selectedPageCutIndex = -1;
}

function syncAutoPageCutsForSection(section) {
  if (!section?.state?.customPagination || section.state.manualCutMode !== "auto") {
    return false;
  }

  const previous = section.state.manualCutFractions.join(",");
  seedSectionPageCuts(section);
  return previous !== section.state.manualCutFractions.join(",");
}

function syncAutoPageCutsForAllSections() {
  for (const section of sections) {
    syncAutoPageCutsForSection(section);
  }
}

function markSectionPageCutsEdited(section) {
  section.state.manualCutMode = "manual";
}

function preferredPageCutFraction(section) {
  const visible = visibleStageRect(section);
  const visibleCenter = visible.y + visible.height / 2;
  return clamp(visibleCenter / Math.max(1, section.canvas.height), 0.01, 0.99);
}

function insertManualCut(section, fraction) {
  section.state.manualCutFractions.push(clamp(fraction, 0.001, 0.999));
  normalizeManualCutFractions(section);
  section.state.selectedPageCutIndex = section.state.manualCutFractions.findIndex((value) => Math.abs(value - fraction) < 0.002);
}

function updateDraggedPageCut(section, index, fraction) {
  const previous = index > 0 ? section.state.manualCutFractions[index - 1] : 0;
  const next = index < section.state.manualCutFractions.length - 1 ? section.state.manualCutFractions[index + 1] : 1;
  section.state.manualCutFractions[index] = clamp(fraction, previous + 0.01, next - 0.01);
  markSectionPageCutsEdited(section);
  section.state.selectedPageCutIndex = index;
}

function normalizeManualCutFractions(section) {
  section.state.manualCutFractions = [...new Set(section.state.manualCutFractions
    .map(Number)
    .filter(Number.isFinite)
    .map((fraction) => Math.round(clamp(fraction, 0.001, 0.999) * 10000) / 10000))]
    .sort((a, b) => a - b);
  if (section.state.selectedPageCutIndex >= section.state.manualCutFractions.length) {
    section.state.selectedPageCutIndex = section.state.manualCutFractions.length - 1;
  }
}

function normalizeEditorState(section, savedState) {
  const defaultState = {
    enableCrop: false,
    crop: fullPreviewCrop(section),
    exportScale: 1,
    customPagination: false,
    manualCutMode: "auto",
    manualCutFractions: [],
    selectedPageCutIndex: -1
  };

  if (!savedState) {
    return defaultState;
  }

  const state = {
    ...defaultState,
    enableCrop: Boolean(savedState.enableCrop),
    exportScale: clamp(Number(savedState.exportScale) || 1, 0.5, 2),
    customPagination: Boolean(savedState.customPagination),
    manualCutMode: savedState.customPagination
      ? savedState.manualCutMode === "auto" ? "auto" : "manual"
      : "auto",
    manualCutFractions: Array.isArray(savedState.manualCutFractions)
      ? savedState.manualCutFractions.map(Number).filter(Number.isFinite)
      : [],
    selectedPageCutIndex: -1
  };

  if (savedState.enableCrop && savedState.crop && savedState.canvas) {
    const canvasWidth = Number(savedState.canvas.width) || section.canvas.width;
    const canvasHeight = Number(savedState.canvas.height) || section.canvas.height;
    state.crop = normalizePreviewCrop(section, {
      x: (Number(savedState.crop.x) || 0) / canvasWidth * section.canvas.width,
      y: (Number(savedState.crop.y) || 0) / canvasHeight * section.canvas.height,
      width: (Number(savedState.crop.width) || canvasWidth) / canvasWidth * section.canvas.width,
      height: (Number(savedState.crop.height) || canvasHeight) / canvasHeight * section.canvas.height
    });
  }

  return state;
}

function readSavedEditorState(id) {
  try {
    const raw = localStorage.getItem(`${EDITOR_STATE_PREFIX}${id}`);
    if (!raw) {
      return null;
    }
    const state = JSON.parse(raw);
    return state?.version === EDITOR_STATE_VERSION ? state : null;
  } catch (error) {
    console.warn("Could not read editor state.", error);
    return null;
  }
}

function saveSectionState(section) {
  if (!section.state || !section.canvas.width) {
    return;
  }
  const state = {
    version: EDITOR_STATE_VERSION,
    savedAt: new Date().toISOString(),
    canvas: {
      width: section.canvas.width,
      height: section.canvas.height
    },
    paper: elements.paper.value,
    orientation: elements.orientation.value,
    includeMeta: elements.includeMeta.checked,
    enableCrop: section.state.enableCrop,
    crop: section.state.crop,
    exportScale: section.state.exportScale,
    customPagination: section.state.customPagination,
    manualCutMode: section.state.manualCutMode || "manual",
    manualCutFractions: [...section.state.manualCutFractions]
  };
  try {
    localStorage.setItem(`${EDITOR_STATE_PREFIX}${section.id}`, JSON.stringify(state));
  } catch (error) {
    console.warn("Could not save section state.", error);
  }
}

function saveAllSectionStates() {
  sections.forEach(saveSectionState);
}

async function exportMergedPagedImages({ type, extension, quality, label }) {
  if (!sections.length) {
    setStatus("没有可导出的分节。", true);
    return;
  }

  setBusy(true, `正在生成分页 ${label} ZIP...`);
  saveAllSectionStates();

  const { prepared, totalPages } = prepareSectionExports();
  const pad = Math.max(2, String(totalPages).length);
  const rootName = zipPageRootName();
  const files = [];
  let pageNumber = 0;

  for (let sectionIndex = 0; sectionIndex < prepared.length; sectionIndex += 1) {
    const entry = prepared[sectionIndex];
    for (let i = 0; i < entry.cuts.length - 1; i += 1) {
      pageNumber += 1;
      const footer = elements.includeMeta.checked
        ? mergedFooterText(sectionIndex, pageNumber, totalPages, entry.section.capture.capturedAt)
        : "";
      const pageCanvas = await renderHighResPagedImagePage(entry.exportState, entry.cuts[i], entry.cuts[i + 1], footer);
      const blob = await canvasToBlob(pageCanvas, type, quality);
      files.push({
        name: `${rootName}-page-${String(pageNumber).padStart(pad, "0")}.${extension}`,
        bytes: new Uint8Array(await blob.arrayBuffer())
      });
      setStatus(`正在生成分页 ${label}：第 ${sectionIndex + 1}/${prepared.length} 节，第 ${pageNumber}/${totalPages} 页...`);
    }
  }

  const zipBytes = buildZip(files);
  downloadBlob(new Blob([zipBytes], { type: "application/zip" }), `${mergeFilename()}-paged-${extension === "png" ? "png" : "jpeg"}.zip`);
  await finishExport(`分页 ${label} ZIP 已交给浏览器下载。`);
}

async function exportMergedPdf() {
  if (!sections.length) {
    setStatus("没有可合并的分节。", true);
    return;
  }
  setBusy(true, "正在生成合并 PDF...");
  saveAllSectionStates();

  const { prepared, totalPages } = prepareSectionExports();

  const pdf = new SimplePdf();
  let pageNumber = 0;
  for (let sectionIndex = 0; sectionIndex < prepared.length; sectionIndex += 1) {
    const entry = prepared[sectionIndex];
    for (let i = 0; i < entry.cuts.length - 1; i += 1) {
      pageNumber += 1;
      const pageCanvas = await renderHighResCanvasSlice(entry.exportState, entry.cuts[i], entry.cuts[i + 1]);
      const footer = elements.includeMeta.checked
        ? mergedFooterText(sectionIndex, pageNumber, totalPages, entry.section.capture.capturedAt)
        : "";
      addCanvasPageToPdf(pdf, pageCanvas, entry.exportState.outputWidth, footer);
      setStatus(`正在合并第 ${sectionIndex + 1}/${prepared.length} 节，PDF 第 ${pageNumber}/${totalPages} 页...`);
    }
  }

  const pdfBytes = pdf.build();
  downloadBlob(new Blob([pdfBytes], { type: "application/pdf" }), `${mergeFilename()}-merged.pdf`);
  await finishExport("合并 PDF 已交给浏览器下载。");
}

function prepareSectionExports() {
  const prepared = [];
  let totalPages = 0;
  for (const section of sections) {
    const exportState = getSectionExportState(section);
    const cuts = getSectionPageCuts(section, exportState);
    totalPages += cuts.length - 1;
    prepared.push({ section, exportState, cuts });
  }
  return { prepared, totalPages };
}

async function finishExport(message) {
  if (elements.autoClearAfterExport.checked) {
    await deleteSelectedCaches({ silent: true });
    setBusy(false, `${message} 已清理本次分节缓存。`);
    return;
  }
  setBusy(false, message);
}

function getSectionExportState(section) {
  const crop = section.state.enableCrop ? section.state.crop : fullPreviewCrop(section);
  const logicalCrop = {
    x: crop.x / section.canvas.width * section.targetWidth,
    y: crop.y / section.canvas.height * section.targetHeight,
    width: crop.width / section.canvas.width * section.targetWidth,
    height: crop.height / section.canvas.height * section.targetHeight
  };
  const outputScale = section.naturalCanvasScale * section.state.exportScale;
  return {
    capture: section.capture,
    captureId: section.id,
    logicalCrop,
    outputScale,
    outputWidth: Math.max(1, Math.round(logicalCrop.width * outputScale)),
    outputHeight: Math.max(1, Math.round(logicalCrop.height * outputScale))
  };
}

function getSectionPageCuts(section, exportState) {
  if (section.state.customPagination && section.state.manualCutFractions.length > 0) {
    return buildManualPageCutsFromFractions(exportState.outputHeight, section.state.manualCutFractions);
  }
  return buildRegularPageCuts(exportState.outputWidth, exportState.outputHeight);
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

async function renderHighResPagedImagePage(exportState, startY, endY, footer = "") {
  const contentHeight = Math.max(1, endY - startY);
  const footerHeight = footer ? getPageLayoutPx(exportState.outputWidth).footerHeight : 0;
  assertCanvasSize(exportState.outputWidth, contentHeight + footerHeight);
  const pageCanvas = document.createElement("canvas");
  pageCanvas.width = exportState.outputWidth;
  pageCanvas.height = contentHeight + footerHeight;
  const context = pageCanvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
  await drawHighResContent(context, exportState, startY, endY, 0);
  if (footerHeight > 0) {
    drawPageFooter(context, exportState.outputWidth, contentHeight, footerHeight, footer);
  }
  return pageCanvas;
}

async function drawHighResContent(context, exportState, startY, endY, offsetY) {
  const sourceCapture = exportState.capture;
  const pageLogicalTop = exportState.logicalCrop.y + startY / exportState.outputScale;
  const pageLogicalBottom = exportState.logicalCrop.y + endY / exportState.outputScale;
  const cropLogicalBottom = exportState.logicalCrop.y + exportState.logicalCrop.height;

  for (let index = 0; index < sourceCapture.slices.length; index += 1) {
    const slice = sourceCapture.slices[index];
    const sliceLogicalHeight = Math.min(slice.cropRect.height, slice.targetVisibleHeight);
    const sliceTop = slice.scrollTop;
    const sliceBottom = sliceTop + sliceLogicalHeight;
    const overlapTop = Math.max(pageLogicalTop, exportState.logicalCrop.y, sliceTop);
    const overlapBottom = Math.min(pageLogicalBottom, cropLogicalBottom, sliceBottom);
    if (overlapBottom <= overlapTop) {
      continue;
    }

    const sliceWithData = await fetchCaptureSlice(exportState.captureId, index);
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

function addCanvasPageToPdf(pdf, pageCanvas, sourceWidth, footer = "") {
  const pageSize = getPageSize();
  const margin = 24;
  const footerHeight = elements.includeMeta.checked ? 20 : 0;
  const imageWidthPt = pageSize.width - margin * 2;
  const imageHeightPt = pageSize.height - margin * 2 - footerHeight;
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
    footer
  });
}

function getPageSize() {
  const selected = paperSizes[elements.paper.value] || paperSizes.a4;
  if (elements.orientation.value === "landscape") {
    return { width: selected.height, height: selected.width };
  }
  return selected;
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

function buildRegularPageCuts(width, height) {
  const pageHeightPx = getPageLayoutPx(width).contentHeight;
  const cuts = [0];
  let cursor = pageHeightPx;
  while (cursor < height) {
    cuts.push(cursor);
    cursor += pageHeightPx;
  }
  cuts.push(height);
  return cuts;
}

function buildManualPageCutsFromFractions(height, fractions) {
  const innerCuts = [...new Set((fractions || [])
    .map(Number)
    .filter(Number.isFinite)
    .map((fraction) => clamp(fraction, 0.001, 0.999)))]
    .sort((a, b) => a - b)
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

async function fetchCaptureMeta(id) {
  const response = await chrome.runtime.sendMessage({ type: "GET_CAPTURE_META", captureId: id });
  if (!response?.ok) {
    throw new Error(response?.error || "Could not load capture.");
  }
  return response.payload;
}

async function fetchCaptureSlice(id, index) {
  const response = await chrome.runtime.sendMessage({ type: "GET_CAPTURE_SLICE", captureId: id, index });
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

function assertCanvasSize(width, height) {
  if (width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE) {
    throw new Error(`页面太长，浏览器画布单边限制约 ${MAX_CANVAS_SIDE}px。当前需要 ${width} x ${height}px，请先缩小选区后再导出。`);
  }
  if (width * height > MAX_CANVAS_PIXELS) {
    throw new Error(`页面太长，拼接画布约 ${Math.round(width * height / 1_000_000)}MP。先降低导出缩放或缩小裁切范围会更稳。`);
  }
}

function sectionMetaText(section) {
  return [
    section.capture.segment?.part ? `第 ${section.capture.segment.part} 节` : "独立截图",
    formatDateTime(section.capture.capturedAt),
    `${section.capture.slices?.length || 0} 张切片`,
    `${Math.round((section.capture.target?.totalHeight || 0) / 100) / 10}k px`
  ].filter(Boolean).join(" · ");
}

function mergeFilename() {
  const title = sections[0]?.capture?.source?.title || "full-page-capture";
  const safeTitle = title
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${safeTitle || "full-page-capture"}-sections-${stamp}`;
}

function zipPageRootName() {
  const title = sections[0]?.capture?.source?.title || "full-page-capture";
  const asciiTitle = title
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${asciiTitle || "sections"}-${stamp}`;
}

function mergedFooterText(sectionIndex, pageNumber, totalPages, capturedAt) {
  return `S${sectionIndex + 1}  ${pageNumber}/${totalPages}  ${formatDateTime(capturedAt)}`;
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

async function refreshCacheUsage() {
  if (!sections.length) {
    elements.cacheUsage.textContent = "暂无可统计的分节缓存。";
    return;
  }

  const keys = sections.map((section) => `capture:${section.id}`);
  const stored = await chrome.storage.local.get(keys);
  const bytes = keys.reduce((sum, key) => {
    if (!stored[key]) {
      return sum;
    }
    return sum + estimateStoredBytes(stored[key]);
  }, 0);
  elements.cacheUsage.textContent = `当前分节缓存约 ${formatBytes(bytes)}。导出完成后可清理，释放浏览器本地空间。`;
}

async function deleteSelectedCaches(options = {}) {
  if (!sections.length) {
    return;
  }
  if (!options.silent) {
    const ok = window.confirm("清理本次合并用到的分节缓存？清理后当前编辑器未刷新前仍可导出，但刷新后不能恢复这些截图。");
    if (!ok) {
      return;
    }
  }

  const ids = sections.map((section) => section.id);
  for (const id of ids) {
    await chrome.runtime.sendMessage({ type: "FORGET_CAPTURE", captureId: id });
    localStorage.removeItem(`${EDITOR_STATE_PREFIX}${id}`);
  }
  await refreshCacheUsage();
  if (!options.silent) {
    setStatus("已清理本次分节缓存。当前页面未刷新前仍可继续导出。");
  }
}

function estimateStoredBytes(value) {
  try {
    return new Blob([JSON.stringify(value)]).size;
  } catch (_error) {
    return JSON.stringify(value || "").length * 2;
  }
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / 1024 / 1024 * 10) / 10} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024 * 10) / 10} KB`;
  }
  return `${bytes} B`;
}

function setBusy(isBusy, message, detail = "") {
  for (const button of [
    elements.exportPagedPng,
    elements.exportPagedJpeg,
    elements.exportPdf,
    elements.fitWidth,
    elements.refreshCacheUsage,
    elements.deleteSelectedCaches,
    elements.moveUp,
    elements.moveDown,
    elements.applyActiveToAll,
    elements.cropFull,
    elements.cropVisible,
    elements.seedPageCuts,
    elements.addPageCut,
    elements.deletePageCut,
    elements.clearPageCuts
  ]) {
    button.disabled = isBusy;
  }
  elements.pageRangeMode.disabled = isBusy;
  elements.exportPagedPng.disabled = isBusy || sections.length === 0;
  elements.exportPagedJpeg.disabled = isBusy || sections.length === 0;
  elements.exportPdf.disabled = isBusy || sections.length === 0;
  elements.fitWidth.disabled = isBusy || sections.length === 0;
  elements.refreshCacheUsage.disabled = isBusy || sections.length === 0;
  elements.deleteSelectedCaches.disabled = isBusy || sections.length === 0;
  if (message) {
    setStatus(message);
  }
  if (isBusy) {
    updateLoadingMessage(message || "正在处理...", detail || "长图处理可能需要一点时间，请稍等。");
  } else {
    hideLoadingOverlay();
  }
  if (!isBusy && sections.length > 0) {
    renderSectionNavigation();
    renderActiveControls();
  }
}

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.style.color = isError ? "#b42318" : "";
  elements.meta.textContent = sections.length
    ? `当前共 ${sections.length} 节，适合第一次未截完后的统一分页与合并；一次截完通常不需要这里。`
    : message;
}

function updateLoadingMessage(title, detail = "") {
  if (!elements.loadingOverlay) {
    return;
  }
  elements.loadingOverlay.hidden = false;
  elements.loadingOverlay.classList.add("is-visible");
  elements.loadingTitle.textContent = title || "正在处理...";
  elements.loadingDetail.textContent = detail || "长图处理可能需要一点时间，请稍等。";
}

function hideLoadingOverlay() {
  if (!elements.loadingOverlay) {
    return;
  }
  elements.loadingOverlay.classList.remove("is-visible");
  elements.loadingOverlay.hidden = true;
}

function reportHandledError(error) {
  if (console.debug) {
    console.debug("Handled XF FullPage Capture merge error:", error);
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
