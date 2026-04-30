const els = {
  workflowFile: document.querySelector("#workflowFile"),
  inputList: document.querySelector("#inputList"),
  inputFilter: document.querySelector("#inputFilter"),
  backendList: document.querySelector("#backendList"),
  addBackend: document.querySelector("#addBackend"),
  saveBackends: document.querySelector("#saveBackends"),
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
  workflowName: "",
  inputs: [],
  selectedInputs: new Map(),
  backends: [],
  statuses: new Map(),
  jobs: [],
  hideDone: false,
};

const editableTypes = new Set(["string", "number", "boolean", "json"]);

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

function describeValue(value) {
  if (value === null) return { type: "json", label: "null", preview: "null" };
  if (Array.isArray(value)) return { type: "json", label: "array", preview: JSON.stringify(value) };
  if (typeof value === "object") return { type: "json", label: "object", preview: JSON.stringify(value) };
  return { type: typeof value, label: typeof value, preview: String(value) };
}

function extractInputs(workflow) {
  return Object.entries(workflow).flatMap(([nodeId, node]) => {
    if (!node || typeof node !== "object" || !node.inputs) return [];
    const title = node._meta?.title || node.class_type || `Node ${nodeId}`;
    return Object.entries(node.inputs)
      .filter(([, value]) => !(Array.isArray(value) && value.length === 2 && typeof value[0] === "string"))
      .map(([inputName, value]) => {
        const description = describeValue(value);
        return {
          id: `${nodeId}:${inputName}`,
          nodeId,
          nodeTitle: title,
          classType: node.class_type || "",
          inputName,
          value,
          valueType: editableTypes.has(description.type) ? description.type : "string",
          preview: description.preview,
          typeLabel: description.label,
        };
      });
  });
}

function renderBackends() {
  els.backendList.innerHTML = "";
  if (!state.backends.length) {
    state.backends.push({
      id: `backend-${Date.now()}`,
      name: "GPU 1",
      url: "http://localhost:8188",
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
  const gpuName = device?.name ? ` · ${device.name}` : "";
  return `Online · ${running} running · ${pending} pending${gpuName}`;
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
    els.inputList.textContent = "Upload a ComfyUI API workflow JSON to inspect editable inputs.";
    return;
  }
  if (!inputs.length) {
    els.inputList.textContent = "No matching inputs.";
    return;
  }

  for (const input of inputs) {
    const node = els.inputTemplate.content.firstElementChild.cloneNode(true);
    const toggle = node.querySelector(".vary-toggle");
    const valuesInput = node.querySelector(".values-input");
    const selected = state.selectedInputs.get(input.id);
    toggle.checked = Boolean(selected);
    valuesInput.disabled = !toggle.checked;
    valuesInput.value = selected?.values?.join("\n") || input.preview;
    node.querySelector(".input-title").textContent = `${input.nodeTitle} · ${input.inputName}`;
    node.querySelector(".input-meta").textContent = `${input.classType || "node"} #${input.nodeId} · ${input.typeLabel} · current: ${trim(input.preview, 120)}`;
    toggle.addEventListener("change", () => {
      if (toggle.checked) {
        state.selectedInputs.set(input.id, inputSelection(input, valuesInput.value));
      } else {
        state.selectedInputs.delete(input.id);
      }
      valuesInput.disabled = !toggle.checked;
      updateVariantCount();
      updateSubmitState();
    });
    valuesInput.addEventListener("input", () => {
      if (toggle.checked) state.selectedInputs.set(input.id, inputSelection(input, valuesInput.value));
      updateVariantCount();
    });
    els.inputList.append(node);
  }
}

function inputSelection(input, rawValue) {
  return {
    nodeId: input.nodeId,
    nodeTitle: input.nodeTitle,
    inputName: input.inputName,
    valueType: input.valueType,
    values: rawValue.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
  };
}

function updateVariantCount() {
  const selections = [...state.selectedInputs.values()];
  const total = selections.reduce((product, selection) => {
    const count = selection.values.filter(Boolean).length;
    return product * Math.max(count, 1);
  }, selections.length ? 1 : 0);
  els.variantCount.textContent = state.workflow ? String(Math.max(total, state.selectedInputs.size ? 0 : 1)) : "0";
}

function updateSubmitState() {
  const hasBackend = state.backends.some((backend) => backend.url);
  els.submitJobs.disabled = !state.workflow || !hasBackend;
}

function trim(value, limit) {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
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

async function submitJobs() {
  els.submitJobs.disabled = true;
  els.submitJobs.textContent = "Queueing...";
  try {
    const data = await api("/api/submit", {
      method: "POST",
      body: JSON.stringify({
        workflow: state.workflow,
        selections: [...state.selectedInputs.values()],
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
      ${assignments.map((item) => `<span class="assignment">${escapeHtml(item.nodeTitle)} · ${escapeHtml(item.inputName)} = ${escapeHtml(String(item.value))}</span>`).join("")}
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
    state.workflowName = file.name;
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
els.submitJobs.addEventListener("click", submitJobs);
els.refreshJobs.addEventListener("click", loadJobs);
els.clearDone.addEventListener("click", () => {
  state.hideDone = !state.hideDone;
  els.clearDone.textContent = state.hideDone ? "Show done" : "Hide done";
  renderJobs();
});

loadBackends();
loadJobs();
setInterval(loadJobs, 3500);
setInterval(refreshStatuses, 10000);
