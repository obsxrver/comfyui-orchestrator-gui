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
  clearDone: document.querySelector("#clearDone"),
  jobList: document.querySelector("#jobList"),
  variantCount: document.querySelector("#variantCount"),
  activeCount: document.querySelector("#activeCount"),
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
  hideDone: false,
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
  return {
    id: `${nodeId}:${inputName}`,
    nodeId,
    nodeTitle,
    classType,
    inputName,
    kind,
    value,
    valueType: valueType(value),
    preview: previewValue(value),
  };
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
    const imagePicker = node.querySelector(".image-picker");
    const imageInput = node.querySelector(".image-input");
    const previewList = node.querySelector(".image-preview-list");
    const selected = state.selectedInputs.get(input.id);

    toggle.checked = Boolean(selected);
    node.querySelector(".input-title").textContent = `${labelForKind(input.kind)} - ${input.nodeTitle}`;
    node.querySelector(".input-meta").textContent = `${input.classType} #${input.nodeId} | ${input.inputName} | current: ${trim(input.preview, 130)}`;

    if (input.kind === "image") {
      valuesInput.hidden = true;
      imagePicker.hidden = false;
      imageInput.disabled = !toggle.checked;
      renderFilePreview(previewList, selected?.values || []);
    } else {
      imagePicker.hidden = true;
      valuesInput.hidden = false;
      valuesInput.disabled = !toggle.checked;
      valuesInput.placeholder = input.kind === "text"
        ? "One prompt per line, or separate multi-line prompts with ---"
        : "One primitive value per line";
      valuesInput.value = selected?.rawValue || input.preview;
    }

    toggle.addEventListener("change", () => {
      if (toggle.checked) {
        state.selectedInputs.set(input.id, selectionFromControls(input, valuesInput, imageInput));
      } else {
        state.selectedInputs.delete(input.id);
      }
      valuesInput.disabled = !toggle.checked;
      imageInput.disabled = !toggle.checked;
      updateVariantCount();
      updateSubmitState();
    });

    valuesInput.addEventListener("input", () => {
      if (toggle.checked) state.selectedInputs.set(input.id, selectionFromControls(input, valuesInput, imageInput));
      updateVariantCount();
    });

    imageInput.addEventListener("change", () => {
      if (toggle.checked) state.selectedInputs.set(input.id, selectionFromControls(input, valuesInput, imageInput));
      renderFilePreview(previewList, [...imageInput.files]);
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

function selectionFromControls(input, valuesInput, imageInput) {
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
    const item = document.createElement("span");
    item.className = "file-chip";
    item.textContent = file.name;
    previewList.append(item);
  }
}

function updateVariantCount() {
  const selections = [...state.selectedInputs.values()];
  const total = selections.reduce((product, selection) => {
    const count = selection.values.filter(Boolean).length;
    return product * count;
  }, selections.length ? 1 : 0);
  els.variantCount.textContent = state.workflow ? String(selections.length ? total : 1) : "0";
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
  } catch (error) {
    console.warn(error);
  }
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
    state.jobs = data.jobs || state.jobs;
    renderJobs();
  } catch (error) {
    console.warn(error);
  }
}

function renderJobs() {
  const jobs = state.hideDone ? state.jobs.filter((job) => job.status !== "done") : state.jobs;
  els.activeCount.textContent = String(state.jobs.filter((job) => !["done", "failed"].includes(job.status)).length);
  els.jobList.innerHTML = "";
  els.jobList.classList.toggle("empty-state", !jobs.length);
  if (!jobs.length) {
    els.jobList.textContent = "Queued outputs will appear here.";
    return;
  }

  for (const job of jobs) {
    const card = document.createElement("article");
    card.className = "job-card";
    const statusClass = job.status === "failed" ? " failed" : "";
    card.innerHTML = `
      <div class="job-header">
        <div>
          <strong>${escapeHtml(job.backendName || "Backend")}</strong>
          <div class="assignment">${escapeHtml(job.promptId || job.id)}</div>
        </div>
        <span class="pill${statusClass}">${escapeHtml(job.status)}</span>
      </div>
      ${renderAssignments(job.assignments || [])}
      ${job.error ? `<div class="error-text">${escapeHtml(job.error)}</div>` : ""}
      ${renderOutputs(job.outputs || [])}
    `;
    els.jobList.append(card);
  }
}

function renderAssignments(assignments) {
  if (!assignments.length) return `<div class="assignments"><span class="assignment">Original workflow</span></div>`;
  return `
    <div class="assignments">
      ${assignments.map((item) => `<span class="assignment">${escapeHtml(item.nodeTitle)} | ${escapeHtml(item.inputName)} = ${escapeHtml(String(item.value))}</span>`).join("")}
    </div>
  `;
}

function renderOutputs(outputs) {
  if (!outputs.length) return `<div class="assignment">Waiting for output files</div>`;
  return `
    <div class="media-strip">
      ${outputs.map((output) => {
        const url = escapeHtml(output.url);
        const filename = escapeHtml(output.filename);
        if (output.kind === "video") return `<video src="${url}" title="${filename}" controls loop muted playsinline></video>`;
        return `<img src="${url}" alt="${filename}" loading="lazy" />`;
      }).join("")}
    </div>
  `;
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
});
els.saveBackends.addEventListener("click", saveBackends);
els.detectGpus.addEventListener("click", detectGpus);
els.autoBackends.addEventListener("click", autoCreateBackends);
els.submitJobs.addEventListener("click", submitJobs);
els.refreshJobs.addEventListener("click", loadJobs);
els.clearDone.addEventListener("click", () => {
  state.hideDone = !state.hideDone;
  els.clearDone.textContent = state.hideDone ? "Show done" : "Hide done";
  renderJobs();
});

loadBackends();
detectGpus();
loadJobs();
setInterval(loadJobs, 3500);
setInterval(refreshStatuses, 10000);
