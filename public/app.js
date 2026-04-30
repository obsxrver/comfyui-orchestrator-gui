const els = {
  workflowFile: document.querySelector("#workflowFile"),
  inputList: document.querySelector("#inputList"),
  inputFilter: document.querySelector("#inputFilter"),
  backendList: document.querySelector("#backendList"),
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
  gridView: document.querySelector("#gridView"),
  feedView: document.querySelector("#feedView"),
  downloadVideos: document.querySelector("#downloadVideos"),
  variantCount: document.querySelector("#variantCount"),
  activeCount: document.querySelector("#activeCount"),
  overallProgress: document.querySelector("#overallProgress"),
  overallProgressBar: document.querySelector("#overallProgressBar"),
  backendTemplate: document.querySelector("#backendTemplate"),
  inputTemplate: document.querySelector("#inputTemplate"),
};

const state = {
  workflow: null,
  inputs: [],
  selectedInputs: new Map(),
  backends: [],
  statuses: new Map(),
  jobs: [],
  gpuDetection: null,
  clientId: "",
  eventSource: null,
  activePromptByBackend: new Map(),
  liveByPromptId: new Map(),
  jobCards: new Map(),
  galleryView: "grid",
  galleryItems: [],
  activeMediaIndex: 0,
  mediaObserver: null,
  gallerySignature: "",
};

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

function isLinkValue(value) {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string";
}

function extractInputs(workflow) {
  return Object.entries(workflow).flatMap(([nodeId, node]) => {
    if (!node || typeof node !== "object" || !node.inputs) return [];
    const classType = node.class_type || "";
    const nodeTitle = node._meta?.title || classType || `Node ${nodeId}`;
    const lowerClass = classType.toLowerCase();
    const lowerTitle = nodeTitle.toLowerCase();

    if (classType === "CLIPTextEncode" && typeof node.inputs.text === "string") {
      return [makeInput({ nodeId, nodeTitle, classType, inputName: "text", kind: "text", value: node.inputs.text })];
    }

    if (classType === "LoadImage" && typeof node.inputs.image === "string") {
      return [makeInput({ nodeId, nodeTitle, classType, inputName: "image", kind: "image", value: node.inputs.image })];
    }

    if (lowerClass.includes("primitive") || lowerTitle.includes("primitive")) {
      return Object.entries(node.inputs)
        .filter(([, value]) => !isLinkValue(value))
        .map(([inputName, value]) =>
          makeInput({ nodeId, nodeTitle, classType, inputName, kind: "primitive", value })
        );
    }

    return [];
  });
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
    preview: previewValue(value),
  };
}

function primitiveDescriptor(classType, value) {
  const lower = classType.toLowerCase();
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

function renderInputs() {
  const filter = els.inputFilter.value.trim().toLowerCase();
  const inputs = state.inputs.filter((input) => {
    const haystack = `${input.nodeTitle} ${input.classType} ${input.inputName} ${input.preview}`.toLowerCase();
    return haystack.includes(filter);
  });

  els.inputList.innerHTML = "";
  els.inputList.classList.toggle("empty-state", !inputs.length);
  if (!state.workflow) {
    els.inputList.textContent = "Upload a ComfyUI API workflow JSON to find CLIPTextEncode, LoadImage, and primitive nodes.";
    return;
  }
  if (!inputs.length) {
    els.inputList.textContent = "No CLIPTextEncode, LoadImage, or primitive inputs matched.";
    return;
  }

  for (const input of inputs) {
    const node = els.inputTemplate.content.firstElementChild.cloneNode(true);
    const toggle = node.querySelector(".vary-toggle");
    const valuesInput = node.querySelector(".values-input");
    const scalarList = node.querySelector(".scalar-list");
    const addScalar = node.querySelector(".add-scalar");
    const imagePicker = node.querySelector(".image-picker");
    const imageInput = node.querySelector(".image-input");
    const previewList = node.querySelector(".image-preview-list");
    const selected = state.selectedInputs.get(input.id);

    toggle.checked = Boolean(selected);
    node.querySelector(".input-title").textContent = `${labelForKind(input.kind)} - ${input.nodeTitle}`;
    node.querySelector(".input-meta").textContent = `${input.classType} #${input.nodeId} | ${input.inputName} | current: ${trim(input.preview, 130)}`;

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
      valuesInput.disabled = !toggle.checked;
      valuesInput.placeholder = input.kind === "text"
        ? "One prompt per line, or separate multi-line prompts with ---"
        : "Separate multiline primitive variants with ---";
      valuesInput.value = selected?.rawValue || input.preview;
    } else {
      valuesInput.hidden = true;
      imagePicker.hidden = true;
      scalarList.hidden = false;
      addScalar.hidden = false;
      addScalar.disabled = !toggle.checked;
      renderScalarList(scalarList, input, selected?.values || [input.value], !toggle.checked);
    }

    toggle.addEventListener("change", () => {
      if (toggle.checked) {
        state.selectedInputs.set(input.id, selectionFromControls(input, valuesInput, imageInput, scalarList));
      } else {
        state.selectedInputs.delete(input.id);
        if (input.kind === "image") renderFilePreview(previewList, []);
      }
      valuesInput.disabled = !toggle.checked;
      imageInput.disabled = false;
      addScalar.disabled = !toggle.checked;
      setScalarListDisabled(scalarList, !toggle.checked);
      updateVariantCount();
      updateSubmitState();
    });

    valuesInput.addEventListener("input", () => {
      if (toggle.checked) state.selectedInputs.set(input.id, selectionFromControls(input, valuesInput, imageInput, scalarList));
      updateVariantCount();
    });

    imageInput.addEventListener("change", () => {
      if (imageInput.files.length) toggle.checked = true;
      if (toggle.checked) state.selectedInputs.set(input.id, selectionFromControls(input, valuesInput, imageInput, scalarList));
      renderFilePreview(previewList, [...imageInput.files]);
      updateVariantCount();
      updateSubmitState();
    });

    scalarList.addEventListener("input", () => {
      if (toggle.checked) state.selectedInputs.set(input.id, selectionFromControls(input, valuesInput, imageInput, scalarList));
      updateVariantCount();
    });

    scalarList.addEventListener("change", () => {
      if (toggle.checked) state.selectedInputs.set(input.id, selectionFromControls(input, valuesInput, imageInput, scalarList));
      updateVariantCount();
    });

    scalarList.addEventListener("click", (event) => {
      const removeButton = event.target.closest(".remove-scalar");
      if (!removeButton) return;
      removeButton.closest(".scalar-row").remove();
      if (!scalarList.querySelector(".scalar-row")) addScalarRow(scalarList, input, input.value, !toggle.checked);
      if (toggle.checked) state.selectedInputs.set(input.id, selectionFromControls(input, valuesInput, imageInput, scalarList));
      updateVariantCount();
    });

    addScalar.addEventListener("click", () => {
      addScalarRow(scalarList, input, defaultScalarValue(input), !toggle.checked);
      if (toggle.checked) state.selectedInputs.set(input.id, selectionFromControls(input, valuesInput, imageInput, scalarList));
      updateVariantCount();
    });

    els.inputList.append(node);
  }
}

function labelForKind(kind) {
  if (kind === "text") return "Prompt";
  if (kind === "image") return "Image";
  return "Primitive";
}

function selectionFromControls(input, valuesInput, imageInput, scalarList) {
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
    return {
      nodeId: input.nodeId,
      nodeTitle: input.nodeTitle,
      inputName: input.inputName,
      valueType: input.valueType,
      kind: input.kind,
      values: readScalarValues(scalarList, input),
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
    control.step = input.controlType === "int" ? "1" : "any";
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

function setScalarListDisabled(container, disabled) {
  for (const control of container.querySelectorAll("input, button")) control.disabled = disabled;
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
  return text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
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
      dropZone.classList.add("drag-over");
    });
  }

  for (const eventName of ["dragleave", "drop"]) {
    dropZone.addEventListener(eventName, () => dropZone.classList.remove("drag-over"));
  }

  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    const imageFiles = [...event.dataTransfer.files].filter((file) => file.type.startsWith("image/"));
    if (!imageFiles.length) return;
    const toggle = dropZone.closest(".input-row").querySelector(".vary-toggle");
    toggle.checked = true;
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
        backendIds: selectedBackendIds(),
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
    const data = await api("/api/jobs");
    state.jobs = (data.jobs || state.jobs).map(mergeLiveJob);
    renderJobs();
  } catch (error) {
    console.warn(error);
  }
}

function mergeLiveJob(job) {
  if (job.status === "done" && job.outputs?.length) {
    state.liveByPromptId.delete(job.promptId);
    return job;
  }
  const live = state.liveByPromptId.get(job.promptId);
  return live ? { ...job, ...live } : job;
}

function renderJobs() {
  const jobs = state.jobs.filter((job) => !["done", "failed"].includes(job.status));
  updateOverallProgress();
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
  return card;
}

function updateJobCard(card, job) {
  const statusClass = job.status === "failed" ? " failed" : "";
  card.querySelector('[data-slot="header"]').innerHTML = `
    <div class="job-header">
      <div>
        <strong>${escapeHtml(job.backendName || "Backend")}</strong>
        <div class="assignment">${escapeHtml(job.promptId || job.id)}</div>
      </div>
      <span class="pill${statusClass}">${escapeHtml(job.status)}</span>
    </div>
  `;
  card.querySelector('[data-slot="progress"]').innerHTML = renderProgress(job);
  card.querySelector('[data-slot="error"]').innerHTML = job.error ? `<div class="error-text">${escapeHtml(job.error)}</div>` : "";
}

function updateOverallProgress() {
  const active = state.jobs.filter((job) => !["done", "failed"].includes(job.status));
  const values = active.map(progressPercent);
  const average = values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
  els.activeCount.textContent = String(active.length);
  els.overallProgress.textContent = `${average}%`;
  els.overallProgressBar.style.width = `${average}%`;
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
  return state.jobs
    .filter((job) => job.status === "done")
    .flatMap((job) => (job.outputs || []).map((output, index) => ({
      ...output,
      id: `${job.promptId || job.id}-${index}-${output.filename}`,
      backendName: job.backendName || "Backend",
      promptId: job.promptId || job.id,
      completedAt: job.completedAt || job.createdAt || "",
    })));
}

function renderMediaGallery() {
  const items = collectGalleryItems();
  state.galleryItems = items;
  const signature = `${state.galleryView}:${items.map((item) => item.id).join("|")}`;
  const videoCount = items.filter((item) => item.kind === "video").length;
  els.downloadVideos.disabled = videoCount === 0;
  els.downloadVideos.textContent = videoCount ? `Download ${videoCount} video${videoCount === 1 ? "" : "s"}` : "Download videos";
  if (signature === state.gallerySignature) return;
  state.gallerySignature = signature;

  els.mediaGallery.className = `media-gallery ${state.galleryView === "feed" ? "feed-mode" : "grid-mode"}`;
  els.mediaGallery.classList.toggle("empty-state", !items.length);
  if (!items.length) {
    els.mediaGallery.textContent = "Finished images and videos will appear here.";
    return;
  }

  els.mediaGallery.innerHTML = items.map((item, index) => renderGalleryItem(item, index)).join("");
  observeFeedVideos();
}

function renderGalleryItem(item, index) {
  const url = escapeHtml(item.url);
  const filename = escapeHtml(item.filename);
  const meta = `${escapeHtml(item.backendName)} | ${escapeHtml(item.kind)}`;
  const media = item.kind === "video"
    ? `<video src="${url}" title="${filename}" controls loop muted playsinline preload="metadata"></video>`
    : `<img src="${url}" alt="${filename}" loading="lazy" />`;
  return `
    <figure class="gallery-item" data-media-index="${index}">
      <div class="gallery-media">${media}</div>
      <figcaption>
        <strong>${filename}</strong>
        <span>${meta}</span>
      </figcaption>
    </figure>
  `;
}

function setGalleryView(view) {
  state.galleryView = view;
  state.activeMediaIndex = 0;
  state.gallerySignature = "";
  els.gridView.classList.toggle("active", view === "grid");
  els.feedView.classList.toggle("active", view === "feed");
  renderMediaGallery();
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
      if (entry.isIntersecting && entry.intersectionRatio > 0.65) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    }
  }, { root: els.mediaGallery, threshold: [0, 0.65, 1] });

  videos.forEach((video) => state.mediaObserver.observe(video));
}

function moveFeed(step) {
  if (state.galleryView !== "feed" || !state.galleryItems.length) return;
  state.activeMediaIndex = Math.max(0, Math.min(state.galleryItems.length - 1, state.activeMediaIndex + step));
  const item = els.mediaGallery.querySelector(`[data-media-index="${state.activeMediaIndex}"]`);
  item?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function downloadAllVideos() {
  if (!state.galleryItems.some((item) => item.kind === "video")) return;
  window.location.href = "/api/videos/download";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

els.workflowFile.addEventListener("change", async () => {
  const file = els.workflowFile.files[0];
  if (!file) return;
  const text = await file.text();
  try {
    state.workflow = JSON.parse(text);
    state.inputs = extractInputs(state.workflow);
    state.selectedInputs.clear();
    renderInputs();
    updateVariantCount();
    updateSubmitState();
  } catch (error) {
    alert(`Workflow JSON could not be parsed: ${error.message}`);
  }
});

els.inputFilter.addEventListener("input", renderInputs);
els.addBackend.addEventListener("click", () => {
  collectBackendsFromDom();
  state.backends.push({
    id: `backend-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: `GPU ${state.backends.length + 1}`,
    url: "",
  });
  renderBackends();
  connectBackendSockets();
});
els.saveBackends.addEventListener("click", saveBackends);
els.detectGpus.addEventListener("click", detectGpus);
els.autoBackends.addEventListener("click", autoCreateBackends);
els.submitJobs.addEventListener("click", submitJobs);
els.refreshJobs.addEventListener("click", loadJobs);
els.gridView.addEventListener("click", () => setGalleryView("grid"));
els.feedView.addEventListener("click", () => setGalleryView("feed"));
els.downloadVideos.addEventListener("click", downloadAllVideos);
window.addEventListener("keydown", (event) => {
  if (state.galleryView !== "feed") return;
  if (event.key === "ArrowDown") {
    moveFeed(1);
    event.preventDefault();
  }
  if (event.key === "ArrowUp") {
    moveFeed(-1);
    event.preventDefault();
  }
});

loadBackends();
loadClientId();
detectGpus();
loadJobs();
setInterval(loadJobs, 3500);
setInterval(refreshStatuses, 10000);
