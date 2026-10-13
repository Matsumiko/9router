import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { getDataDir } from "@/lib/dataDir";
import { getLocalProxyNodes, getProxySubscriptions, getLocalProxyNodeById, updateLocalProxyNode } from "@/lib/db/index.js";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { testProxyUrl } from "@/lib/network/proxyTest.js";
import { assertPublicUrlResolved } from "@/shared/utils/ssrfGuard.js";
import { getRuntimeFingerprint } from "@/lib/runtimeFingerprint.js";
const DEFAULT_PORT = 20129;
const HEALTH_URL = process.env.NINE_ROUTER_PROXY_TEST_URL || "https://www.gstatic.com/generate_204";
const CONTROLLER_PORT = Number(process.env.NINE_ROUTER_LOCAL_PROXY_CONTROLLER_PORT) || 20130;
const state = globalThis.__nineRouterLocalProxyState || { process: null, pid: null, lastError: null, startedAt: null, selectedNodeId: null, rotationCursor: -1, requestFailoverPromise: null };
globalThis.__nineRouterLocalProxyState = state;
state.requestFailoverEvidence ||= [];
state.requestFailoverCount ||= 0;

function safeFailoverReason(value) {
  return String(value || "unknown")
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .slice(0, 500);
}

function recordRequestFailoverEvidence(context, fromNodeId, toNodeId, switched, reason) {
  const evidence = {
    at: new Date().toISOString(),
    target: context?.target || "unknown",
    fromNodeId: fromNodeId || null,
    toNodeId: toNodeId || null,
    attempt: Number(context?.attempt) || 1,
    phase: context?.phase || "response_headers",
    reason: safeFailoverReason(reason),
    directFallbackAllowed: context?.directFallbackAllowed === true,
    switched: switched === true,
  };
  state.requestFailoverCount += 1;
  state.requestFailoverEvidence.push(evidence);
  if (state.requestFailoverEvidence.length > 50) state.requestFailoverEvidence.splice(0, state.requestFailoverEvidence.length - 50);
  return evidence;
}

function directory() { const dir = path.join(getDataDir(), "local-proxy"); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; }
function configPath() { return path.join(directory(), "sing-box.json"); }
function pidPath() { return path.join(directory(), "sing-box.pid"); }
function listenPort() { const value = Number(process.env.NINE_ROUTER_LOCAL_PROXY_PORT); return Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : DEFAULT_PORT; }
function isExecutable(candidate) { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } }
function executable() {
  const configured = process.env.SING_BOX_BIN || process.env.SINGBOX_BIN;
  const candidates = [];
  if (configured) candidates.push(configured);
  for (const directory of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) candidates.push(path.join(directory, "sing-box"));
  if (process.env.HOME) candidates.push(path.join(process.env.HOME, ".local", "bin", "sing-box"));
  candidates.push("/usr/local/bin/sing-box", "/usr/bin/sing-box", "/bin/sing-box");
  return candidates.find((candidate) => isExecutable(candidate)) || null;
}
function missingExecutableError() { return new Error("sing-box binary not found. Install sing-box or set SING_BOX_BIN to its executable path."); }
function processCommandLine(pid) { try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " "); } catch { return ""; } }
function isManagedProcess(pid, expectedConfigPath) { const command = processCommandLine(pid); return command.includes("sing-box") && command.includes(" run ") && command.includes(expectedConfigPath); }
function processIsAlive(pid) { try { process.kill(Number(pid), 0); return true; } catch { return false; } }
function findManagedProcess(expectedConfigPath) {
  const candidates = [];
  try { candidates.push(fs.readFileSync(pidPath(), "utf8").trim()); } catch {}
  try { candidates.push(...fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))); } catch {}
  for (const candidate of [...new Set(candidates)]) {
    const pid = Number(candidate);
    if (Number.isInteger(pid) && pid > 0 && processIsAlive(pid) && isManagedProcess(pid, expectedConfigPath)) return pid;
  }
  try { fs.unlinkSync(pidPath()); } catch {}
  return null;
}
function writePidFile(pid) { fs.writeFileSync(pidPath(), `${pid}\n`, { mode: 0o600 }); }
function clearPidFile(pid) { try { if (!pid || fs.readFileSync(pidPath(), "utf8").trim() === String(pid)) fs.unlinkSync(pidPath()); } catch {} }
function formatSingBoxStartupError(stderr, fallback) { const detail = String(stderr || "").trim(); return detail || String(fallback || "sing-box failed to start"); }
function buildStreamSettings(params = {}, { tlsEnabled = false, defaultSni = "" } = {}) {
  const network = params.type === "h2" ? "http" : (params.type || "tcp");
  const pathValue = params.path || "";
  const host = params.host || "";
  const transport = network === "ws"
    ? { type: "ws", ...(pathValue ? { path: pathValue.split("?ed=")[0] || "/" } : { path: "/" }), ...(host ? { headers: { Host: host } } : {}), ...(Number(new URLSearchParams(pathValue.split("?")[1] || "").get("ed")) > 0 ? { max_early_data: Number(new URLSearchParams(pathValue.split("?")[1]).get("ed")), early_data_header_name: "Sec-WebSocket-Protocol" } : {}) }
    : network === "grpc"
      ? { type: "grpc", ...(params.serviceName || pathValue ? { service_name: params.serviceName || pathValue } : {}) }
      : network === "http"
        ? { type: "http", ...(pathValue ? { path: pathValue } : {}), ...(host ? { host: host.split(",").filter(Boolean) } : {}) }
        : network === "httpupgrade"
          ? { type: "httpupgrade", ...(pathValue ? { path: pathValue } : {}), ...(host ? { host } : {}) }
          : network === "tcp" && params.headerType === "http"
            ? { type: "http", method: "GET", path: pathValue || "/", ...(host ? { headers: { Host: host } } : {}) }
            : null;
  const security = params.security || (tlsEnabled ? "tls" : "");
  const tls = security === "tls" || security === "reality" || tlsEnabled
    ? { enabled: true, ...(params.allowInsecure === "1" || params.allowInsecure === "true" ? { insecure: true } : {}), ...(params.sni || params.peer || defaultSni ? { server_name: params.sni || params.peer || defaultSni } : {}), ...(params.alpn ? { alpn: params.alpn.split(",").filter(Boolean) } : {}), ...(security === "reality" && params.pbk ? { reality: { enabled: true, public_key: params.pbk, ...(params.sid ? { short_id: params.sid.split(",")[0] } : {}) } } : {}), ...(params.fp ? { utls: { enabled: true, fingerprint: params.fp } } : {}) }
    : undefined;
  return { ...(transport ? { transport } : {}), ...(tls ? { tls } : {}) };
}

function toOutbound(node) {
  if (node.outbound && typeof node.outbound === "object") {
    const outbound = { ...node.outbound, tag: node.id };
    if (outbound.type === "shadowsocks" && outbound.plugin && !outbound.plugin_opts) {
      const [plugin, ...options] = String(outbound.plugin).split(";");
      outbound.plugin = plugin;
      outbound.plugin_opts = options.join(";") || undefined;
    }
    return outbound;
  }
  const base = { tag: node.id || node.name, type: node.type, server: node.server, server_port: node.port };
  if (node.type === "vmess") {
    const params = { ...(node.params || {}), type: node.network || node.params?.type || "tcp", path: node.path || node.params?.path || "", host: node.host || node.params?.host || "", sni: node.sni || node.params?.sni || "", security: node.params?.security || (node.tls ? "tls" : "") };
    return { ...base, uuid: node.uuid, alter_id: Number(node.alterId || 0), security: node.cipher || "auto", ...buildStreamSettings(params, { defaultSni: node.sni || node.host || node.server }) };
  }
  if (node.type === "vless") {
    const params = node.params || {};
    return { ...base, uuid: node.uuid, flow: params.flow && params.flow !== "none" ? params.flow.replace(/-udp443$/, "") : undefined, ...buildStreamSettings(params, { defaultSni: node.server }) };
  }
  if (node.type === "trojan") return { ...base, password: node.password, ...buildStreamSettings(node.params || {}, { tlsEnabled: true, defaultSni: node.server }) };
  if (["http", "https"].includes(node.type)) return { ...base, type: "http", username: node.username || undefined, password: node.password || undefined, ...(node.type === "https" ? { tls: { enabled: true, server_name: node.server } } : {}) };
  if (["socks5", "socks5h"].includes(node.type)) return { ...base, type: "socks", username: node.username || undefined, password: node.password || undefined };
  return null;
}

function render(config) {
  const outbounds = config.nodes.map(toOutbound).filter(Boolean);
  const nodeTags = outbounds.map((outbound) => outbound.tag);
  const selectedTag = nodeTags.includes(config.selectedNodeId) ? config.selectedNodeId : nodeTags[0];
  return JSON.stringify({
    log: { level: "warn" },
    dns: { strategy: "ipv4_only" },
    experimental: { clash_api: { external_controller: `127.0.0.1:${CONTROLLER_PORT}` } },
    inbounds: [{ type: "mixed", tag: "proxy-in", listen: "127.0.0.1", listen_port: config.port }],
    outbounds: [...outbounds, { type: "selector", tag: "proxy-auto", outbounds: nodeTags, default: selectedTag }, { type: "direct", tag: "direct" }],
    route: { rules: [{ domain: ["oauth2.googleapis.com", "www.googleapis.com"], outbound: "direct" }], final: "proxy-auto" },
  }, null, 2) + "\n";
}

async function buildConfig() {
  const nodes = await getLocalProxyNodes({ enabledOnly: true });
  const supported = nodes.filter((node) => toOutbound(node));
  if (!supported.length) throw new Error("No enabled supported sing-box proxy nodes");
  const selectedNodeId = state.selectedNodeId && supported.some((node) => node.id === state.selectedNodeId) ? state.selectedNodeId : supported[0].id;
  state.selectedNodeId = selectedNodeId;
  const config = { port: listenPort(), nodes: supported, selectedNodeId };
  fs.writeFileSync(configPath(), render(config), { mode: 0o600 });
  return { ...config, nodeCount: supported.length, path: configPath() };
}

function canConnect(port) { return new Promise((resolve) => { const socket = net.createConnection({ host: "127.0.0.1", port }); const finish = (value) => { socket.destroy(); resolve(value); }; socket.once("connect", () => finish(true)); socket.once("error", () => finish(false)); socket.setTimeout(250, () => finish(false)); }); }
async function waitForPort(port, child, timeoutMs = 10000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (await canConnect(port)) return; if (child.exitCode !== null) throw new Error(formatSingBoxStartupError(child.stderrText, `sing-box exited with code ${child.exitCode ?? "unknown"}`)); await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(formatSingBoxStartupError(child.stderrText, `sing-box did not listen on 127.0.0.1:${port}`)); }
async function stopChild(child) { if (!child || child.exitCode !== null) return; if (child.adopted) { try { process.kill(child.pid, "SIGTERM"); } catch {} child.killed = true; child.exitCode = 0; clearPidFile(child.pid); return; } await new Promise((resolve) => { const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000); child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM"); }); }
function setRunningLocalProxyNode(nodeId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ name: nodeId });
    const request = http.request({ hostname: "127.0.0.1", port: CONTROLLER_PORT, path: "/proxies/proxy-auto", method: "PUT", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (response) => {
      response.resume();
      if (response.statusCode >= 200 && response.statusCode < 300) resolve();
      else reject(new Error(`sing-box selector update failed with HTTP ${response.statusCode}`));
    });
    request.setTimeout(1000, () => request.destroy(new Error("sing-box selector API timeout")));
    request.once("error", reject);
    request.end(body);
  });
}


export async function getLocalProxyStatus() { const { getLocalProxyAutoHealthStatus } = await import("@/lib/network/localProxyHealthScheduler.js"); const binaryPath = executable(); return { available: Boolean(binaryPath), binaryPath, runtime: "sing-box", running: Boolean(state.process && !state.process.killed), pid: state.pid, startedAt: state.startedAt, lastError: state.lastError, proxyUrl: `http://127.0.0.1:${listenPort()}`, configPath: configPath(), selectedNodeId: state.selectedNodeId, requestFailoverCount: state.requestFailoverCount, requestFailoverEvidence: state.requestFailoverEvidence, autoHealth: getLocalProxyAutoHealthStatus(), runtimeFingerprint: getRuntimeFingerprint(), subscriptions: await getProxySubscriptions(), nodes: await getLocalProxyNodes() }; }
export async function selectLocalProxyNode(nodeId, { restart = true } = {}) { const node = await getLocalProxyNodeById(nodeId); if (!node) throw new Error("Local proxy node not found"); if (!node.enabled) throw new Error("Local proxy node is disabled"); const previousNodeId = state.selectedNodeId; state.selectedNodeId = nodeId; if (state.process && !state.process.killed) { try { await setRunningLocalProxyNode(nodeId); } catch (error) { if (!restart) { state.selectedNodeId = previousNodeId; throw error; } await stopLocalProxy(); await startLocalProxy(); } } return getLocalProxyStatus(); }
async function failoverLocalProxyNode(errorMessage, excludedNodeIds = [], context = null) {
  if (state.requestFailoverPromise) return state.requestFailoverPromise;
  state.requestFailoverPromise = (async () => {
    const excluded = new Set(excludedNodeIds);
    if (state.selectedNodeId) excluded.add(state.selectedNodeId);
    const nodes = await getLocalProxyNodes({ enabledOnly: true });
    const candidates = nodes
      .filter((node) => !excluded.has(node.id) && node.healthStatus !== "unhealthy" && toOutbound(node))
      .sort((left, right) => {
        const healthRank = (node) => node.healthStatus === "healthy" ? 0 : node.healthStatus === "degraded" ? 1 : 2;
        return healthRank(left) - healthRank(right) || (Number(left.latencyMs) || 100000) - (Number(right.latencyMs) || 100000);
      });
    if (!candidates.length) {
      const evidence = recordRequestFailoverEvidence(context, state.selectedNodeId, null, false, "no eligible proxy node");
      return { switched: false, reason: "no eligible proxy node", evidence };
    }
    const previousNodeId = state.selectedNodeId;
    try {
      await selectLocalProxyNode(candidates[0].id, { restart: false });
      if (previousNodeId) await updateLocalProxyNode(previousNodeId, { healthStatus: "degraded", lastError: errorMessage });
      const evidence = recordRequestFailoverEvidence(context, previousNodeId, candidates[0].id, true, errorMessage);
      return { switched: true, nodeId: candidates[0].id, evidence };
    } catch (error) {
      const evidence = recordRequestFailoverEvidence(context, previousNodeId, candidates[0].id, false, error.message);
      return { switched: false, reason: error.message, evidence };
    }
  })().finally(() => { state.requestFailoverPromise = null; });
  return state.requestFailoverPromise;
}
globalThis.__nineRouterRequestProxyFailover = (errorMessage, excludedNodeIds, context) =>
  failoverLocalProxyNode(errorMessage, excludedNodeIds, context);


export async function rotateLocalProxyNode() { const nodes = (await getLocalProxyNodes({ enabledOnly: true })).filter((node) => node.healthStatus !== "unhealthy"); if (!nodes.length) throw new Error("No healthy enabled local proxy nodes"); state.rotationCursor = (state.rotationCursor + 1) % nodes.length; return selectLocalProxyNode(nodes[state.rotationCursor].id); }
export async function startLocalProxy() {
  if (state.process && !state.process.killed) return getLocalProxyStatus();
  const binaryPath = executable();
  if (!binaryPath) throw missingExecutableError();
  const config = await buildConfig();
  const existingPid = findManagedProcess(config.path);
  if (existingPid) {
    state.process = { adopted: true, pid: existingPid, exitCode: null, killed: false };
    state.pid = existingPid;
    state.startedAt = null;
    state.lastError = null;
    await waitForPort(config.port, state.process);
    await waitForPort(CONTROLLER_PORT, state.process, 3000);
    applyOutboundProxyEnv({ outboundProxyEnabled: true, outboundProxyUrl: `http://127.0.0.1:${config.port}`, outboundNoProxy: "127.0.0.1,localhost" });
    return getLocalProxyStatus();
  }
  const child = spawn(binaryPath, ["run", "-c", config.path], { detached: false, stdio: ["ignore", "pipe", "pipe"] });
  child.stderrText = "";
  state.process = child; state.pid = child.pid; state.startedAt = new Date().toISOString(); state.lastError = null;
  writePidFile(child.pid);
  child.on("error", (error) => { state.lastError = `Unable to start sing-box: ${error.message}`; state.process = null; state.pid = null; clearPidFile(child.pid); applyOutboundProxyEnv({ outboundProxyEnabled: false }); });
  child.stderr.on("data", (chunk) => { child.stderrText = `${child.stderrText}${String(chunk)}`.slice(-2000); state.lastError = child.stderrText.trim(); });
  child.on("exit", (code) => { clearPidFile(child.pid); if (state.process === child) { state.process = null; state.pid = null; if (code !== 0 && !state.lastError) state.lastError = formatSingBoxStartupError(child.stderrText, `sing-box exited with code ${code ?? "unknown"}`); } });
  try { await waitForPort(config.port, child); await waitForPort(CONTROLLER_PORT, child, 3000); } catch (error) { await stopChild(child); state.process = null; state.pid = null; state.lastError = formatSingBoxStartupError(child.stderrText, error.message); clearPidFile(child.pid); throw new Error(state.lastError); }
  applyOutboundProxyEnv({ outboundProxyEnabled: true, outboundProxyUrl: `http://127.0.0.1:${config.port}`, outboundNoProxy: "127.0.0.1,localhost" }); return getLocalProxyStatus();
}
export async function stopLocalProxy() { await stopChild(state.process); state.process = null; state.pid = null; clearPidFile(); applyOutboundProxyEnv({ outboundProxyEnabled: false }); return getLocalProxyStatus(); }
export async function rebuildLocalProxyConfig() { const config = await buildConfig(); return { ...config, json: fs.readFileSync(config.path, "utf8") }; }

export async function checkLocalProxyNode(nodeId, { testUrl = HEALTH_URL } = {}) {
  const node = await getLocalProxyNodeById(nodeId); if (!node) throw new Error("Local proxy node not found");
  let targetUrl;
  try { targetUrl = new URL(String(testUrl || HEALTH_URL)); if (!["http:", "https:"].includes(targetUrl.protocol) || targetUrl.username || targetUrl.password) throw new Error("Health URL must be a public HTTP(S) URL"); await assertPublicUrlResolved(targetUrl.toString()); } catch (error) { throw new Error(error.message || "Invalid health URL"); }
  const outbound = toOutbound(node); if (!outbound) throw new Error("Node type is not supported by sing-box");
  const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolve(value)); }); });
  const healthPath = path.join(directory(), `health-${node.id}.json`);
  const healthConfig = { log: { level: "error" }, dns: { strategy: "ipv4_only" }, inbounds: [{ type: "mixed", tag: "proxy-in", listen: "127.0.0.1", listen_port: port }], outbounds: [outbound, { type: "direct", tag: "direct" }], route: { final: outbound.tag } };
  fs.writeFileSync(healthPath, JSON.stringify(healthConfig, null, 2) + "\n", { mode: 0o600 });
  const started = Date.now(); let child; let stderr = "";
  try {
    child = spawn(executable(), ["run", "-c", healthPath], { stdio: ["ignore", "ignore", "pipe"] }); child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-1000); });
    await waitForPort(port, child); const probe = await testProxyUrl({ proxyUrl: `http://127.0.0.1:${port}`, testUrl: targetUrl.toString(), timeoutMs: 8000 });
    const result = { healthStatus: probe.ok ? "healthy" : "degraded", latencyMs: Date.now() - started, lastCheckedAt: new Date().toISOString(), lastError: probe.ok ? null : probe.error || `Health URL returned HTTP ${probe.status}` };
    if (!probe.ok && stderr) result.lastError = `${result.lastError}: ${stderr.trim()}`.slice(0, 1000);
    return { ...await updateLocalProxyNode(nodeId, result), ...result, healthUrl: targetUrl.toString() };
  } catch (error) { const result = { healthStatus: "unhealthy", latencyMs: null, lastCheckedAt: new Date().toISOString(), lastError: error.message }; return { ...await updateLocalProxyNode(nodeId, result), ...result, healthUrl: targetUrl.toString() }; }
  finally { await stopChild(child); try { fs.unlinkSync(healthPath); } catch {} }
}
