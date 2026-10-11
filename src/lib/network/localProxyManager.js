import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { getDataDir } from "@/lib/dataDir";
import { getLocalProxyNodes, getProxySubscriptions, getLocalProxyNodeById, updateLocalProxyNode } from "@/lib/db/index.js";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { testProxyUrl } from "@/lib/network/proxyTest.js";
import { assertPublicUrlResolved } from "@/shared/utils/ssrfGuard.js";

const DEFAULT_PORT = 20129;
const HEALTH_URL = process.env.NINE_ROUTER_PROXY_TEST_URL || "https://www.gstatic.com/generate_204";
const state = globalThis.__nineRouterLocalProxyState || { process: null, pid: null, lastError: null, startedAt: null, selectedNodeId: null, rotationCursor: -1 };
globalThis.__nineRouterLocalProxyState = state;

function directory() { const dir = path.join(getDataDir(), "local-proxy"); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; }
function configPath() { return path.join(directory(), "sing-box.json"); }
function listenPort() { const value = Number(process.env.NINE_ROUTER_LOCAL_PROXY_PORT); return Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : DEFAULT_PORT; }
function executable() { return process.env.SING_BOX_BIN || process.env.SINGBOX_BIN || "sing-box"; }

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
  if (node.type === "vmess") return { ...base, uuid: node.uuid, alter_id: Number(node.alterId || 0), security: node.cipher || "auto", network: node.network || "tcp", tls: node.tls ? { enabled: true, server_name: node.host || node.server } : undefined };
  if (node.type === "vless") {
    const tls = node.params?.security === "tls" ? { enabled: true, server_name: node.params?.sni || node.server } : undefined;
    const transport = node.params?.type === "ws" ? { type: "ws", path: node.params?.path || "/", headers: node.params?.host ? { Host: node.params.host } : undefined } : undefined;
    return { ...base, uuid: node.uuid, network: node.params?.type === "ws" ? "tcp" : node.params?.type || "tcp", flow: node.params?.flow || undefined, tls, transport };
  }
  if (node.type === "trojan") return { ...base, password: node.password, tls: { enabled: true, server_name: node.params?.sni || node.server } };
  if (["http", "https"].includes(node.type)) return { ...base, type: "http", username: node.username || undefined, password: node.password || undefined, tls: node.type === "https" ? { enabled: true, server_name: node.server } : undefined };
  if (["socks5", "socks5h"].includes(node.type)) return { ...base, type: "socks", username: node.username || undefined, password: node.password || undefined };
  return null;
}

function render(config) {
  const outbounds = config.nodes.map(toOutbound).filter(Boolean);
  const selected = outbounds.find((outbound) => outbound.tag === config.selectedNodeId) || outbounds[0];
  return JSON.stringify({ log: { level: "warn" }, inbounds: [{ type: "mixed", tag: "proxy-in", listen: "127.0.0.1", listen_port: config.port }], outbounds: [...outbounds, { type: "direct", tag: "direct" }], route: { final: selected.tag } }, null, 2) + "\n";
}

async function buildConfig() {
  const nodes = await getLocalProxyNodes({ enabledOnly: true });
  const supported = nodes.filter((node) => toOutbound(node));
  if (!supported.length) throw new Error("No enabled supported sing-box proxy nodes");
  const config = { port: listenPort(), nodes: supported, selectedNodeId: state.selectedNodeId };
  fs.writeFileSync(configPath(), render(config), { mode: 0o600 });
  return { ...config, nodeCount: supported.length, path: configPath() };
}

function canConnect(port) { return new Promise((resolve) => { const socket = net.createConnection({ host: "127.0.0.1", port }); const finish = (value) => { socket.destroy(); resolve(value); }; socket.once("connect", () => finish(true)); socket.once("error", () => finish(false)); socket.setTimeout(250, () => finish(false)); }); }
async function waitForPort(port, child, timeoutMs = 10000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (await canConnect(port)) return; if (child.exitCode !== null) throw new Error(`sing-box exited with code ${child.exitCode ?? "unknown"}`); await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`sing-box did not listen on 127.0.0.1:${port}`); }
async function stopChild(child) { if (!child || child.exitCode !== null) return; await new Promise((resolve) => { const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000); child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM"); }); }

export async function getLocalProxyStatus() { const { getLocalProxyAutoHealthStatus } = await import("@/lib/network/localProxyHealthScheduler.js"); return { available: Boolean(process.env.SING_BOX_BIN || process.env.SINGBOX_BIN), runtime: "sing-box", running: Boolean(state.process && !state.process.killed), pid: state.pid, startedAt: state.startedAt, lastError: state.lastError, proxyUrl: `http://127.0.0.1:${listenPort()}`, configPath: configPath(), selectedNodeId: state.selectedNodeId, autoHealth: getLocalProxyAutoHealthStatus(), subscriptions: await getProxySubscriptions(), nodes: await getLocalProxyNodes() }; }
export async function selectLocalProxyNode(nodeId) { const node = await getLocalProxyNodeById(nodeId); if (!node) throw new Error("Local proxy node not found"); if (!node.enabled) throw new Error("Local proxy node is disabled"); state.selectedNodeId = nodeId; if (state.process && !state.process.killed) { await stopLocalProxy(); await startLocalProxy(); } return getLocalProxyStatus(); }
export async function rotateLocalProxyNode() { const nodes = (await getLocalProxyNodes({ enabledOnly: true })).filter((node) => node.healthStatus !== "unhealthy"); if (!nodes.length) throw new Error("No healthy enabled local proxy nodes"); state.rotationCursor = (state.rotationCursor + 1) % nodes.length; return selectLocalProxyNode(nodes[state.rotationCursor].id); }

export async function startLocalProxy() {
  if (state.process && !state.process.killed) return getLocalProxyStatus();
  const config = await buildConfig();
  const child = spawn(executable(), ["run", "-c", config.path], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  state.process = child; state.pid = child.pid; state.startedAt = new Date().toISOString(); state.lastError = null;
  child.on("error", (error) => { state.lastError = `Unable to start sing-box: ${error.message}`; state.process = null; state.pid = null; applyOutboundProxyEnv({ outboundProxyEnabled: false }); });
  child.stderr.on("data", (chunk) => { state.lastError = String(chunk).trim().slice(-1000); });
  child.on("exit", (code) => { if (state.process === child) { state.process = null; state.pid = null; if (code !== 0) state.lastError = `sing-box exited with code ${code ?? "unknown"}`; } });
  try { await waitForPort(config.port, child); } catch (error) { await stopChild(child); state.process = null; state.pid = null; state.lastError = error.message; throw error; }
  child.unref(); applyOutboundProxyEnv({ outboundProxyEnabled: true, outboundProxyUrl: `http://127.0.0.1:${config.port}`, outboundNoProxy: "127.0.0.1,localhost" }); return getLocalProxyStatus();
}
export async function stopLocalProxy() { await stopChild(state.process); state.process = null; state.pid = null; applyOutboundProxyEnv({ outboundProxyEnabled: false }); return getLocalProxyStatus(); }
export async function rebuildLocalProxyConfig() { const config = await buildConfig(); return { ...config, json: fs.readFileSync(config.path, "utf8") }; }

export async function checkLocalProxyNode(nodeId, { testUrl = HEALTH_URL } = {}) {
  const node = await getLocalProxyNodeById(nodeId); if (!node) throw new Error("Local proxy node not found");
  let targetUrl;
  try { targetUrl = new URL(String(testUrl || HEALTH_URL)); if (!["http:", "https:"].includes(targetUrl.protocol) || targetUrl.username || targetUrl.password) throw new Error("Health URL must be a public HTTP(S) URL"); await assertPublicUrlResolved(targetUrl.toString()); } catch (error) { throw new Error(error.message || "Invalid health URL"); }
  const outbound = toOutbound(node); if (!outbound) throw new Error("Node type is not supported by sing-box");
  const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolve(value)); }); });
  const healthPath = path.join(directory(), `health-${node.id}.json`);
  const healthConfig = { log: { level: "error" }, inbounds: [{ type: "mixed", tag: "proxy-in", listen: "127.0.0.1", listen_port: port }], outbounds: [outbound, { type: "direct", tag: "direct" }], route: { final: outbound.tag } };
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
