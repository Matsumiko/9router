import { getLocalProxyNodes, updateLocalProxyNode } from "@/lib/db/index.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { checkLocalProxyNode, selectLocalProxyNode } from "@/lib/network/localProxyManager.js";

const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_ROTATION_INTERVAL_MINUTES = 30;
const DEFAULT_TEST_URL = "https://www.gstatic.com/generate_204";
const MAX_CONCURRENCY = 4;
const FAILOVER_THRESHOLD = 3;
const FAILOVER_COOLDOWN_MS = 5 * 60 * 1000;

const state = globalThis.__nineRouterLocalProxyHealthScheduler || {
  timer: null,
  running: false,
  lastRunAt: null,
  nextRunAt: null,
  lastResult: null,
  failures: new Map(),
  lastFailoverAt: 0,
  lastRotationAt: null,
  lastRotation: null,
};
globalThis.__nineRouterLocalProxyHealthScheduler = state;

function intervalMs(settings) {
  const minutes = Number(settings.localProxyAutoTestIntervalMinutes);
  return (Number.isFinite(minutes) ? Math.min(Math.max(minutes, 5), 120) : DEFAULT_INTERVAL_MINUTES) * 60 * 1000;
}

function rotationIntervalMs(settings) {
  const minutes = Number(settings.localProxyRotationIntervalMinutes);
  return (Number.isFinite(minutes) ? Math.min(Math.max(minutes, 15), 240) : DEFAULT_ROTATION_INTERVAL_MINUTES) * 60 * 1000;
}

function rotationStrategy(settings) {
  return ["periodic", "weighted"].includes(settings.localProxyRotationStrategy) ? settings.localProxyRotationStrategy : "failover";
}

async function testNode(node, testUrl) {
  try {
    const result = await checkLocalProxyNode(node.id, { testUrl });
    const failures = result.healthStatus === "healthy" ? 0 : (state.failures.get(node.id) || 0) + 1;
    state.failures.set(node.id, failures);
    if (result.healthStatus !== "healthy" && failures < FAILOVER_THRESHOLD) {
      return { ...await updateLocalProxyNode(node.id, { healthStatus: "degraded", lastError: result.lastError }), ...result, healthStatus: "degraded", consecutiveFailures: failures };
    }
    return { ...result, consecutiveFailures: failures };
  } catch (error) {
    const failures = (state.failures.get(node.id) || 0) + 1;
    state.failures.set(node.id, failures);
    return { ...node, healthStatus: failures < FAILOVER_THRESHOLD ? "degraded" : "unhealthy", lastError: error.message, consecutiveFailures: failures };
  }
}

async function testWithLimit(nodes, testUrl) {
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < nodes.length) {
      const node = nodes[cursor++];
      results.push(await testNode(node, testUrl));
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, nodes.length) }, worker));
  return results;
}

async function maybeFailover(results, settings) {
  if (!settings.localProxyAutoFailoverEnabled || !globalThis.__nineRouterLocalProxyState?.selectedNodeId) return null;
  const selectedId = globalThis.__nineRouterLocalProxyState.selectedNodeId;
  const selected = results.find((node) => node.id === selectedId);
  if (!selected || selected.healthStatus === "healthy" || (state.failures.get(selectedId) || 0) < FAILOVER_THRESHOLD) return null;
  if (Date.now() - state.lastFailoverAt < FAILOVER_COOLDOWN_MS) return null;
  const replacement = results.find((node) => node.id !== selectedId && node.enabled && node.healthStatus === "healthy");
  if (!replacement) return null;
  await selectLocalProxyNode(replacement.id);
  state.lastFailoverAt = Date.now();
  return { fromNodeId: selectedId, toNodeId: replacement.id };
}
function chooseRotationNode(results, strategy, selectedId) {
  const candidates = results.filter((node) => node.enabled && node.healthStatus === "healthy");
  if (candidates.length < 2) return null;
  if (strategy === "periodic") {
    const selectedIndex = candidates.findIndex((node) => node.id === selectedId);
    return candidates[(selectedIndex + 1 + candidates.length) % candidates.length];
  }
  const weighted = candidates.filter((node) => node.id !== selectedId).map((node) => ({ node, weight: 1 / Math.max(1, Number(node.latencyMs) || 1000) }));
  if (!weighted.length) return null;
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  let cursor = Math.random() * total;
  for (const item of weighted) { cursor -= item.weight; if (cursor <= 0) return item.node; }
  return weighted[weighted.length - 1].node;
}

async function maybeRotate(results, settings) {
  const strategy = rotationStrategy(settings);
  if (!settings.localProxyAutoTestEnabled || !["periodic", "weighted"].includes(strategy)) return null;
  if (!globalThis.__nineRouterLocalProxyState?.selectedNodeId || Date.now() - (state.lastRotationAt || 0) < rotationIntervalMs(settings)) return null;
  const selectedId = globalThis.__nineRouterLocalProxyState.selectedNodeId;
  const replacement = chooseRotationNode(results, strategy, selectedId);
  if (!replacement) return null;
  await selectLocalProxyNode(replacement.id);
  state.lastRotationAt = Date.now();
  state.lastRotation = { strategy, fromNodeId: selectedId, toNodeId: replacement.id };
  return state.lastRotation;
}

export async function runLocalProxyAutoHealthCheck() {
  if (state.running) return state.lastResult;
  const settings = await getSettings();
  if (!settings.localProxyAutoTestEnabled) return null;
  state.running = true;
  state.lastRunAt = new Date().toISOString();
  try {
    const nodes = await getLocalProxyNodes({ enabledOnly: true });
    const results = await testWithLimit(nodes, settings.localProxyAutoTestUrl || DEFAULT_TEST_URL);
    const failover = await maybeFailover(results, settings);
    const rotation = failover ? null : await maybeRotate(results, settings);
    state.lastResult = { testedNodes: results.length, healthyNodes: results.filter((node) => node.healthStatus === "healthy").length, unhealthyNodes: results.filter((node) => node.healthStatus !== "healthy").length, failover, rotation };
    return state.lastResult;
  } finally {
    state.running = false;
    state.nextRunAt = new Date(Date.now() + intervalMs(settings)).toISOString();
  }
}

export function stopLocalProxyAutoHealthCheck() {
  clearTimeout(state.timer);
  state.timer = null;
  state.nextRunAt = null;
}

export async function configureLocalProxyAutoHealthCheck(settings = null) {
  const current = settings || await getSettings();
  stopLocalProxyAutoHealthCheck();
  if (!current.localProxyAutoTestEnabled) return;
  const schedule = () => {
    state.timer = setTimeout(async () => {
      try { await runLocalProxyAutoHealthCheck(); } catch (error) { console.warn(`[LocalProxyAutoHealth] ${error.message}`); }
      const latest = await getSettings();
      if (latest.localProxyAutoTestEnabled) schedule();
    }, intervalMs(current));
    state.nextRunAt = new Date(Date.now() + intervalMs(current)).toISOString();
  };
  schedule();
}

export function getLocalProxyAutoHealthStatus() { return { running: state.running, lastRunAt: state.lastRunAt, nextRunAt: state.nextRunAt, lastResult: state.lastResult, lastRotationAt: state.lastRotationAt ? new Date(state.lastRotationAt).toISOString() : null, lastRotation: state.lastRotation }; }
