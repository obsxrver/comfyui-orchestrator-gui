const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { execFile } = require("child_process");
const { promisify } = require("util");

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, "public");
const CLIENT_ID = process.env.CLIENT_ID || `orchestrator-${Math.random().toString(36).slice(2)}`;
const execFileAsync = promisify(execFile);

const state = {
  backends: parseBackends(process.env.COMFY_BACKENDS || ""),
  jobs: [],
  eventClients: new Set(),
  comfySockets: new Map(),
  activePromptByBackend: new Map(),
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

function parseBackends(value) {
  if (!value.trim()) return [];
  return value
    .split(",")
    .map((item, index) => {
      const [namePart, urlPart] = item.includes("=") ? item.split("=") : [`GPU ${index + 1}`, item];
      return normalizeBackend({
        id: `backend-${index + 1}`,
        name: namePart.trim() || `GPU ${index + 1}`,
        url: (urlPart || "").trim(),
      });
    })
    .filter((backend) => backend.url);
}

function normalizeBackend(backend) {
  const rawUrl = String(backend.url || "").trim().replace(/\/+$/, "");
  return {
    id: backend.id || `backend-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: String(backend.name || rawUrl || "ComfyUI backend").trim(),
    url: rawUrl,
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sendEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastEvent(event, payload) {
  for (const client of state.eventClients) sendEvent(client, event, payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 80 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body) return {};
  return JSON.parse(body);
}

function getBackend(id) {
  return state.backends.find((backend) => backend.id === id);
}

async function comfyFetch(backend, route, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && typeof options.body === "string" && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(`${backend.url}${route}`, {
    ...options,
    headers,
  });

  const contentType = response.headers.get("content-type") || "";
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    const detail = contentType.includes("application/json")
      ? JSON.parse(buffer.toString("utf8"))
      : buffer.toString("utf8");
    const message = typeof detail === "string" ? detail : JSON.stringify(detail);
    throw new Error(`ComfyUI ${response.status}: ${message}`);
  }

  return { response, contentType, buffer };
}

async function getComfyJson(backend, route) {
  const { buffer } = await comfyFetch(backend, route);
  return JSON.parse(buffer.toString("utf8"));
}

function queueLoad(queue) {
  return (queue.queue_running || []).length + (queue.queue_pending || []).length;
}

async function getBackendLoads(backends) {
  const loads = new Map();
  await Promise.all(
    backends.map(async (backend) => {
      try {
        const queue = await getComfyJson(backend, "/queue");
        loads.set(backend.id, queueLoad(queue));
      } catch {
        loads.set(backend.id, Number.MAX_SAFE_INTEGER);
      }
    })
  );
  return loads;
}

function chooseLeastBusyBackend(backends, loads) {
  let best = backends[0];
  let bestLoad = loads.get(best.id) ?? 0;
  for (const backend of backends.slice(1)) {
    const load = loads.get(backend.id) ?? 0;
    if (load < bestLoad) {
      best = backend;
      bestLoad = load;
    }
  }
  loads.set(best.id, bestLoad + 1);
  return best;
}

function makeVariantPrompt(workflow, assignments) {
  const prompt = structuredClone(workflow);
  for (const assignment of assignments) {
    const node = prompt[assignment.nodeId];
    if (!node || !node.inputs) continue;
    node.inputs[assignment.inputName] = coerceValue(assignment.value, assignment.valueType);
  }
  return prompt;
}

function summarizeWorkflowNodes(workflow) {
  const labels = {};
  for (const [nodeId, node] of Object.entries(workflow || {})) {
    if (!node || typeof node !== "object") continue;
    const title = node._meta?.title || node.class_type || `Node ${nodeId}`;
    labels[nodeId] = `${title} #${nodeId}`;
  }
  return {
    labels,
    count: Object.keys(labels).length,
  };
}

async function detectCudaDevices() {
  try {
    const { stdout } = await execFileAsync("nvidia-smi", ["-L"], { timeout: 5000 });
    const devices = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^GPU\s+(\d+):\s+(.+?)(?:\s+\(UUID:\s+(.+?)\))?$/i);
        return match
          ? { index: Number(match[1]), name: match[2], uuid: match[3] || "" }
          : null;
      })
      .filter(Boolean);
    return { ok: true, devices };
  } catch (error) {
    const visible = String(process.env.CUDA_VISIBLE_DEVICES || "").trim();
    const devices = visible
      ? visible.split(",").map((item, index) => ({ index, name: `CUDA ${item.trim()}`, uuid: "" }))
      : [];
    return { ok: false, devices, error: error.message };
  }
}

function coerceValue(value, valueType) {
  if (valueType === "int") {
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) ? number : value;
  }
  if (valueType === "float" || valueType === "number") {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  if (valueType === "boolean") return value === true || value === "true";
  if (valueType === "json") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function crossProduct(groups) {
  return groups.reduce(
    (acc, group) => acc.flatMap((prefix) => group.map((item) => [...prefix, item])),
    [[]]
  );
}

function buildVariants(workflow, selections) {
  const groups = selections
    .map((selection) => {
      const values = selection.values.filter(hasVariantValue);
      return values.map((value) => ({
        nodeId: selection.nodeId,
        nodeTitle: selection.nodeTitle,
        inputName: selection.inputName,
        valueType: selection.valueType,
        kind: selection.kind,
        value,
      }));
    })
    .filter((group) => group.length > 0);

  if (!groups.length) {
    return [{ prompt: workflow, assignments: [] }];
  }

  return crossProduct(groups).map((assignments) => ({
    assignments,
  }));
}

function hasVariantValue(value) {
  if (value && typeof value === "object") return Boolean(value.dataUrl || value.value || value.name);
  return String(value).length > 0;
}

async function prepareAssignments(backend, assignments) {
  const prepared = [];
  for (const assignment of assignments) {
    if (assignment.kind === "image") {
      const uploaded = await uploadInputImage(backend, assignment.value);
      prepared.push({
        ...assignment,
        value: uploaded.workflowValue,
        displayValue: assignment.value.name || uploaded.workflowValue,
      });
    } else {
      prepared.push({
        ...assignment,
        displayValue: assignment.value,
      });
    }
  }
  return prepared;
}

async function uploadInputImage(backend, image) {
  if (!image || !image.dataUrl) throw new Error("Image upload value is missing file data.");
  const match = image.dataUrl.match(/^data:(.*?);base64,(.*)$/);
  if (!match) throw new Error("Image upload value is not a base64 data URL.");

  const mimeType = match[1] || image.type || "application/octet-stream";
  const bytes = Buffer.from(match[2], "base64");
  const fileName = safeFileName(image.name || `input-${Date.now()}.png`);
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: mimeType }), fileName);
  form.append("type", "input");
  form.append("subfolder", "orchestrator");
  form.append("overwrite", "true");

  const { buffer } = await comfyFetch(backend, "/upload/image", {
    method: "POST",
    body: form,
  });
  const result = JSON.parse(buffer.toString("utf8"));
  const name = result.name || fileName;
  const subfolder = result.subfolder || "orchestrator";
  return {
    workflowValue: subfolder ? `${subfolder}/${name}` : name,
  };
}

function safeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function publicAssignments(assignments) {
  return assignments.map((assignment) => ({
    nodeId: assignment.nodeId,
    nodeTitle: assignment.nodeTitle,
    inputName: assignment.inputName,
    kind: assignment.kind,
    value: assignment.displayValue ?? publicAssignmentValue(assignment.value),
  }));
}

function publicAssignmentValue(value) {
  if (value && typeof value === "object") return value.name || value.value || "[uploaded file]";
  return value;
}

function syncComfySockets() {
  const backendIds = new Set(state.backends.map((backend) => backend.id));
  for (const [backendId, connection] of state.comfySockets) {
    if (!backendIds.has(backendId)) closeComfySocket(backendId, connection);
  }
  for (const backend of state.backends) {
    const existing = state.comfySockets.get(backend.id);
    if (!existing || existing.closed) connectComfySocket(backend);
  }
}

function closeComfySocket(backendId, connection) {
  connection.closed = true;
  if (connection.retryTimer) clearTimeout(connection.retryTimer);
  if (connection.request) connection.request.destroy();
  if (connection.socket) connection.socket.destroy();
  state.comfySockets.delete(backendId);
}

function connectComfySocket(backend) {
  if (!backend.url) return;
  const backendUrl = new URL(backend.url);
  const isSecure = backendUrl.protocol === "https:";
  const key = crypto.randomBytes(16).toString("base64");
  const connection = { backendId: backend.id, closed: false, request: null, socket: null, retryTimer: null };
  state.comfySockets.set(backend.id, connection);

  const request = (isSecure ? https : http).request({
    protocol: backendUrl.protocol,
    hostname: backendUrl.hostname,
    port: backendUrl.port || (isSecure ? 443 : 80),
    path: `/ws?clientId=${encodeURIComponent(CLIENT_ID)}`,
    method: "GET",
    headers: {
      Host: backendUrl.host,
      Origin: backend.url,
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Key": key,
      "Sec-WebSocket-Version": "13",
    },
  });

  connection.request = request;
  request.on("upgrade", (_response, socket, head) => {
    connection.socket = socket;
    let buffer = head && head.length ? head : Buffer.alloc(0);
    socket.on("data", (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        buffer = consumeWebSocketFrames(buffer, socket, (message) => handleComfySocketMessage(backend, message));
      } catch {
        socket.destroy();
      }
    });
    socket.on("close", () => scheduleComfyReconnect(backend, connection));
    socket.on("error", () => scheduleComfyReconnect(backend, connection));
  });
  request.on("response", (response) => {
    response.resume();
    scheduleComfyReconnect(backend, connection);
  });
  request.on("error", () => scheduleComfyReconnect(backend, connection));
  request.end();
}

function scheduleComfyReconnect(backend, connection) {
  if (connection.closed) return;
  if (connection.retryTimer) return;
  connection.retryTimer = setTimeout(() => {
    state.comfySockets.delete(backend.id);
    syncComfySockets();
  }, 10000);
}

function consumeWebSocketFrames(buffer, socket, onText) {
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const bigLength = buffer.readBigUInt64BE(offset + 2);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame too large");
      length = Number(bigLength);
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + length;
    if (buffer.length - offset < frameLength) break;

    let payload = buffer.subarray(offset + headerLength + maskLength, offset + frameLength);
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }
    if (opcode === 1) onText(payload.toString("utf8"));
    if (opcode === 8) socket.destroy();
    if (opcode === 9) sendWebSocketFrame(socket, 10, payload);
    offset += frameLength;
  }
  return buffer.subarray(offset);
}

function sendWebSocketFrame(socket, opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || "");
  const mask = crypto.randomBytes(4);
  const header = data.length < 126
    ? Buffer.from([0x80 | opcode, 0x80 | data.length])
    : Buffer.from([0x80 | opcode, 0x80 | 126, data.length >> 8, data.length & 0xff]);
  const masked = Buffer.from(data.map((byte, index) => byte ^ mask[index % 4]));
  socket.write(Buffer.concat([header, mask, masked]));
}

function handleComfySocketMessage(backend, rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch {
    return;
  }
  const data = message.data || {};
  if (message.type === "executing" && data.prompt_id) {
    if (data.node === null) {
      updateJobLive(data.prompt_id, { status: "done", currentNode: "Complete", progress: { value: 1, max: 1 } });
    } else {
      state.activePromptByBackend.set(backend.id, data.prompt_id);
      updateJobLive(data.prompt_id, {
        status: "running",
        currentNodeId: data.node,
        currentNode: null,
      });
    }
  }
  if (message.type === "progress") {
    const promptId = data.prompt_id || state.activePromptByBackend.get(backend.id);
    if (promptId) {
      updateJobLive(promptId, {
        status: "running",
        currentNodeId: data.node,
        progress: Number(data.max) > 0 ? { value: Number(data.value || 0), max: Number(data.max) } : null,
      });
    }
  }
  if (message.type === "execution_error") {
    const promptId = data.prompt_id || state.activePromptByBackend.get(backend.id);
    if (promptId) updateJobLive(promptId, { status: "failed", error: data.exception_message || "Execution failed" });
  }
  broadcastEvent("comfy-message", { backendId: backend.id, message });
}

function updateJobLive(promptId, patch) {
  const job = state.jobs.find((item) => item.promptId === promptId);
  if (!job) return;
  const nodeId = patch.currentNodeId || job.currentNodeId;
  Object.assign(job, patch);
  if (nodeId && job.nodeLabels) job.currentNode = job.nodeLabels[nodeId] || `Node ${nodeId}`;
}

function summarizeOutputs(historyEntry, backend) {
  const outputs = [];
  const nodeOutputs = historyEntry?.outputs || {};
  for (const [nodeId, output] of Object.entries(nodeOutputs)) {
    for (const kind of ["images", "gifs"]) {
      for (const file of output[kind] || []) {
        const params = new URLSearchParams({
          filename: file.filename,
          subfolder: file.subfolder || "",
          type: file.type || "output",
          backendId: backend.id,
        });
        const isVideo = /\.(mp4|webm|mov|mkv)$/i.test(file.filename) || kind === "gifs";
        outputs.push({
          nodeId,
          kind: isVideo ? "video" : "image",
          filename: file.filename,
          url: `/api/view?${params.toString()}`,
        });
      }
    }
  }
  return outputs;
}

async function refreshJob(job) {
  if (job.status === "failed" || job.status === "done") return job;
  const backend = getBackend(job.backendId);
  if (!backend) {
    job.status = "failed";
    job.error = "Backend no longer exists";
    return job;
  }

  try {
    const history = await getComfyJson(backend, `/history/${encodeURIComponent(job.promptId)}`);
    const entry = history[job.promptId];
    if (entry) {
      job.status = "done";
      job.outputs = summarizeOutputs(entry, backend);
      job.completedAt = new Date().toISOString();
    } else {
      const queue = await getComfyJson(backend, "/queue");
      const running = queue.queue_running || [];
      const pending = queue.queue_pending || [];
      const queued = [...running, ...pending].some((item) => item[1] === job.promptId);
      job.status = queued ? "queued" : "submitted";
    }
  } catch (error) {
    job.lastPollError = error.message;
  }

  return job;
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    sendEvent(res, "hello", { clientId: CLIENT_ID });
    state.eventClients.add(res);
    syncComfySockets();
    req.on("close", () => state.eventClients.delete(res));
    return;
  }

  if (url.pathname === "/api/client" && req.method === "GET") {
    return sendJson(res, 200, { clientId: CLIENT_ID });
  }

  if (url.pathname === "/api/gpus" && req.method === "GET") {
    const result = await detectCudaDevices();
    return sendJson(res, 200, result);
  }

  if (url.pathname === "/api/backends/autolocal" && req.method === "POST") {
    const body = await readJson(req);
    const startPort = Number(body.startPort || 8189);
    const detected = await detectCudaDevices();
    const count = Math.max(0, Number(body.count || detected.devices.length || 0));
    state.backends = Array.from({ length: count }, (_, index) => {
      const device = detected.devices[index];
      return normalizeBackend({
        id: `backend-${index + 1}`,
        name: device?.name ? `GPU ${index + 1}: ${device.name}` : `GPU ${index + 1}`,
        url: `http://localhost:${startPort + index}`,
      });
    });
    syncComfySockets();
    return sendJson(res, 200, { backends: state.backends, gpus: detected });
  }

  if (url.pathname === "/api/backends" && req.method === "GET") {
    syncComfySockets();
    return sendJson(res, 200, { backends: state.backends });
  }

  if (url.pathname === "/api/backends" && req.method === "POST") {
    const body = await readJson(req);
    state.backends = (body.backends || []).map(normalizeBackend).filter((backend) => backend.url);
    syncComfySockets();
    return sendJson(res, 200, { backends: state.backends });
  }

  if (url.pathname === "/api/backends/status" && req.method === "GET") {
    const statuses = await Promise.all(
      state.backends.map(async (backend) => {
        try {
          const systemStats = await getComfyJson(backend, "/system_stats");
          const queue = await getComfyJson(backend, "/queue");
          return { backendId: backend.id, ok: true, systemStats, queue };
        } catch (error) {
          return { backendId: backend.id, ok: false, error: error.message };
        }
      })
    );
    return sendJson(res, 200, { statuses });
  }

  if (url.pathname === "/api/submit" && req.method === "POST") {
    const body = await readJson(req);
    const workflow = body.workflow;
    const selections = body.selections || [];
    const backendIds = body.backendIds || [];
    const backends = backendIds.map(getBackend).filter(Boolean);

    if (!workflow || typeof workflow !== "object") return sendJson(res, 400, { error: "A workflow JSON object is required." });
    if (!backends.length) return sendJson(res, 400, { error: "Choose at least one configured backend." });

    const variants = buildVariants(workflow, selections);
    const workflowNodes = summarizeWorkflowNodes(workflow);
    const backendLoads = await getBackendLoads(backends);
    const created = [];
    for (let index = 0; index < variants.length; index += 1) {
      const backend = chooseLeastBusyBackend(backends, backendLoads);
      const variant = variants[index];

      try {
        const preparedAssignments = await prepareAssignments(backend, variant.assignments);
        const payload = {
          prompt: makeVariantPrompt(workflow, preparedAssignments),
          client_id: CLIENT_ID,
        };
        const { buffer } = await comfyFetch(backend, "/prompt", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        const result = JSON.parse(buffer.toString("utf8"));
        const job = {
          id: `job-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          promptId: result.prompt_id,
          backendId: backend.id,
          backendName: backend.name,
          status: "queued",
          assignments: publicAssignments(preparedAssignments),
          nodeLabels: workflowNodes.labels,
          nodeCount: workflowNodes.count,
          currentNode: "",
          progress: null,
          outputs: [],
          createdAt: new Date().toISOString(),
        };
        state.jobs.unshift(job);
        created.push(job);
      } catch (error) {
        const job = {
          id: `failed-${Date.now()}-${index}`,
          backendId: backend.id,
          backendName: backend.name,
          status: "failed",
          error: error.message,
          assignments: publicAssignments(variant.assignments),
          outputs: [],
          createdAt: new Date().toISOString(),
        };
        state.jobs.unshift(job);
        created.push(job);
      }
    }

    return sendJson(res, 200, { jobs: created, totalVariants: variants.length });
  }

  if (url.pathname === "/api/jobs" && req.method === "GET") {
    await Promise.all(state.jobs.slice(0, 100).map(refreshJob));
    return sendJson(res, 200, { jobs: state.jobs });
  }

  if (url.pathname === "/api/view" && req.method === "GET") {
    const backend = getBackend(url.searchParams.get("backendId"));
    if (!backend) return sendText(res, 404, "Backend not found");
    const params = new URLSearchParams({
      filename: url.searchParams.get("filename") || "",
      subfolder: url.searchParams.get("subfolder") || "",
      type: url.searchParams.get("type") || "output",
    });
    try {
      const { response, contentType, buffer } = await comfyFetch(backend, `/view?${params.toString()}`);
      res.writeHead(200, {
        "content-type": contentType || response.headers.get("content-type") || "application/octet-stream",
        "cache-control": "public, max-age=3600",
      });
      return res.end(buffer);
    } catch (error) {
      return sendText(res, 502, error.message);
    }
  }

  return sendJson(res, 404, { error: "Unknown API route." });
}

function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendText(res, 403, "Forbidden");

  fs.readFile(filePath, (error, data) => {
    if (error) return sendText(res, 404, "Not found");
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "content-type": mimeTypes[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`ComfyUI orchestrator running at http://localhost:${PORT}`);
});
