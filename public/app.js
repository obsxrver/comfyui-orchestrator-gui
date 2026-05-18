const els = {
  workflowDropOverlay: document.querySelector("#workflowDropOverlay"),
  workflowDropTitle: document.querySelector("#workflowDropTitle"),
  workflowDropHint: document.querySelector("#workflowDropHint"),
  workflowFile: document.querySelector("#workflowFile"),
  favoriteWorkflowSelect: document.querySelector("#favoriteWorkflowSelect"),
  renameFavoriteWorkflow: document.querySelector("#renameFavoriteWorkflow"),
  deleteFavoriteWorkflow: document.querySelector("#deleteFavoriteWorkflow"),
  favoriteWorkflow: document.querySelector("#favoriteWorkflow"),
  inputList: document.querySelector("#inputList"),
  inputFilter: document.querySelector("#inputFilter"),
  showHiddenInputs: document.querySelector("#showHiddenInputs"),
  backendList: document.querySelector("#backendList"),
  backendPanelBody: document.querySelector("#backendPanelBody"),
  toggleBackends: document.querySelector("#toggleBackends"),
  addBackend: document.querySelector("#addBackend"),
  saveBackends: document.querySelector("#saveBackends"),
  detectGpus: document.querySelector("#detectGpus"),
  autoBackends: document.querySelector("#autoBackends"),
  gpuSummary: document.querySelector("#gpuSummary"),
  submitJobs: document.querySelector("#submitJobs"),
  refreshJobs: document.querySelector("#refreshJobs"),
  jobList: document.querySelector("#jobList"),
  activeSummary: document.querySelector("#activeSummary"),
  mediaGallery: document.querySelector("#mediaGallery"),
  galleryPageTitle: document.querySelector("#galleryPageTitle"),
  gridView: document.querySelector("#gridView"),
  feedView: document.querySelector("#feedView"),
  autoScrollNew: document.querySelector("#autoScrollNew"),
  downloadVideos: document.querySelector("#downloadVideos"),
  galleryCount: document.querySelector("#galleryCount"),
  galleryPrev: document.querySelector("#galleryPrev"),
  galleryNext: document.querySelector("#galleryNext"),
  galleryPages: document.querySelector("#galleryPages"),
  itemsPerPage: document.querySelector("#itemsPerPage"),
  variantCount: document.querySelector("#variantCount"),
  activeCount: document.querySelector("#activeCount"),
  editorGrid: document.querySelector(".editor-grid"),
  columnResizer: document.querySelector("#columnResizer"),
  toggleInputsPanel: document.querySelector("#toggleInputsPanel"),
  toggleGalleryPanel: document.querySelector("#toggleGalleryPanel"),
  hideInputsPanel: document.querySelector("#hideInputsPanel"),
  hideGalleryPanel: document.querySelector("#hideGalleryPanel"),
  backendTemplate: document.querySelector("#backendTemplate"),
  inputTemplate: document.querySelector("#inputTemplate"),
};

const defaultMediaLimit = Number(localStorage.getItem("galleryItemsPerPage")) || 10;
const workflowFavoritesKey = "favoriteWorkflows";
const backendPanelCollapsedKey = "backendPanelCollapsed";

const state = {
  workflow: null,
  workflowSourceName: "",
  activeWorkflowFavoriteId: "",
  favoriteWorkflows: readFavoriteWorkflows(),
  inputs: [],
  selectedInputs: new Map(),
  hiddenInputIds: new Set(),
  backends: [],
  statuses: new Map(),
  jobs: [],
  gpuDetection: null,
  clientId: "",
  eventSource: null,
  activePromptByBackend: new Map(),
  liveByPromptId: new Map(),
  jobCards: new Map(),
  cancelingJobKeys: new Set(),
  mediaItems: [],
  failedVideoSources: new Set(),
  renderedGallerySignature: "",
  mediaPage: {
    limit: [10, 20, 30, 48].includes(defaultMediaLimit) ? defaultMediaLimit : 10,
    page: 1,
    total: 0,
    totalPages: 1,
    hasNext: false,
    hasPrevious: false,
    loading: false,
  },
  galleryView: "grid",
  galleryItems: [],
  activeMediaIndex: 0,
  mediaNodes: new Map(),
  mediaObserver: null,
  mediaHydrationObserver: null,
  autoScrollNew: localStorage.getItem("autoScrollNewMedia") !== "false",
  feedLooping: false,
  layout: {
    inputsVisible: localStorage.getItem("inputsPanelVisible") !== "false",
    galleryVisible: localStorage.getItem("galleryPanelVisible") !== "false",
    backendsCollapsed: localStorage.getItem(backendPanelCollapsedKey) === "true",
  },
  workflowDropDepth: 0,
};

if (!state.layout.inputsVisible && !state.layout.galleryVisible) {
  state.layout.galleryVisible = true;
}

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  }).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  });
}

function readFavoriteWorkflows() {
  try {
    const parsed = JSON.parse(localStorage.getItem(workflowFavoritesKey) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === "object" && isComfyApiWorkflow(item.workflow))
      .map((item) => ({
        id: item.id || favoriteIdForWorkflow(item.workflow),
        name: String(item.name || "Untitled workflow").trim() || "Untitled workflow",
        workflow: item.workflow,
        createdAt: item.createdAt || new Date().toISOString(),
        updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
      }))
      .sort(compareFavoritesByName);
  } catch {
    return [];
  }
}

function writeFavoriteWorkflows() {
  localStorage.setItem(workflowFavoritesKey, JSON.stringify(state.favoriteWorkflows));
}

function compareFavoritesByName(left, right) {
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true });
}

function normalizeFavoriteName(name) {
  return String(name || "").trim() || "Untitled workflow";
}

function favoriteNameExists(name, excludeId = "") {
  const normalized = name.toLocaleLowerCase();
  return state.favoriteWorkflows.some(
    (favorite) => favorite.id !== excludeId && favorite.name.toLocaleLowerCase() === normalized
  );
}

function uniqueFavoriteName(name, excludeId = "") {
  const baseName = normalizeFavoriteName(name);
  if (!favoriteNameExists(baseName, excludeId)) return baseName;
  let copyIndex = 2;
  let candidate = `${baseName} (${copyIndex})`;
  while (favoriteNameExists(candidate, excludeId)) {
    copyIndex += 1;
    candidate = `${baseName} (${copyIndex})`;
  }
  return candidate;
}

function renderFavoriteWorkflows() {
  if (!els.favoriteWorkflowSelect) return;
  const currentValue = els.favoriteWorkflowSelect.value;
  els.favoriteWorkflowSelect.innerHTML = `<option value="">Saved workflows</option>`;
  for (const favorite of state.favoriteWorkflows) {
    const option = document.createElement("option");
    option.value = favorite.id;
    option.textContent = favorite.name;
    els.favoriteWorkflowSelect.append(option);
  }
  els.favoriteWorkflowSelect.disabled = state.favoriteWorkflows.length === 0;
  els.favoriteWorkflowSelect.value = state.favoriteWorkflows.some((favorite) => favorite.id === currentValue)
    ? currentValue
    : "";
  updateFavoriteControls();
}

function updateFavoriteControls() {
  state.activeWorkflowFavoriteId = state.workflow ? favoriteIdForWorkflow(state.workflow) : "";
  const isFavorite = state.favoriteWorkflows.some((favorite) => favorite.id === state.activeWorkflowFavoriteId);
  const selectedFavoriteId = els.favoriteWorkflowSelect?.value || "";
  const hasSelectedFavorite = state.favoriteWorkflows.some((favorite) => favorite.id === selectedFavoriteId);
  if (els.favoriteWorkflow) {
    els.favoriteWorkflow.disabled = !state.workflow;
    els.favoriteWorkflow.classList.toggle("is-favorite", isFavorite);
    els.favoriteWorkflow.textContent = isFavorite ? "\u2605" : "\u2606";
    els.favoriteWorkflow.title = isFavorite ? "Rename this favorite workflow" : "Add current workflow to favorites";
    els.favoriteWorkflow.setAttribute("aria-label", els.favoriteWorkflow.title);
  }
  if (els.renameFavoriteWorkflow) {
    els.renameFavoriteWorkflow.disabled = !hasSelectedFavorite;
  }
  if (els.deleteFavoriteWorkflow) {
    els.deleteFavoriteWorkflow.disabled = !hasSelectedFavorite;
  }
}

function favoriteIdForWorkflow(workflow) {
  const serialized = stableStringify(workflow);
  return `workflow-${hashString(serialized)}-${serialized.length.toString(36)}`;
}

function stableStringify(value) {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function defaultFavoriteWorkflowName() {
  const sourceName = state.workflowSourceName || "";
  const sourceBase = sourceName.replace(/\.[a-z0-9]+$/i, "").trim();
  if (sourceBase && !/^workflow[-_ ]?\d*$/i.test(sourceBase)) return sourceBase;
  return `Workflow ${new Date().toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
}

function saveCurrentWorkflowFavorite() {
  if (!state.workflow) return;
  const id = favoriteIdForWorkflow(state.workflow);
  const existing = state.favoriteWorkflows.find((favorite) => favorite.id === id);
  const name = window.prompt(
    existing ? "Favorite workflow name" : "Save workflow as",
    existing?.name || defaultFavoriteWorkflowName()
  );
  if (name === null) return;

  const trimmedName = name.trim();
  if (!trimmedName) return;
  const finalName = uniqueFavoriteName(trimmedName, existing?.id || "");

  const now = new Date().toISOString();
  const favorite = {
    id,
    name: finalName,
    workflow: structuredClone(state.workflow),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  state.favoriteWorkflows = [
    ...state.favoriteWorkflows.filter((item) => item.id !== id),
    favorite,
  ].sort(compareFavoritesByName);

  try {
    writeFavoriteWorkflows();
    renderFavoriteWorkflows();
    updateFavoriteControls();
  } catch (error) {
    alert(`Workflow could not be saved: ${error.message}`);
  }
}

function loadFavoriteWorkflow(favoriteId) {
  const favorite = state.favoriteWorkflows.find((item) => item.id === favoriteId);
  if (!favorite) return;
  loadWorkflow(structuredClone(favorite.workflow), favorite.name);
  setPanelVisibility("inputs", true);
  els.favoriteWorkflowSelect.value = favorite.id;
  updateFavoriteControls();
}

function renameSelectedFavoriteWorkflow() {
  const favoriteId = els.favoriteWorkflowSelect?.value || "";
  const favorite = state.favoriteWorkflows.find((item) => item.id === favoriteId);
  if (!favorite) return;
  const name = window.prompt("Saved workflow name", favorite.name);
  if (name === null) return;

  const trimmedName = name.trim();
  if (!trimmedName) return;
  favorite.name = uniqueFavoriteName(trimmedName, favorite.id);
  favorite.updatedAt = new Date().toISOString();
  state.favoriteWorkflows = [...state.favoriteWorkflows].sort(compareFavoritesByName);

  try {
    writeFavoriteWorkflows();
    renderFavoriteWorkflows();
    els.favoriteWorkflowSelect.value = favorite.id;
    if (state.activeWorkflowFavoriteId === favorite.id) state.workflowSourceName = favorite.name;
    updateFavoriteControls();
  } catch (error) {
    alert(`Workflow could not be renamed: ${error.message}`);
  }
}

function deleteSelectedFavoriteWorkflow() {
  const favoriteId = els.favoriteWorkflowSelect?.value || "";
  const favorite = state.favoriteWorkflows.find((item) => item.id === favoriteId);
  if (!favorite) return;
  if (!window.confirm(`Delete "${favorite.name}" from saved workflows?`)) return;

  state.favoriteWorkflows = state.favoriteWorkflows.filter((item) => item.id !== favorite.id);
  try {
    writeFavoriteWorkflows();
    els.favoriteWorkflowSelect.value = "";
    renderFavoriteWorkflows();
    updateFavoriteControls();
  } catch (error) {
    alert(`Workflow could not be deleted: ${error.message}`);
  }
}

function isLinkValue(value) {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string";
}

function extractInputs(workflow) {
  return Object.entries(workflow).flatMap(([nodeId, node]) => {
    if (!node || typeof node !== "object" || !node.inputs) return [];
    const classType = node.class_type || "";
    const nodeTitle = node._meta?.title || classType || `Node ${nodeId}`;

    if (classType === "CLIPTextEncode" && typeof node.inputs.text === "string") {
      return [makeInput({ nodeId, nodeTitle, classType, inputName: "text", kind: "text", value: node.inputs.text })];
    }

    if (classType === "LoadImage" && typeof node.inputs.image === "string") {
      return [makeInput({ nodeId, nodeTitle, classType, inputName: "image", kind: "image", value: node.inputs.image })];
    }

    if (isPrimitiveNode(classType, nodeTitle) || isDetectedConstantNode(classType)) {
      return Object.entries(node.inputs)
        .filter(([, value]) => !isLinkValue(value))
        .map(([inputName, value]) =>
          makeInput({ nodeId, nodeTitle, classType, inputName, kind: "primitive", value })
        );
    }

    return [];
  });
}

function isPrimitiveNode(classType, nodeTitle) {
  const lowerClass = classType.toLowerCase();
  const lowerTitle = nodeTitle.toLowerCase();
  return lowerClass.includes("primitive") || lowerTitle.includes("primitive");
}

function isDetectedConstantNode(classType) {
  return classType === "FloatConstant";
}

function makeInput({ nodeId, nodeTitle, classType, inputName, kind, value }) {
  const primitive = primitiveDescriptor(classType, value);
  return {
    id: `${nodeId}:${inputName}`,
    nodeId,
    nodeTitle,
    classType,
    inputName,
    kind,
    value,
    valueType: kind === "primitive" ? primitive.valueType : valueType(value),
    controlType: kind === "primitive" ? primitive.controlType : kind === "text" ? "multiline" : "image",
    step: primitive.step,
    preview: previewValue(value),
  };
}

function primitiveDescriptor(classType, value) {
  const lower = classType.toLowerCase();
  if (classType === "FloatConstant") {
    return { valueType: "float", controlType: "float", step: "0.01" };
  }
  if (lower.includes("stringmultiline") || lower.includes("multiline")) {
    return { valueType: "string", controlType: "multiline" };
  }
  if (lower.includes("boolean") || lower.includes("bool")) {
    return { valueType: "boolean", controlType: "boolean" };
  }
  if (lower.includes("int")) {
    return { valueType: "int", controlType: "int" };
  }
  if (lower.includes("float") || lower.includes("double")) {
    return { valueType: "float", controlType: "float" };
  }
  if (lower.includes("string")) {
    return { valueType: "string", controlType: "string" };
  }
  if (typeof value === "boolean") return { valueType: "boolean", controlType: "boolean" };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { valueType: "int", controlType: "int" }
      : { valueType: "float", controlType: "float" };
  }
  return { valueType: valueType(value), controlType: "string" };
}

function valueType(value) {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  return "json";
}

function previewValue(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function renderBackends() {
  els.backendList.innerHTML = "";
  if (!state.backends.length) {
    state.backends.push({
      id: `backend-${Date.now()}`,
      name: "GPU 1",
      url: "http://localhost:8189",
    });
  }

  for (const backend of state.backends) {
    const node = els.backendTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = backend.id;
    node.querySelector(".backend-name").value = backend.name || "";
    node.querySelector(".backend-url").value = backend.url || "";
    const status = state.statuses.get(backend.id);
    const statusNode = node.querySelector(".backend-status");
    if (status) {
      statusNode.textContent = status.ok ? summarizeBackend(status) : status.error;
      statusNode.classList.toggle("error-text", !status.ok);
    }
    node.querySelector(".remove-backend").addEventListener("click", () => {
      state.backends = state.backends.filter((item) => item.id !== backend.id);
      renderBackends();
      updateSubmitState();
    });
    els.backendList.append(node);
  }
}

function renderBackendPanelState() {
  const collapsed = state.layout.backendsCollapsed;
  if (els.backendPanelBody) els.backendPanelBody.hidden = collapsed;
  if (els.toggleBackends) {
    els.toggleBackends.textContent = collapsed ? "Show" : "Hide";
    els.toggleBackends.setAttribute("aria-expanded", String(!collapsed));
    els.toggleBackends.title = collapsed ? "Show backends" : "Hide backends";
  }
}

function setBackendPanelCollapsed(collapsed) {
  state.layout.backendsCollapsed = collapsed;
  localStorage.setItem(backendPanelCollapsedKey, String(collapsed));
  renderBackendPanelState();
}

function summarizeBackend(status) {
  const queue = status.queue || {};
  const running = queue.queue_running?.length || 0;
  const pending = queue.queue_pending?.length || 0;
  const device = status.systemStats?.devices?.[0];
  const gpuName = device?.name ? ` | ${device.name}` : "";
  return `Online | ${running} running | ${pending} pending${gpuName}`;
}

function renderGpuSummary() {
  const detection = state.gpuDetection;
  if (!detection) {
    els.gpuSummary.textContent = "CUDA devices not detected yet.";
    return;
  }
  const count = detection.devices?.length || 0;
  if (count) {
    els.gpuSummary.textContent = `${count} CUDA device${count === 1 ? "" : "s"} detected.`;
    return;
  }
  els.gpuSummary.textContent = detection.error ? `No CUDA devices found: ${detection.error}` : "No CUDA devices found.";
}

function collectBackendsFromDom() {
  state.backends = [...els.backendList.querySelectorAll(".backend-row")].map((row, index) => ({
    id: row.dataset.id || `backend-${Date.now()}-${index}`,
    name: row.querySelector(".backend-name").value.trim() || `GPU ${index + 1}`,
    url: row.querySelector(".backend-url").value.trim().replace(/\/+$/, ""),
  }));
}

function nextLocalBackendUrl(backends) {
  const localhostPorts = backends
    .map((backend) => {
      try {
        const url = new URL(backend.url);
        const isLocalhost = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
        return isLocalhost ? Number(url.port) : 0;
      } catch {
        return 0;
      }
    })
    .filter((port) => Number.isInteger(port) && port > 0);

  if (localhostPorts.length) {
    return `http://localhost:${Math.max(...localhostPorts) + 1}`;
  }

  return `http://localhost:${8189 + backends.length}`;
}

function renderInputs() {
  const filter = els.inputFilter.value.trim().toLowerCase();
  const visibleInputs = state.inputs.filter((input) => !state.hiddenInputIds.has(input.id));
  const inputs = visibleInputs
    .filter((input) => {
      const haystack = `${input.nodeTitle} ${input.classType} ${input.inputName} ${input.preview}`.toLowerCase();
      return haystack.includes(filter);
    })
    .sort(compareInputsByTitle);
  els.showHiddenInputs.hidden = state.hiddenInputIds.size === 0;
  els.showHiddenInputs.textContent = state.hiddenInputIds.size
    ? `Unhide all (${state.hiddenInputIds.size})`
    : "Unhide all";

  els.inputList.innerHTML = "";
  els.inputList.classList.toggle("empty-state", !inputs.length);
  if (!state.workflow) {
    els.inputList.textContent = "Upload a ComfyUI API workflow JSON, or a photo/video with embedded API prompt metadata.";
    return;
  }
  if (!inputs.length) {
    els.inputList.textContent = visibleInputs.length
      ? "No CLIPTextEncode, LoadImage, primitive, or constant inputs matched."
      : "All workflow inputs are hidden.";
    return;
  }

  for (const input of inputs) {
    const node = els.inputTemplate.content.firstElementChild.cloneNode(true);
    const valuesInput = node.querySelector(".values-input");
    const scalarList = node.querySelector(".scalar-list");
    const addScalar = node.querySelector(".add-scalar");
    const imagePicker = node.querySelector(".image-picker");
    const imageInput = node.querySelector(".image-input");
    const previewList = node.querySelector(".image-preview-list");
    const randomizeOption = node.querySelector(".randomize-option");
    const randomizeInt = node.querySelector(".randomize-int");
    const hideInput = node.querySelector(".hide-input");
    const selected = state.selectedInputs.get(input.id);

    node.querySelector(".input-title").textContent = input.nodeTitle;
    node.querySelector(".input-meta").textContent = `${input.classType} #${input.nodeId} | ${input.inputName} | current: ${trim(input.preview, 130)}`;

    const canRandomize = isPrimitiveIntInput(input);
    randomizeOption.hidden = true;
    imagePicker.hidden = true;
    imageInput.disabled = true;

    if (input.kind === "image") {
      valuesInput.hidden = true;
      scalarList.hidden = true;
      addScalar.hidden = true;
      imagePicker.hidden = false;
      imageInput.disabled = false;
      renderFilePreview(previewList, selected?.values || []);
      bindImageDrop(imagePicker, input, previewList);
    } else if (input.controlType === "multiline") {
      imagePicker.hidden = true;
      scalarList.hidden = true;
      addScalar.hidden = true;
      valuesInput.hidden = false;
      valuesInput.disabled = false;
      valuesInput.placeholder = input.kind === "text"
        ? "One prompt per line, or separate multi-line prompts with ---"
        : "Separate multiline primitive variants with ---";
      valuesInput.value = selected?.rawValue || input.preview;
    } else {
      valuesInput.hidden = true;
      randomizeOption.hidden = !canRandomize;
      randomizeInt.checked = Boolean(selected?.randomizeBeforeGeneration);
      randomizeInt.disabled = !canRandomize;
      scalarList.hidden = false;
      addScalar.hidden = false;
      addScalar.disabled = false;
      renderScalarList(scalarList, input, selected?.values || [input.value], false);
    }

    const updateSelection = () => {
      syncSelectionFromControls(input, valuesInput, imageInput, scalarList, randomizeInt);
      updateVariantCount();
      updateSubmitState();
    };

    valuesInput.addEventListener("input", () => {
      updateSelection();
    });

    imageInput.addEventListener("change", () => {
      renderFilePreview(previewList, [...imageInput.files]);
      updateSelection();
    });

    scalarList.addEventListener("input", () => {
      updateSelection();
    });

    scalarList.addEventListener("change", () => {
      updateSelection();
    });

    randomizeInt.addEventListener("change", () => {
      updateSelection();
    });

    scalarList.addEventListener("click", (event) => {
      const removeButton = event.target.closest(".remove-scalar");
      if (!removeButton) return;
      removeButton.closest(".scalar-row").remove();
      if (!scalarList.querySelector(".scalar-row")) addScalarRow(scalarList, input, input.value, false);
      updateSelection();
    });

    addScalar.addEventListener("click", () => {
      addScalarRow(scalarList, input, defaultScalarValue(input), false);
      updateSelection();
    });

    hideInput.addEventListener("click", () => {
      state.hiddenInputIds.add(input.id);
      renderInputs();
      updateVariantCount();
      updateSubmitState();
    });

    els.inputList.append(node);
  }
}

function compareInputsByTitle(left, right) {
  const titleOrder = left.nodeTitle.localeCompare(right.nodeTitle, undefined, { sensitivity: "base", numeric: true });
  if (titleOrder) return titleOrder;
  const inputOrder = left.inputName.localeCompare(right.inputName, undefined, { sensitivity: "base", numeric: true });
  if (inputOrder) return inputOrder;
  return String(left.nodeId).localeCompare(String(right.nodeId), undefined, { numeric: true });
}

function isPrimitiveIntInput(input) {
  return input.kind === "primitive" && input.classType.toLowerCase() === "primitiveint";
}

function syncSelectionFromControls(input, valuesInput, imageInput, scalarList, randomizeInt) {
  const selection = selectionFromControls(input, valuesInput, imageInput, scalarList, randomizeInt);
  if (selectionHasChanges(input, selection)) {
    state.selectedInputs.set(input.id, selection);
  } else {
    state.selectedInputs.delete(input.id);
  }
}

function selectionHasChanges(input, selection) {
  const values = selection.values.filter(hasUiVariantValue);
  if (selection.kind === "image") return values.length > 0;
  if (selection.randomizeBeforeGeneration) return true;
  if (!values.length) return false;
  if (values.length !== 1) return true;
  return !uiValuesEqual(values[0], input.value);
}

function uiValuesEqual(left, right) {
  if (typeof right === "boolean") return Boolean(left) === right;
  if (typeof right === "number") return Number(left) === right;
  return String(left) === String(right ?? "");
}

function selectionFromControls(input, valuesInput, imageInput, scalarList, randomizeInt) {
  if (input.kind === "image") {
    return {
      nodeId: input.nodeId,
      nodeTitle: input.nodeTitle,
      inputName: input.inputName,
      valueType: "string",
      kind: "image",
      values: [...imageInput.files],
    };
  }

  if (input.controlType !== "multiline") {
    const randomizeBeforeGeneration = isPrimitiveIntInput(input) && Boolean(randomizeInt?.checked);
    const values = readScalarValues(scalarList, input);
    return {
      nodeId: input.nodeId,
      nodeTitle: input.nodeTitle,
      inputName: input.inputName,
      valueType: input.valueType,
      kind: input.kind,
      randomizeBeforeGeneration,
      values: randomizeBeforeGeneration && !values.length ? [0] : values,
    };
  }

  return {
    nodeId: input.nodeId,
    nodeTitle: input.nodeTitle,
    inputName: input.inputName,
    valueType: input.valueType,
    kind: input.kind,
    rawValue: valuesInput.value,
    values: parseTextVariants(valuesInput.value),
  };
}

function renderScalarList(container, input, values, disabled) {
  container.innerHTML = "";
  const safeValues = values.length ? values : [defaultScalarValue(input)];
  for (const value of safeValues) addScalarRow(container, input, value, disabled);
}

function addScalarRow(container, input, value, disabled) {
  const row = document.createElement("div");
  row.className = "scalar-row";

  const control = document.createElement("input");
  control.className = "scalar-value";
  control.disabled = disabled;
  control.dataset.valueType = input.valueType;

  if (input.controlType === "boolean") {
    control.type = "checkbox";
    control.checked = value === true || value === "true";
  } else if (input.controlType === "int" || input.controlType === "float") {
    control.type = "number";
    control.step = input.step || (input.controlType === "int" ? "1" : "any");
    control.value = value ?? "";
  } else {
    control.type = "text";
    control.value = value ?? "";
  }

  const remove = document.createElement("button");
  remove.className = "remove-scalar icon-button";
  remove.type = "button";
  remove.title = "Remove value";
  remove.textContent = "x";
  remove.disabled = disabled;

  row.append(control, remove);
  container.append(row);
}

function readScalarValues(container, input) {
  return [...container.querySelectorAll(".scalar-value")]
    .map((control) => {
      if (input.controlType === "boolean") return control.checked;
      if (input.controlType === "int") return control.value === "" ? "" : Number.parseInt(control.value, 10);
      if (input.controlType === "float") return control.value === "" ? "" : Number(control.value);
      return control.value.trim();
    })
    .filter((value) => value !== "" && !(typeof value === "number" && Number.isNaN(value)));
}

function defaultScalarValue(input) {
  if (input.controlType === "boolean") return false;
  if (input.controlType === "int" || input.controlType === "float") return 0;
  return "";
}

function parseTextVariants(value) {
  const text = value.trim();
  if (!text) return [];
  if (/^---$/m.test(text)) {
    return text.split(/^---$/m).map((item) => item.trim()).filter(Boolean);
  }
  return [text];
}

function renderFilePreview(previewList, files) {
  previewList.innerHTML = "";
  previewList.hidden = !files.length;
  for (const file of files) {
    const item = document.createElement("figure");
    item.className = "image-preview";
    const image = document.createElement("img");
    image.alt = file.name;
    image.src = URL.createObjectURL(file);
    image.onload = () => URL.revokeObjectURL(image.src);
    const caption = document.createElement("figcaption");
    caption.textContent = file.name;
    item.append(image, caption);
    previewList.append(item);
  }
}

function bindImageDrop(dropZone, input, previewList) {
  if (dropZone.dataset.boundDrop === "true") return;
  dropZone.dataset.boundDrop = "true";

  for (const eventName of ["dragenter", "dragover"]) {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      dropZone.classList.add("drag-over");
    });
  }

  dropZone.addEventListener("dragleave", (event) => {
    event.stopPropagation();
    dropZone.classList.remove("drag-over");
  });

  dropZone.addEventListener("drop", (event) => {
    dropZone.classList.remove("drag-over");
  });

  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files || []);
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (!imageFiles.length) {
      event.stopPropagation();
      const [file] = files;
      if (file) {
        setWorkflowDropOverlay(true, true);
        loadWorkflowFile(file, { errorPrefix: "Dropped workflow could not be loaded" });
      }
      return;
    }
    event.stopPropagation();
    state.selectedInputs.set(input.id, {
      nodeId: input.nodeId,
      nodeTitle: input.nodeTitle,
      inputName: input.inputName,
      valueType: "string",
      kind: "image",
      values: imageFiles,
    });
    renderFilePreview(previewList, imageFiles);
    updateVariantCount();
    updateSubmitState();
  });
}

function updateVariantCount() {
  const selections = [...state.selectedInputs.values()];
  const total = selections.reduce((product, selection) => {
    const count = selection.values.filter(hasUiVariantValue).length;
    return product * count;
  }, selections.length ? 1 : 0);
  els.variantCount.textContent = state.workflow ? String(selections.length ? total : 1) : "0";
}

function hasUiVariantValue(value) {
  if (value instanceof File) return true;
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (value && typeof value === "object") return Boolean(value.dataUrl || value.name || value.value);
  return String(value).length > 0;
}

function updateSubmitState() {
  const hasBackend = state.backends.some((backend) => backend.url);
  els.submitJobs.disabled = !state.workflow || !hasBackend;
}

function trim(value, limit) {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function selectedBackendIds() {
  collectBackendsFromDom();
  return state.backends.filter((backend) => backend.url).map((backend) => backend.id);
}

async function loadBackends() {
  const data = await api("/api/backends");
  state.backends = data.backends || [];
  renderBackends();
  connectBackendSockets();
  updateSubmitState();
  refreshStatuses();
}

async function saveBackends() {
  collectBackendsFromDom();
  const data = await api("/api/backends", {
    method: "POST",
    body: JSON.stringify({ backends: state.backends }),
  });
  state.backends = data.backends;
  renderBackends();
  connectBackendSockets();
  updateSubmitState();
  refreshStatuses();
}

async function detectGpus() {
  els.detectGpus.disabled = true;
  try {
    state.gpuDetection = await api("/api/gpus");
    renderGpuSummary();
  } catch (error) {
    state.gpuDetection = { ok: false, devices: [], error: error.message };
    renderGpuSummary();
  } finally {
    els.detectGpus.disabled = false;
  }
}

async function autoCreateBackends() {
  els.autoBackends.disabled = true;
  try {
    const data = await api("/api/backends/autolocal", {
      method: "POST",
      body: JSON.stringify({ startPort: 8189 }),
    });
    state.backends = data.backends || [];
    state.gpuDetection = data.gpus;
    renderGpuSummary();
    renderBackends();
    connectBackendSockets();
    updateSubmitState();
    refreshStatuses();
  } catch (error) {
    alert(error.message);
  } finally {
    els.autoBackends.disabled = false;
  }
}

async function refreshStatuses() {
  try {
    collectBackendsFromDom();
    await api("/api/backends", { method: "POST", body: JSON.stringify({ backends: state.backends }) });
    const data = await api("/api/backends/status");
    state.statuses = new Map((data.statuses || []).map((status) => [status.backendId, status]));
    renderBackends();
    connectBackendSockets();
  } catch (error) {
    console.warn(error);
  }
}

async function loadClientId() {
  const data = await api("/api/client");
  state.clientId = data.clientId;
  connectBackendSockets();
}

function connectBackendSockets() {
  if (state.eventSource) return;
  const events = new EventSource("/api/events");
  events.addEventListener("hello", (event) => {
    const data = JSON.parse(event.data);
    state.clientId = data.clientId || state.clientId;
  });
  events.addEventListener("comfy-message", (event) => {
    const data = JSON.parse(event.data);
    const backend = state.backends.find((item) => item.id === data.backendId) || { id: data.backendId };
    handleComfySocketMessage(backend, data.message);
  });
  events.onerror = () => {
    events.close();
    state.eventSource = null;
    setTimeout(connectBackendSockets, 3000);
  };
  state.eventSource = events;
}

function handleComfySocketMessage(backend, message) {
  const data = message.data || {};
  if (message.type === "executing") {
    const promptId = data.prompt_id;
    if (!promptId) return;
    if (data.node === null) {
      updateLive(promptId, { status: "finishing", currentNode: "Fetching outputs", progress: { value: 1, max: 1 } });
      loadJobs();
      return;
    }
    state.activePromptByBackend.set(backend.id, promptId);
    updateLive(promptId, {
      status: "running",
      backendId: backend.id,
      currentNodeId: data.node,
      currentNode: labelNode(promptId, data.node),
    });
  }

  if (message.type === "progress") {
    const promptId = data.prompt_id || state.activePromptByBackend.get(backend.id);
    if (!promptId) return;
    const value = Number(data.value || 0);
    const max = Number(data.max || 0);
    updateLive(promptId, {
      status: "running",
      backendId: backend.id,
      currentNodeId: data.node || state.liveByPromptId.get(promptId)?.currentNodeId,
      currentNode: data.node ? labelNode(promptId, data.node) : state.liveByPromptId.get(promptId)?.currentNode,
      progress: max > 0 ? { value, max } : null,
    });
  }

  if (message.type === "execution_error") {
    const promptId = data.prompt_id || state.activePromptByBackend.get(backend.id);
    if (promptId) updateLive(promptId, { status: "failed", error: data.exception_message || "Execution failed" });
  }
}

function updateLive(promptId, patch) {
  const previous = state.liveByPromptId.get(promptId) || {};
  state.liveByPromptId.set(promptId, { ...previous, ...patch });
  const job = state.jobs.find((item) => item.promptId === promptId);
  if (job) Object.assign(job, state.liveByPromptId.get(promptId));
  renderJobs();
}

function labelNode(promptId, nodeId) {
  const job = state.jobs.find((item) => item.promptId === promptId);
  return job?.nodeLabels?.[nodeId] || `Node ${nodeId}`;
}

async function serializeSelections() {
  const selections = [];
  for (const selection of state.selectedInputs.values()) {
    if (selection.kind !== "image") {
      selections.push(selection);
      continue;
    }
    const values = await Promise.all(selection.values.map(readFilePayload));
    selections.push({ ...selection, values });
  }
  return selections;
}

async function syncBackendsForSubmit() {
  collectBackendsFromDom();
  const data = await api("/api/backends", {
    method: "POST",
    body: JSON.stringify({ backends: state.backends }),
  });
  state.backends = data.backends || [];
  renderBackends();
  connectBackendSockets();
  return state.backends.filter((backend) => backend.url).map((backend) => backend.id);
}

function readFilePayload(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, type: file.type, dataUrl: reader.result });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function submitJobs() {
  els.submitJobs.disabled = true;
  els.submitJobs.textContent = "Queueing...";
  try {
    const data = await api("/api/submit", {
      method: "POST",
      body: JSON.stringify({
        workflow: state.workflow,
        selections: await serializeSelections(),
        backendIds: await syncBackendsForSubmit(),
      }),
    });
    state.jobs = [...data.jobs, ...state.jobs];
    renderJobs();
    setTimeout(loadJobs, 900);
  } catch (error) {
    alert(error.message);
  } finally {
    els.submitJobs.textContent = "Queue variants";
    updateSubmitState();
  }
}

async function loadJobs() {
  try {
    const [jobsData] = await Promise.all([
      api("/api/jobs"),
      loadMediaPage(),
    ]);
    state.jobs = (jobsData.jobs || state.jobs).map(mergeLiveJob);
    renderJobs();
  } catch (error) {
    console.warn(error);
  }
}

async function loadMediaPage({ page = state.mediaPage.page, preserveActive = true } = {}) {
  if (state.mediaPage.loading) return;
  state.mediaPage.loading = true;
  const previousIndex = state.activeMediaIndex;
  const activeItemId = preserveActive
    ? state.galleryItems[state.activeMediaIndex]?.id || state.mediaItems[state.activeMediaIndex]?.id
    : "";
  renderGalleryFooter();

  try {
    const params = new URLSearchParams({
      limit: String(state.mediaPage.limit),
      page: String(Math.max(1, page)),
    });
    const data = await api(`/api/media?${params.toString()}`);
    const totalPages = Math.max(1, Number(data.totalPages || 1));
    state.mediaPage = {
      ...state.mediaPage,
      page: Math.min(Math.max(1, Number(data.page || page)), totalPages),
      total: Number(data.total || 0),
      totalPages,
      hasNext: Boolean(data.hasNext),
      hasPrevious: Boolean(data.hasPrevious),
      loading: false,
    };
    state.mediaItems = data.items || [];
    const activeIndex = activeItemId
      ? state.mediaItems.findIndex((item) => item.id === activeItemId)
      : -1;
    state.activeMediaIndex = preserveActive
      ? Math.max(0, activeIndex >= 0 ? activeIndex : Math.min(previousIndex, state.mediaItems.length - 1))
      : 0;
  } catch (error) {
    state.mediaPage.loading = false;
    throw error;
  } finally {
    renderGalleryFooter();
  }
}

function mergeLiveJob(job) {
  if (job.status === "canceled" || (job.status === "done" && job.outputs?.length)) {
    state.liveByPromptId.delete(job.promptId);
    return job;
  }
  const live = state.liveByPromptId.get(job.promptId);
  return live ? { ...job, ...live } : job;
}

function renderJobs() {
  const jobs = state.jobs.filter((job) => !["done", "failed", "canceled"].includes(job.status));
  els.activeCount.textContent = String(jobs.length);
  renderMediaGallery();
  els.activeSummary.textContent = jobs.length
    ? `${jobs.length} active ${jobs.length === 1 ? "job" : "jobs"}`
    : "No active jobs";
  const wantedKeys = new Set(jobs.map(jobKey));
  for (const [key, card] of state.jobCards) {
    if (!wantedKeys.has(key)) {
      card.remove();
      state.jobCards.delete(key);
    }
  }

  els.jobList.classList.toggle("empty-state", !jobs.length);
  if (!jobs.length) {
    state.jobCards.clear();
    els.jobList.textContent = "Nothing is rendering right now.";
    return;
  }

  if (els.jobList.classList.contains("empty-state")) els.jobList.classList.remove("empty-state");
  if (els.jobList.childNodes.length === 1 && els.jobList.firstChild.nodeType === Node.TEXT_NODE) {
    els.jobList.textContent = "";
  }

  let anchor = els.jobList.firstElementChild;
  for (const job of jobs) {
    const key = jobKey(job);
    let card = state.jobCards.get(key);
    if (!card) {
      card = createJobCard();
      state.jobCards.set(key, card);
      els.jobList.insertBefore(card, anchor);
    }
    updateJobCard(card, job);
    if (card === anchor) anchor = anchor.nextElementSibling;
  }
}

function jobKey(job) {
  return job.promptId || job.id;
}

function createJobCard() {
  const card = document.createElement("article");
  card.className = "job-card active-job-card";
  card.innerHTML = `
    <div data-slot="header"></div>
    <div data-slot="progress"></div>
    <div data-slot="error"></div>
  `;
  card.addEventListener("click", (event) => {
    const button = event.target.closest(".cancel-job");
    if (!button) return;
    const job = state.jobs.find((item) => jobKey(item) === button.dataset.jobKey);
    if (job) cancelJob(job);
  });
  return card;
}

function updateJobCard(card, job) {
  const statusClass = job.status === "failed" ? " failed" : "";
  const key = jobKey(job);
  const isCanceling = state.cancelingJobKeys.has(key);
  card.querySelector('[data-slot="header"]').innerHTML = `
    <div class="job-header">
      <div>
        <strong>${escapeHtml(job.backendName || "Backend")}</strong>
        <div class="assignment">${escapeHtml(job.promptId || job.id)}</div>
      </div>
      <div class="job-card-actions">
        <span class="pill${statusClass}">${escapeHtml(isCanceling ? "canceling" : job.status)}</span>
        <button class="cancel-job icon-button" type="button" title="Cancel job" aria-label="Cancel job" data-job-key="${escapeHtml(key)}" ${isCanceling ? "disabled" : ""}>x</button>
      </div>
    </div>
  `;
  card.querySelector('[data-slot="progress"]').innerHTML = renderProgress(job);
  card.querySelector('[data-slot="error"]').innerHTML = job.error ? `<div class="error-text">${escapeHtml(job.error)}</div>` : "";
}

async function cancelJob(job) {
  const key = jobKey(job);
  if (state.cancelingJobKeys.has(key)) return;
  state.cancelingJobKeys.add(key);
  renderJobs();
  try {
    const data = await api("/api/jobs/cancel", {
      method: "POST",
      body: JSON.stringify({ id: job.id, promptId: job.promptId }),
    });
    state.liveByPromptId.delete(job.promptId);
    state.activePromptByBackend.delete(job.backendId);
    state.jobs = state.jobs.map((item) => (jobKey(item) === key ? data.job : item));
    renderJobs();
    loadJobs();
    refreshStatuses();
  } catch (error) {
    console.warn(`Job could not be canceled; removing it from the active list.`, error);
    state.liveByPromptId.delete(job.promptId);
    state.activePromptByBackend.delete(job.backendId);
    state.jobs = state.jobs.filter((item) => jobKey(item) !== key);
  } finally {
    state.cancelingJobKeys.delete(key);
    renderJobs();
  }
}

function renderProgress(job) {
  const percent = progressPercent(job);
  const node = job.currentNode || (job.status === "done" ? "Complete" : "Waiting for backend");
  const detail = job.progress?.max ? `Step ${job.progress.value} / ${job.progress.max}` : job.status;
  return `
    <div class="job-progress">
      <div class="progress-copy">
        <span>${escapeHtml(node)}</span>
        <strong>${escapeHtml(detail)}</strong>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width: ${percent}%"></div>
      </div>
    </div>
  `;
}

function progressPercent(job) {
  if (job.status === "done") return 100;
  if (job.status === "failed") return 0;
  if (!job.progress?.max) return 0;
  return Math.max(0, Math.min(100, Math.round((job.progress.value / job.progress.max) * 100)));
}

function renderAssignments(assignments) {
  if (!assignments.length) return `<div class="assignments"><span class="assignment">Original workflow</span></div>`;
  return `
    <div class="assignments">
      ${assignments.map((item) => `<span class="assignment">${escapeHtml(item.nodeTitle)} | ${escapeHtml(item.inputName)} = ${escapeHtml(String(item.value))}</span>`).join("")}
    </div>
  `;
}

function collectGalleryItems() {
  return state.mediaItems;
}

function gallerySignature(items) {
  return `${state.galleryView}|${items.map((item) => item.id).join("|")}`;
}

function renderMediaGallery() {
  const items = collectGalleryItems();
  const signature = gallerySignature(items);
  if (signature === state.renderedGallerySignature) {
    renderGalleryFooter();
    return;
  }
  state.renderedGallerySignature = signature;
  state.galleryItems = items;
  const videoCount = items.filter((item) => item.kind === "video").length;
  els.downloadVideos.disabled = videoCount === 0;
  els.downloadVideos.textContent = videoCount ? `Download ${videoCount} video${videoCount === 1 ? "" : "s"}` : "Download videos";
  renderGalleryFooter();

  els.mediaGallery.className = `media-gallery ${state.galleryView === "feed" ? "feed-mode" : "grid-mode"}`;
  els.mediaGallery.classList.toggle("empty-state", !items.length);
  if (!items.length) {
    if (state.mediaObserver) state.mediaObserver.disconnect();
    if (state.mediaHydrationObserver) state.mediaHydrationObserver.disconnect();
    state.mediaNodes.clear();
    els.mediaGallery.textContent = "Finished images and videos will appear here.";
    return;
  }

  syncGalleryDom(items);
  state.activeMediaIndex = Math.min(state.activeMediaIndex, Math.max(0, items.length - 1));
  updateVideoWindow();
  observeFeedVideos();
  observeMediaHydration();
}

function renderGalleryFooter() {
  const shown = state.mediaItems.length;
  const total = state.mediaPage.total || 0;
  const page = state.mediaPage.page;
  const totalPages = state.mediaPage.totalPages;
  const start = total && shown ? ((page - 1) * state.mediaPage.limit) + 1 : 0;
  const end = total && shown ? start + shown - 1 : 0;
  els.galleryPageTitle.textContent = totalPages > 1 ? `Page ${page} of ${totalPages}` : "Most recent outputs";
  els.galleryCount.textContent = total
    ? `${start}-${end} of ${total} item${total === 1 ? "" : "s"}`
    : "0 items";
  els.galleryPrev.disabled = state.mediaPage.loading || !state.mediaPage.hasPrevious;
  els.galleryNext.disabled = state.mediaPage.loading || !state.mediaPage.hasNext;
  els.itemsPerPage.value = String(state.mediaPage.limit);
  renderPageButtons();
}

function renderPageButtons() {
  els.galleryPages.innerHTML = "";
  const pages = visibleGalleryPages(state.mediaPage.page, state.mediaPage.totalPages);
  let previous = 0;
  for (const page of pages) {
    if (previous && page - previous > 1) {
      const gap = document.createElement("span");
      gap.className = "page-gap";
      gap.textContent = "...";
      els.galleryPages.append(gap);
    }
    const button = document.createElement("button");
    button.className = "page-button";
    button.type = "button";
    button.textContent = String(page);
    button.dataset.page = String(page);
    button.classList.toggle("active", page === state.mediaPage.page);
    button.disabled = state.mediaPage.loading || page === state.mediaPage.page;
    els.galleryPages.append(button);
    previous = page;
  }
}

function visibleGalleryPages(page, totalPages) {
  const pages = new Set([1, page, page + 1, page + 2, totalPages]);
  if (page > 1) pages.add(page - 1);
  return [...pages]
    .filter((item) => item >= 1 && item <= totalPages)
    .sort((left, right) => left - right);
}

function syncGalleryDom(items) {
  if (els.mediaGallery.firstChild?.nodeType === Node.TEXT_NODE) els.mediaGallery.textContent = "";

  const wanted = new Set(items.map((item) => item.id));
  let anchor = els.mediaGallery.firstElementChild;
  items.forEach((item, index) => {
    let node = state.mediaNodes.get(item.id);
    if (!node) {
      node = createGalleryItem();
      state.mediaNodes.set(item.id, node);
    }
    updateGalleryItem(node, item, index);
    if (node !== anchor) els.mediaGallery.insertBefore(node, anchor);
    anchor = node.nextElementSibling;
  });

  for (const [id, node] of state.mediaNodes) {
    if (wanted.has(id)) continue;
    node.remove();
    state.mediaNodes.delete(id);
  }
}

function createGalleryItem() {
  const figure = document.createElement("figure");
  figure.className = "gallery-item";

  const mediaWrap = document.createElement("div");
  mediaWrap.className = "gallery-media";

  const caption = document.createElement("figcaption");
  const title = document.createElement("strong");
  const meta = document.createElement("span");
  const actions = document.createElement("div");
  actions.className = "gallery-card-actions";
  const openWorkflow = document.createElement("button");
  openWorkflow.className = "ghost-button open-workflow";
  openWorkflow.type = "button";
  openWorkflow.textContent = "Use workflow";
  openWorkflow.title = "Use this video's embedded workflow";
  openWorkflow.addEventListener("click", () => openGalleryVideoWorkflow(figure, openWorkflow));
  actions.append(openWorkflow);
  caption.append(title, meta, actions);

  figure.append(mediaWrap, caption);
  return figure;
}

function updateGalleryItem(node, item, index) {
  node.dataset.mediaIndex = String(index);
  node.dataset.mediaId = item.id;
  node.dataset.mediaUrl = item.url;
  node.dataset.filename = item.filename;
  node.dataset.kind = item.kind;
  const mediaWrap = node.querySelector(".gallery-media");
  let media = mediaWrap.firstElementChild;
  if (!media || media.dataset.kind !== item.kind) {
    media?.remove();
    media = createMediaElement(item);
    mediaWrap.append(media);
  }

  media.dataset.src = item.url;
  media.dataset.kind = item.kind;
  media.dataset.mediaId = item.id;
  if (item.kind === "video") {
    media.title = item.filename;
  } else if (media.src !== item.url) {
    media.src = item.url;
    media.alt = item.filename;
  }

  node.querySelector("figcaption strong").textContent = item.filename;
  node.querySelector("figcaption span").textContent = `${item.backendName} | ${item.kind}`;
  node.querySelector(".open-workflow").hidden = item.kind !== "video";
}

async function openGalleryVideoWorkflow(card, button) {
  const mediaUrl = card.dataset.mediaUrl;
  const filename = card.dataset.filename || "workflow-video.mp4";
  if (!mediaUrl) return;

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Opening...";
  try {
    const response = await fetch(mediaUrl);
    if (!response.ok) throw new Error(`Could not read video: ${response.statusText}`);
    const blob = await response.blob();
    const file = new File([blob], filename, { type: blob.type || "video/mp4" });
    loadWorkflow(await readWorkflowFromFile(file), filename);
    setPanelVisibility("inputs", true);
  } catch (error) {
    alert(`Workflow could not be loaded from this video: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function createMediaElement(item) {
  if (item.kind !== "video") {
    const image = document.createElement("img");
    image.loading = "lazy";
    image.decoding = "async";
    image.alt = item.filename;
    image.src = item.url;
    image.dataset.kind = item.kind;
    return image;
  }

  const video = document.createElement("video");
  video.controls = true;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = "none";
  video.title = item.filename;
  video.dataset.kind = item.kind;
  video.dataset.src = item.url;
  video.addEventListener("error", markVideoFailed);
  return video;
}

function setGalleryView(view) {
  state.galleryView = view;
  state.activeMediaIndex = 0;
  els.gridView.classList.toggle("active", view === "grid");
  els.feedView.classList.toggle("active", view === "feed");
  renderMediaGallery();
  if (view === "feed") requestAnimationFrame(() => scrollActiveMedia("auto"));
}

function observeFeedVideos() {
  if (state.mediaObserver) state.mediaObserver.disconnect();
  const videos = [...els.mediaGallery.querySelectorAll("video")];
  if (state.galleryView !== "feed" || !videos.length) {
    videos.forEach((video) => video.pause());
    return;
  }

  state.mediaObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const video = entry.target;
      const item = video.closest(".gallery-item");
      const index = Number(item?.dataset.mediaIndex || 0);
      if (entry.isIntersecting && entry.intersectionRatio > 0.65) {
        if (isFailedVideo(video)) continue;
        state.activeMediaIndex = index;
        hydrateVideo(video, "auto");
        updateVideoWindow();
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    }
  }, { root: els.mediaGallery, threshold: [0, 0.65, 1] });

  videos.forEach((video) => state.mediaObserver.observe(video));
}

function observeMediaHydration() {
  if (state.mediaHydrationObserver) state.mediaHydrationObserver.disconnect();
  const videos = [...els.mediaGallery.querySelectorAll("video")];
  if (!videos.length) return;

  state.mediaHydrationObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const video = entry.target;
      const item = video.closest(".gallery-item");
      const index = Number(item?.dataset.mediaIndex || 0);
      if (isFailedVideo(video)) continue;
      if (entry.isIntersecting) {
        hydrateVideo(video, "metadata");
      } else if (state.galleryView === "feed" && Math.abs(index - state.activeMediaIndex) > 1) {
        dehydrateVideo(video);
      }
    }
  }, {
    root: state.galleryView === "feed" ? els.mediaGallery : null,
    rootMargin: state.galleryView === "feed" ? "120% 0px" : "900px 0px",
    threshold: 0.01,
  });

  videos.forEach((video) => state.mediaHydrationObserver.observe(video));
}

function updateVideoWindow() {
  if (state.galleryView !== "feed") return;
  const videos = [...els.mediaGallery.querySelectorAll("video")];
  for (const video of videos) {
    const index = Number(video.closest(".gallery-item")?.dataset.mediaIndex || 0);
    const distance = Math.abs(index - state.activeMediaIndex);
    if (isFailedVideo(video)) continue;
    if (distance <= 1) {
      hydrateVideo(video, distance === 0 ? "auto" : "metadata");
    } else if (distance > 2) {
      dehydrateVideo(video);
    }
  }
}

function hydrateVideo(video, preload = "metadata") {
  const source = video.dataset.src;
  if (!source) return;
  if (isFailedVideo(video)) return;
  video.preload = preload;
  if (video.getAttribute("src") === source) return;
  video.src = source;
  video.load();
}

function dehydrateVideo(video) {
  if (!video.getAttribute("src")) return;
  video.pause();
  video.removeAttribute("src");
  video.preload = "none";
  video.load();
}

function isFailedVideo(video) {
  return state.failedVideoSources.has(videoSourceKey(video));
}

function markVideoFailed(event) {
  const video = event.currentTarget;
  const source = videoSourceKey(video);
  if (!source) return;
  state.failedVideoSources.add(source);
  video.pause();
  video.removeAttribute("src");
  video.preload = "none";
  video.load();
}

function videoSourceKey(video) {
  const source = video.dataset.src || video.getAttribute("src") || video.currentSrc || "";
  return source ? `${video.dataset.mediaId || ""}|${source}` : "";
}

function moveFeed(step) {
  if (state.galleryView !== "feed" || !state.galleryItems.length) return;
  const nextIndex = state.activeMediaIndex + step;
  if (nextIndex >= state.galleryItems.length && state.mediaPage.hasNext) {
    loadMediaPage({ page: state.mediaPage.page + 1, preserveActive: false }).then(() => {
      renderMediaGallery();
      state.activeMediaIndex = 0;
      updateVideoWindow();
      scrollActiveMedia();
    }).catch(console.warn);
    return;
  }
  if (nextIndex < 0 && state.mediaPage.hasPrevious) {
    loadMediaPage({ page: state.mediaPage.page - 1, preserveActive: false }).then(() => {
      renderMediaGallery();
      state.activeMediaIndex = Math.max(0, state.galleryItems.length - 1);
      updateVideoWindow();
      scrollActiveMedia();
    }).catch(console.warn);
    return;
  }
  state.activeMediaIndex = Math.max(0, Math.min(nextIndex, state.galleryItems.length - 1));
  updateVideoWindow();
  scrollActiveMedia();
}

function scrollActiveMedia(behavior = "smooth") {
  const item = els.mediaGallery.querySelector(`[data-media-index="${state.activeMediaIndex}"]`);
  item?.scrollIntoView({ behavior, block: "center" });
}

function handleGalleryScroll() {
  if (state.galleryView !== "feed") return;
  updateActiveMediaFromScroll();
}

function updateActiveMediaFromScroll() {
  const items = [...els.mediaGallery.querySelectorAll(".gallery-item")];
  if (!items.length) return;
  const galleryRect = els.mediaGallery.getBoundingClientRect();
  const center = galleryRect.top + galleryRect.height / 2;
  let nearestIndex = state.activeMediaIndex;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const rect = item.getBoundingClientRect();
    const distance = Math.abs(rect.top + rect.height / 2 - center);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = Number(item.dataset.mediaIndex || 0);
    }
  }
  if (nearestIndex !== state.activeMediaIndex) {
    state.activeMediaIndex = nearestIndex;
    updateVideoWindow();
  }
}

function downloadAllVideos() {
  if (!state.galleryItems.some((item) => item.kind === "video")) return;
  window.location.href = "/api/videos/download";
}

function goToGalleryPage(page) {
  const nextPage = Math.max(1, Math.min(page, state.mediaPage.totalPages));
  loadMediaPage({ page: nextPage, preserveActive: false }).then(renderMediaGallery).catch(console.warn);
}

function setPanelVisibility(panel, visible) {
  if (panel === "inputs") {
    state.layout.inputsVisible = visible;
    if (!visible) state.layout.galleryVisible = true;
  } else {
    state.layout.galleryVisible = visible;
    if (!visible) state.layout.inputsVisible = true;
  }
  localStorage.setItem("inputsPanelVisible", String(state.layout.inputsVisible));
  localStorage.setItem("galleryPanelVisible", String(state.layout.galleryVisible));
  renderLayoutState();
}

function renderLayoutState() {
  els.editorGrid.classList.toggle("inputs-collapsed", !state.layout.inputsVisible);
  els.editorGrid.classList.toggle("gallery-collapsed", !state.layout.galleryVisible);
  els.toggleInputsPanel.classList.toggle("active", state.layout.inputsVisible);
  els.toggleGalleryPanel.classList.toggle("active", state.layout.galleryVisible);
  els.toggleInputsPanel.textContent = state.layout.inputsVisible ? "Inputs" : "Show inputs";
  els.toggleGalleryPanel.textContent = state.layout.galleryVisible ? "Gallery" : "Show gallery";
  els.hideInputsPanel.textContent = state.layout.inputsVisible ? "Hide inputs" : "Show inputs";
  els.hideGalleryPanel.textContent = state.layout.galleryVisible ? "Hide gallery" : "Show gallery";
}

function restoreColumnWidth() {
  const saved = localStorage.getItem("workflowColumnWidth");
  if (saved) els.editorGrid.style.setProperty("--workflow-column", saved);
}

function startColumnResize(event) {
  if (!state.layout.inputsVisible || !state.layout.galleryVisible) return;
  event.preventDefault();
  els.editorGrid.classList.add("resizing");
  const onPointerMove = (moveEvent) => {
    const rect = els.editorGrid.getBoundingClientRect();
    const percent = ((moveEvent.clientX - rect.left) / rect.width) * 100;
    const clamped = Math.max(24, Math.min(68, percent));
    const value = `${clamped.toFixed(1)}%`;
    els.editorGrid.style.setProperty("--workflow-column", value);
    localStorage.setItem("workflowColumnWidth", value);
  };
  const onPointerUp = () => {
    els.editorGrid.classList.remove("resizing");
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  };
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp, { once: true });
}

function isEditingText(target) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("textarea, input, select, [contenteditable='true']"));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function readWorkflowFromFile(file) {
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  if (ext === "json" || file.type === "application/json") {
    return normalizeWorkflowPayload(await file.text(), file.name);
  }

  const buffer = await file.arrayBuffer();
  const metadata = extractMediaMetadata(buffer, file);
  const workflowPayload = pickWorkflowPayload(metadata) || findEmbeddedWorkflowPayload(new Uint8Array(buffer));
  if (!workflowPayload) {
    throw new Error("No ComfyUI workflow metadata was found in this file.");
  }
  return normalizeWorkflowPayload(workflowPayload, file.name);
}

function extractMediaMetadata(buffer, file) {
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  if (file.type === "image/png" || ext === "png") return extractPngMetadata(buffer);
  if (file.type === "image/webp" || ext === "webp") return extractWebpMetadata(buffer);
  if (file.type === "video/mp4" || ext === "mp4" || ext === "m4v") return extractMp4Metadata(buffer);
  return {};
}

function pickWorkflowPayload(metadata) {
  const orderedKeys = ["prompt", "Prompt", "workflow_api", "workflow", "Workflow"];
  for (const key of orderedKeys) {
    if (metadata[key]) return metadata[key];
  }
  return "";
}

function normalizeWorkflowPayload(payload, sourceName) {
  const parsed = parseMaybeJson(payload);
  const candidates = [
    parsed?.prompt,
    parsed?.Prompt,
    parsed?.workflow_api,
    parsed?.extra_data?.extra_pnginfo?.prompt,
    parsed?.extra_data?.extra_pnginfo?.workflow,
    parsed?.workflow,
    parsed?.Workflow,
    parsed,
  ];

  for (const candidate of candidates) {
    const value = parseMaybeJson(candidate);
    if (isComfyApiWorkflow(value)) return value;
  }

  const uiWorkflow = candidates.map(parseMaybeJson).find(isComfyUiWorkflow);
  if (uiWorkflow) {
    throw new Error(`${sourceName} contains a ComfyUI canvas workflow, but no API prompt metadata that can be queued.`);
  }
  throw new Error(`${sourceName} did not contain a queueable ComfyUI API workflow.`);
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function isComfyApiWorkflow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).some((node) =>
    node && typeof node === "object" && !Array.isArray(node) && node.class_type && node.inputs
  );
}

function isComfyUiWorkflow(value) {
  return Boolean(value && typeof value === "object" && Array.isArray(value.nodes) && Array.isArray(value.links));
}

function loadWorkflow(workflow, sourceName = "") {
  state.workflow = workflow;
  state.workflowSourceName = sourceName;
  state.inputs = extractInputs(state.workflow);
  state.selectedInputs.clear();
  state.hiddenInputIds.clear();
  renderInputs();
  updateVariantCount();
  updateSubmitState();
  updateFavoriteControls();
}

async function loadWorkflowFile(file, { errorPrefix = "Workflow could not be loaded" } = {}) {
  if (!file) return;
  try {
    loadWorkflow(await readWorkflowFromFile(file), file.name);
  } catch (error) {
    alert(`${errorPrefix}: ${error.message}`);
  } finally {
    setWorkflowDropOverlay(false);
    if (els.workflowFile) els.workflowFile.value = "";
  }
}

function hasDraggedFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

function isInsideImagePicker(event) {
  return event.target instanceof Element && Boolean(event.target.closest(".image-picker"));
}

function setWorkflowDropOverlay(visible, loading = false) {
  document.body.classList.toggle("workflow-drag-over", visible);
  document.body.classList.toggle("workflow-drop-loading", loading);
  if (els.workflowDropOverlay) els.workflowDropOverlay.setAttribute("aria-hidden", visible ? "false" : "true");
  if (els.workflowDropTitle) els.workflowDropTitle.textContent = loading ? "Loading workflow..." : "Drop workflow to load";
  if (els.workflowDropHint) {
    els.workflowDropHint.textContent = loading
      ? "Reading embedded ComfyUI metadata"
      : "JSON, image, or video with embedded ComfyUI metadata";
  }
}

function bindWindowWorkflowDrop() {
  window.addEventListener("dragenter", (event) => {
    if (!hasDraggedFiles(event) || isInsideImagePicker(event)) return;
    event.preventDefault();
    state.workflowDropDepth += 1;
    setWorkflowDropOverlay(true);
  });

  window.addEventListener("dragover", (event) => {
    if (!hasDraggedFiles(event) || isInsideImagePicker(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setWorkflowDropOverlay(true);
  });

  window.addEventListener("dragleave", (event) => {
    if (!hasDraggedFiles(event) || isInsideImagePicker(event)) return;
    state.workflowDropDepth = Math.max(0, state.workflowDropDepth - 1);
    if (state.workflowDropDepth === 0) setWorkflowDropOverlay(false);
  });

  window.addEventListener("drop", (event) => {
    if (!hasDraggedFiles(event) || isInsideImagePicker(event)) return;
    event.preventDefault();
    state.workflowDropDepth = 0;
    const [file] = Array.from(event.dataTransfer.files || []);
    if (!file) {
      setWorkflowDropOverlay(false);
      return;
    }
    setWorkflowDropOverlay(true, true);
    loadWorkflowFile(file, { errorPrefix: "Dropped workflow could not be loaded" });
  });
}

function extractPngMetadata(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 8 || view.getUint32(0) !== 0x89504e47) return {};

  const metadata = {};
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = readAscii(bytes, offset + 4, 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) break;

    if (type === "tEXt" || type === "comf") {
      const data = bytes.slice(dataStart, dataEnd);
      const zero = data.indexOf(0);
      if (zero > -1) {
        metadata[readLatin1(data, 0, zero)] = decodeUtf8(data.slice(zero + 1));
      }
    } else if (type === "iTXt") {
      Object.assign(metadata, extractInternationalTextChunk(bytes.slice(dataStart, dataEnd)));
    }

    offset = dataEnd + 4;
  }
  return metadata;
}

function extractInternationalTextChunk(data) {
  const metadata = {};
  const keyEnd = data.indexOf(0);
  if (keyEnd < 0 || keyEnd + 5 >= data.length) return metadata;
  const keyword = readLatin1(data, 0, keyEnd);
  const compressionFlag = data[keyEnd + 1];
  if (compressionFlag) return metadata;

  let offset = keyEnd + 3;
  const languageEnd = data.indexOf(0, offset);
  if (languageEnd < 0) return metadata;
  offset = languageEnd + 1;
  const translatedEnd = data.indexOf(0, offset);
  if (translatedEnd < 0) return metadata;
  metadata[keyword] = decodeUtf8(data.slice(translatedEnd + 1));
  return metadata;
}

function extractWebpMetadata(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 12 || readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WEBP") return {};

  const metadata = {};
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = readAscii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > bytes.length) break;
    if (type === "EXIF") {
      Object.assign(metadata, extractTiffKeyValueMetadata(bytes.slice(dataStart, dataEnd)));
    } else if (type === "XMP ") {
      Object.assign(metadata, extractXmlLikeMetadata(decodeUtf8(bytes.slice(dataStart, dataEnd))));
    }
    offset = dataEnd + (length % 2);
  }
  return metadata;
}

function extractTiffKeyValueMetadata(data) {
  const exifPrefix = "Exif\x00\x00";
  const tiff = readAscii(data, 0, 6) === exifPrefix ? data.slice(6) : data;
  if (tiff.length < 8) return {};

  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const littleEndian = readAscii(tiff, 0, 2) === "II";
  const firstIfd = view.getUint32(4, littleEndian);
  if (firstIfd + 2 > tiff.length) return {};

  const metadata = {};
  const entryCount = view.getUint16(firstIfd, littleEndian);
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = firstIfd + 2 + index * 12;
    if (entryOffset + 12 > tiff.length) break;
    const type = view.getUint16(entryOffset + 2, littleEndian);
    const count = view.getUint32(entryOffset + 4, littleEndian);
    if (type !== 2 || count <= 1) continue;

    const valueOffset = count <= 4 ? entryOffset + 8 : view.getUint32(entryOffset + 8, littleEndian);
    if (valueOffset + count > tiff.length) continue;
    const value = decodeUtf8(tiff.slice(valueOffset, valueOffset + count)).replace(/\0+$/, "");
    const separator = value.indexOf(":");
    if (separator > 0) metadata[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return metadata;
}

function extractXmlLikeMetadata(text) {
  const metadata = {};
  for (const key of ["prompt", "workflow", "Workflow", "workflow_api"]) {
    const match = text.match(new RegExp(`<[^>]*(?:${key})[^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i"));
    if (match) metadata[key] = htmlDecode(match[1].trim());
  }
  return metadata;
}

function extractMp4Metadata(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 8 || readAscii(bytes, 4, 4) !== "ftyp") return {};
  const metadata = {};
  parseMp4Boxes(view, 0, bytes.length, metadata);
  return metadata;
}

function parseMp4Boxes(view, start, end, metadata) {
  let offset = start;
  while (offset + 8 <= end) {
    const box = readMp4Box(view, offset, end);
    if (!box) break;
    if (box.type === "moov") parseMp4Boxes(view, box.headerEnd, box.end, metadata);
    if (box.type === "udta") parseMp4UserData(view, box.headerEnd, box.end, metadata);
    if (box.type === "meta" && box.headerEnd + 4 <= box.end) parseMp4Meta(view, box.headerEnd + 4, box.end, metadata);
    if (box.type === "uuid" && box.headerEnd + 16 <= box.end) parseMp4Uuid(view, box.headerEnd, box.end, metadata);
    offset = box.end;
  }
}

function parseMp4UserData(view, start, end, metadata) {
  let offset = start;
  while (offset + 8 <= end) {
    const box = readMp4Box(view, offset, end);
    if (!box) break;
    if (box.type === "wflo" && box.headerEnd + 4 <= box.end) {
      metadata.workflow = decodeViewUtf8(view, box.headerEnd + 4, box.end).trim();
    }
    if (box.type === "meta" && box.headerEnd + 4 <= box.end) parseMp4Meta(view, box.headerEnd + 4, box.end, metadata);
    offset = box.end;
  }
}

function parseMp4Meta(view, start, end, metadata) {
  const keys = {};
  let ilst = null;
  let offset = start;
  while (offset + 8 <= end) {
    const box = readMp4Box(view, offset, end);
    if (!box) break;
    if (box.type === "keys" && box.headerEnd + 8 <= box.end) {
      const count = view.getUint32(box.headerEnd + 4);
      let keyOffset = box.headerEnd + 8;
      for (let index = 1; index <= count && keyOffset + 8 <= box.end; index += 1) {
        const keySize = view.getUint32(keyOffset);
        if (keySize < 8 || keyOffset + keySize > box.end) break;
        keys[index] = decodeViewUtf8(view, keyOffset + 8, keyOffset + keySize).trim();
        keyOffset += keySize;
      }
    }
    if (box.type === "ilst") ilst = box;
    offset = box.end;
  }
  if (!ilst || !Object.keys(keys).length) return;

  let itemOffset = ilst.headerEnd;
  let itemIndex = 0;
  while (itemOffset + 8 <= ilst.end) {
    const item = readMp4Box(view, itemOffset, ilst.end);
    if (!item) break;
    itemIndex += 1;
    const dataBox = readMp4Box(view, item.headerEnd, item.end);
    if (dataBox?.type === "data" && dataBox.headerEnd + 8 <= dataBox.end) {
      const dataType = view.getUint32(dataBox.headerEnd);
      if (dataType === 1 && keys[itemIndex]) {
        metadata[keys[itemIndex]] = decodeViewUtf8(view, dataBox.headerEnd + 8, dataBox.end).trim();
      }
    }
    itemOffset = item.end;
  }
}

function parseMp4Uuid(view, start, end, metadata) {
  const uuid = decodeViewLatin1(view, start, start + 16);
  if (uuid !== "comfyuiworkflow\0") return;
  metadata.workflow = decodeViewUtf8(view, start + 16, end).trim();
}

function readMp4Box(view, offset, end) {
  if (offset + 8 > end) return null;
  let size = view.getUint32(offset);
  const type = decodeViewLatin1(view, offset + 4, offset + 8);
  let headerEnd = offset + 8;
  if (size === 1 && offset + 16 <= end) {
    const high = view.getUint32(offset + 8);
    const low = view.getUint32(offset + 12);
    if (high > 0) return null;
    size = low;
    headerEnd = offset + 16;
  } else if (size === 0) {
    size = end - offset;
  }
  if (size < headerEnd - offset || offset + size > end) return null;
  return { type, start: offset, headerEnd, end: offset + size, size };
}

function findEmbeddedWorkflowPayload(bytes) {
  const text = decodeUtf8(bytes);
  for (const key of ["prompt", "workflow_api", "workflow", "Workflow"]) {
    const value = findKeyedJsonPayload(text, key);
    if (value) return value;
  }
  return "";
}

function findKeyedJsonPayload(text, key) {
  const patterns = [`"${key}"`, key];
  for (const pattern of patterns) {
    let index = 0;
    while ((index = text.indexOf(pattern, index)) !== -1) {
      const colon = text.indexOf(":", index + pattern.length);
      if (colon === -1 || colon - index > 80) {
        index += pattern.length;
        continue;
      }
      const start = skipWhitespace(text, colon + 1);
      const parsed = readJsonLiteralAt(text, start);
      if (parsed) return parsed;
      index += pattern.length;
    }
  }
  return "";
}

function readJsonLiteralAt(text, start) {
  const first = text[start];
  if (first === "{" || first === "[") return readBalancedJson(text, start);
  if (first === '"') {
    const literal = readQuotedJsonString(text, start);
    if (!literal) return "";
    try {
      return JSON.parse(literal);
    } catch {
      return "";
    }
  }
  return "";
}

function readBalancedJson(text, start) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') inString = true;
    if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    if (char === "}" || char === "]") {
      if (stack.pop() !== char) return "";
      if (!stack.length) return text.slice(start, index + 1);
    }
  }
  return "";
}

function readQuotedJsonString(text, start) {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      return text.slice(start, index + 1);
    }
  }
  return "";
}

function skipWhitespace(text, start) {
  let index = start;
  while (/\s/.test(text[index] || "")) index += 1;
  return index;
}

function readAscii(bytes, start, length) {
  return readLatin1(bytes, start, start + length);
}

function readLatin1(bytes, start, end) {
  return String.fromCharCode(...bytes.slice(start, end));
}

function decodeUtf8(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}

function decodeViewUtf8(view, start, end) {
  return decodeUtf8(new Uint8Array(view.buffer, view.byteOffset + start, end - start));
}

function decodeViewLatin1(view, start, end) {
  return readLatin1(new Uint8Array(view.buffer, view.byteOffset + start, end - start), 0, end - start);
}

function htmlDecode(value) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value;
}

els.workflowFile.addEventListener("change", async () => {
  const file = els.workflowFile.files[0];
  loadWorkflowFile(file);
});
els.favoriteWorkflowSelect.addEventListener("change", () => {
  loadFavoriteWorkflow(els.favoriteWorkflowSelect.value);
  updateFavoriteControls();
});
els.renameFavoriteWorkflow.addEventListener("click", renameSelectedFavoriteWorkflow);
els.deleteFavoriteWorkflow.addEventListener("click", deleteSelectedFavoriteWorkflow);
els.favoriteWorkflow.addEventListener("click", saveCurrentWorkflowFavorite);

els.inputFilter.addEventListener("input", renderInputs);
els.showHiddenInputs.addEventListener("click", () => {
  state.hiddenInputIds.clear();
  renderInputs();
});
els.addBackend.addEventListener("click", () => {
  collectBackendsFromDom();
  state.backends.push({
    id: `backend-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: `GPU ${state.backends.length + 1}`,
    url: nextLocalBackendUrl(state.backends),
  });
  renderBackends();
  connectBackendSockets();
});
els.toggleBackends.addEventListener("click", () => setBackendPanelCollapsed(!state.layout.backendsCollapsed));
els.saveBackends.addEventListener("click", saveBackends);
els.detectGpus.addEventListener("click", detectGpus);
els.autoBackends.addEventListener("click", autoCreateBackends);
els.submitJobs.addEventListener("click", submitJobs);
els.refreshJobs.addEventListener("click", loadJobs);
els.gridView.addEventListener("click", () => setGalleryView("grid"));
els.feedView.addEventListener("click", () => setGalleryView("feed"));
els.autoScrollNew.checked = state.autoScrollNew;
els.autoScrollNew.addEventListener("change", () => {
  state.autoScrollNew = els.autoScrollNew.checked;
  localStorage.setItem("autoScrollNewMedia", String(state.autoScrollNew));
});
els.galleryPrev.addEventListener("click", () => goToGalleryPage(state.mediaPage.page - 1));
els.galleryNext.addEventListener("click", () => goToGalleryPage(state.mediaPage.page + 1));
els.galleryPages.addEventListener("click", (event) => {
  const button = event.target.closest(".page-button");
  if (!button) return;
  goToGalleryPage(Number(button.dataset.page));
});
els.itemsPerPage.value = String(state.mediaPage.limit);
els.itemsPerPage.addEventListener("change", () => {
  state.mediaPage.limit = Number(els.itemsPerPage.value) || 10;
  state.mediaPage.page = 1;
  localStorage.setItem("galleryItemsPerPage", String(state.mediaPage.limit));
  loadMediaPage({ page: 1 }).then(renderMediaGallery).catch(console.warn);
});
els.mediaGallery.addEventListener("scroll", handleGalleryScroll);
els.downloadVideos.addEventListener("click", downloadAllVideos);
bindWindowWorkflowDrop();
els.toggleInputsPanel.addEventListener("click", () => setPanelVisibility("inputs", !state.layout.inputsVisible));
els.toggleGalleryPanel.addEventListener("click", () => setPanelVisibility("gallery", !state.layout.galleryVisible));
els.hideInputsPanel.addEventListener("click", () => setPanelVisibility("inputs", false));
els.hideGalleryPanel.addEventListener("click", () => setPanelVisibility("gallery", false));
els.columnResizer.addEventListener("pointerdown", startColumnResize);
window.addEventListener("keydown", (event) => {
  if (state.galleryView !== "feed") return;
  if (isEditingText(event.target)) return;
  if (event.key === "ArrowDown") {
    moveFeed(1);
    event.preventDefault();
  }
  if (event.key === "ArrowUp") {
    moveFeed(-1);
    event.preventDefault();
  }
});

restoreColumnWidth();
renderLayoutState();
renderBackendPanelState();
renderFavoriteWorkflows();
updateFavoriteControls();
loadBackends();
loadClientId();
detectGpus();
loadJobs();
setInterval(loadJobs, 3500);
setInterval(refreshStatuses, 10000);
