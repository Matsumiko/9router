import { afterEach, describe, expect, it, vi } from "vitest";

const nodes = {
  a: { id: "node-a", name: "Node A", type: "http", server: "a.test", port: 8080, enabled: true, healthStatus: "healthy", latencyMs: 10 },
  b: { id: "node-b", name: "Node B", type: "http", server: "b.test", port: 8081, enabled: true, healthStatus: "healthy", latencyMs: 20 },
};

const mocks = vi.hoisted(() => ({
  getLocalProxyNodes: vi.fn(),
  getLocalProxyNodeById: vi.fn(),
  updateLocalProxyNode: vi.fn(async (id, patch) => ({ id, ...patch })),
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(async (id, patch) => ({ id, ...patch })),
  resolveConnectionProxyConfig: vi.fn(),
  testProxyUrl: vi.fn(),
}));

vi.mock("@/lib/dataDir", () => ({ getDataDir: () => "/tmp/9router-failover-test" }));
vi.mock("@/lib/db/index.js", () => ({
  getLocalProxyNodes: mocks.getLocalProxyNodes,
  getProxySubscriptions: vi.fn(async () => []),
  getLocalProxyNodeById: mocks.getLocalProxyNodeById,
  updateLocalProxyNode: mocks.updateLocalProxyNode,
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  resolveProviderConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("@/lib/network/proxyTest.js", () => ({ testProxyUrl: mocks.testProxyUrl }));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrlResolved: vi.fn() }));
vi.mock("@/lib/runtimeFingerprint.js", () => ({ getRuntimeFingerprint: () => ({ buildIdentity: "test" }) }));
vi.mock("@/lib/network/localProxyHealthScheduler.js", () => ({ getLocalProxyAutoHealthStatus: () => ({ running: false }) }));

async function loadManager(selectedNodeId, enabledNodes) {
  vi.resetModules();
  delete globalThis.__nineRouterLocalProxyState;
  mocks.getLocalProxyNodes.mockResolvedValue(enabledNodes);
  mocks.getLocalProxyNodeById.mockImplementation(async (id) => enabledNodes.find((node) => node.id === id) || null);
  const manager = await import("../../src/lib/network/localProxyManager.js");
  globalThis.__nineRouterLocalProxyState.selectedNodeId = selectedNodeId;
  return manager;
}

afterEach(() => {
  delete globalThis.__nineRouterRequestProxyFailover;
  delete globalThis.__nineRouterLocalProxyState;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("sing-box startup diagnostics", () => {
  it("preserves the runtime stderr when sing-box exits before binding", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const fakeBinary = "/tmp/9router-failover-test/proxy-fails";
    fs.mkdirSync(path.dirname(fakeBinary), { recursive: true });
    fs.writeFileSync(fakeBinary, "#!/bin/sh\necho 'FATAL start inbound: bind: address already in use' >&2\nexit 1\n", { mode: 0o700 });
    vi.resetModules();
    vi.stubEnv("SING_BOX_BIN", fakeBinary);
    vi.stubEnv("NINE_ROUTER_LOCAL_PROXY_PORT", "29129");
    vi.stubEnv("NINE_ROUTER_LOCAL_PROXY_CONTROLLER_PORT", "29130");
    mocks.getLocalProxyNodes.mockResolvedValue([nodes.a]);
    const manager = await import("../../src/lib/network/localProxyManager.js");

    await expect(manager.startLocalProxy()).rejects.toThrow("address already in use");
    expect(globalThis.__nineRouterLocalProxyState.lastError).toContain("address already in use");
    fs.rmSync(fakeBinary, { force: true });
  });
});
  it("rebuilds the sidecar when the running selector lacks the failover candidate", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const fakeBinary = "/tmp/9router-failover-test/proxy-selector-stale";
    const marker = "/tmp/9router-failover-test/selector-restarted";
    fs.mkdirSync(path.dirname(fakeBinary), { recursive: true });
    fs.rmSync(marker, { force: true });
    fs.writeFileSync(fakeBinary, `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const marker = ${JSON.stringify(marker)};
const restarted = fs.existsSync(marker);
const inbound = net.createServer((socket) => socket.destroy());
const controller = http.createServer((request, response) => {
  if (request.method === "PUT" && !restarted) {
    fs.writeFileSync(marker, "restarted");
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "Selector update error: not found" }));
    return;
  }
  response.writeHead(204);
  response.end();
});
inbound.listen(29129, "127.0.0.1");
controller.listen(29130, "127.0.0.1");
process.on("SIGTERM", () => {
  inbound.close();
  controller.close(() => process.exit(0));
});
`, { mode: 0o700 });

    vi.resetModules();
    vi.stubEnv("SING_BOX_BIN", fakeBinary);
    vi.stubEnv("NINE_ROUTER_LOCAL_PROXY_PORT", "29129");
    vi.stubEnv("NINE_ROUTER_LOCAL_PROXY_CONTROLLER_PORT", "29130");
    mocks.getLocalProxyNodes.mockResolvedValue([nodes.a, nodes.b]);
    mocks.getLocalProxyNodeById.mockImplementation(async (id) => [nodes.a, nodes.b].find((node) => node.id === id) || null);
    const manager = await import("../../src/lib/network/localProxyManager.js");
    globalThis.__nineRouterLocalProxyState.selectedNodeId = "node-a";

    try {
      await manager.startLocalProxy();
      const result = await globalThis.__nineRouterRequestProxyFailover("selector is stale", ["node-a"], { target: "https://upstream.test", attempt: 1, phase: "tcp_connect", directFallbackAllowed: false });

      expect(result).toMatchObject({ switched: true, nodeId: "node-b" });
      expect(globalThis.__nineRouterLocalProxyState.selectedNodeId).toBe("node-b");
      expect(fs.existsSync(marker)).toBe(true);
    } finally {
      await manager.stopLocalProxy();
      fs.rmSync(fakeBinary, { force: true });
      fs.rmSync(marker, { force: true });
    }
  });

describe("synthetic Local Proxy request failover", () => {
  it("switches from failed node A to healthy node B and records evidence", async () => {
    await loadManager("node-a", [nodes.a, nodes.b]);

    const result = await globalThis.__nineRouterRequestProxyFailover(
      "ECONNRESET from node A",
      ["node-a"],
      { target: "https://upstream.test", attempt: 1, phase: "tcp_connect", directFallbackAllowed: false },
    );

    expect(result).toMatchObject({ switched: true, nodeId: "node-b" });
    expect(mocks.updateLocalProxyNode).toHaveBeenCalledWith("node-a", {
      healthStatus: "degraded",
      lastError: "ECONNRESET from node A",
    });
    expect(result.evidence).toMatchObject({
      target: "https://upstream.test",
      fromNodeId: "node-a",
      toNodeId: "node-b",
      attempt: 1,
      phase: "tcp_connect",
      directFallbackAllowed: false,
      switched: true,
    });
  });

  it("stops without switching when all candidates are unavailable", async () => {
    await loadManager("node-a", [nodes.a]);

    const result = await globalThis.__nineRouterRequestProxyFailover(
      "connect timeout",
      ["node-a"],
      { target: "https://upstream.test", attempt: 3, phase: "response_headers", directFallbackAllowed: false },
    );

    expect(result).toMatchObject({ switched: false, reason: "no eligible proxy node" });
    expect(result.evidence).toMatchObject({
      fromNodeId: "node-a",
      toNodeId: null,
      attempt: 3,
      phase: "response_headers",
      directFallbackAllowed: false,
      switched: false,
    });
    expect(mocks.updateLocalProxyNode).not.toHaveBeenCalled();
  });
});

describe("proxyAwareFetch Local Proxy transport failover", () => {
  it("fails TCP on node A, retries through node B, and records request evidence", async () => {
    vi.resetModules();
    vi.stubEnv("NINE_ROUTER_LOCAL_PROXY_PORT", "20129");
    delete globalThis.__nineRouterLocalProxyState;
    delete globalThis.__nineRouterRequestProxyFailover;
    mocks.getLocalProxyNodes.mockResolvedValue([nodes.a, nodes.b]);
    mocks.getLocalProxyNodeById.mockImplementation(async (id) => [nodes.a, nodes.b].find((node) => node.id === id) || null);

    const manager = await import("../../src/lib/network/localProxyManager.js");
    globalThis.__nineRouterLocalProxyState.selectedNodeId = "node-a";

    const target = "http://upstream.test/v1/models";
    const fetchMock = vi.fn(async (url, options) => {
      expect(url).toBe(target);
      expect(options?.method).toBe("POST");
      if (globalThis.__nineRouterLocalProxyState.selectedNodeId === "node-a") {
        throw Object.assign(new TypeError("connect ECONNREFUSED 127.0.0.1:8080"), { code: "ECONNREFUSED" });
      }
      return new Response(JSON.stringify({ via: "node-b" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    const response = await proxyAwareFetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "e2e-model" }),
    }, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:20129",
      strictProxy: true,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ via: "node-b" });
    expect(fetchMock.mock.calls.map(([requestUrl]) => requestUrl)).toEqual([target, target]);

    const status = await manager.getLocalProxyStatus();
    const evidence = status.requestFailoverEvidence[status.requestFailoverEvidence.length - 1];
    expect(status.selectedNodeId).toBe("node-b");
    expect(status.requestFailoverCount).toBe(1);
    expect(evidence).toMatchObject({
      target: "http://upstream.test",
      fromNodeId: "node-a",
      toNodeId: "node-b",
      attempt: 1,
      phase: "tcp_connect",
      directFallbackAllowed: false,
      switched: true,
    });
    expect(mocks.updateLocalProxyNode).toHaveBeenCalledWith("node-a", {
      healthStatus: "degraded",
      lastError: expect.stringContaining("ECONNREFUSED"),
    });
  });

  it("recognizes a custom local-sidecar port and fails over through it", async () => {
    vi.resetModules();
    vi.stubEnv("NINE_ROUTER_LOCAL_PROXY_PORT", "20729");
    delete globalThis.__nineRouterLocalProxyState;
    delete globalThis.__nineRouterRequestProxyFailover;
    mocks.getLocalProxyNodes.mockResolvedValue([nodes.a, nodes.b]);
    mocks.getLocalProxyNodeById.mockImplementation(async (id) => [nodes.a, nodes.b].find((node) => node.id === id) || null);

    const manager = await import("../../src/lib/network/localProxyManager.js");
    globalThis.__nineRouterLocalProxyState.selectedNodeId = "node-a";

    const target = "http://upstream.test/v1/models";
    const fetchMock = vi.fn(async () => {
      if (globalThis.__nineRouterLocalProxyState.selectedNodeId === "node-a") {
        throw Object.assign(new TypeError("connect ECONNREFUSED 127.0.0.1:8080"), { code: "ECONNREFUSED" });
      }
      return new Response(JSON.stringify({ via: "node-b" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    const response = await proxyAwareFetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "e2e-model" }),
    }, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:20729",
      strictProxy: true,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ via: "node-b" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const status = await manager.getLocalProxyStatus();
    const evidence = status.requestFailoverEvidence[status.requestFailoverEvidence.length - 1];
    expect(status.proxyUrl).toBe("http://127.0.0.1:20729");
    expect(status.selectedNodeId).toBe("node-b");
    expect(evidence).toMatchObject({
      target: "http://upstream.test",
      fromNodeId: "node-a",
      toNodeId: "node-b",
      attempt: 1,
      phase: "tcp_connect",
      directFallbackAllowed: false,
      switched: true,
    });
  });

  it("routes a non-sidecar connection proxy through the generic proxy dispatcher", async () => {
    vi.resetModules();
    vi.stubEnv("NINE_ROUTER_LOCAL_PROXY_PORT", "20729");
    const fetchMock = vi.fn(async (url, options) => {
      expect(url).toBe("http://upstream.test/v1/models");
      expect(options?.dispatcher).toBeTruthy();
      return new Response(JSON.stringify({ via: "generic-proxy" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    const response = await proxyAwareFetch("http://upstream.test/v1/models", { method: "GET" }, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:20129",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ via: "generic-proxy" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("provider test Local Proxy path", () => {
  it("skips duplicate sidecar preflight and requests through proxyAwareFetch failover", async () => {
    vi.resetModules();
    vi.stubEnv("NINE_ROUTER_LOCAL_PROXY_PORT", "20129");
    delete globalThis.__nineRouterLocalProxyState;
    delete globalThis.__nineRouterRequestProxyFailover;
    mocks.getLocalProxyNodes.mockResolvedValue([nodes.a, nodes.b]);
    mocks.getLocalProxyNodeById.mockImplementation(async (id) => [nodes.a, nodes.b].find((node) => node.id === id) || null);
    const manager = await import("../../src/lib/network/localProxyManager.js");
    globalThis.__nineRouterLocalProxyState.selectedNodeId = "node-a";

    mocks.getProviderConnectionById.mockResolvedValue({
      id: "provider-e2e",
      provider: "openai-compatible-e2e",
      authType: "apikey",
      apiKey: "e2e-key",
      providerSpecificData: {
        baseUrl: "http://upstream.test/v1",
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://127.0.0.1:20129",
        connectionNoProxy: "",
      },
    });
    mocks.resolveConnectionProxyConfig.mockResolvedValue({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:20129",
      connectionNoProxy: "",
      vercelRelayUrl: "",
    });
    mocks.testProxyUrl.mockRejectedValue(new Error("local sidecar preflight should not run"));

    const target = "http://upstream.test/v1/models";
    const fetchMock = vi.fn(async (url, options) => {
      expect(url).toBe(target);
      expect(options?.dispatcher).toBeTruthy();
      if (globalThis.__nineRouterLocalProxyState.selectedNodeId === "node-a") {
        throw Object.assign(new TypeError("connect ECONNREFUSED 127.0.0.1:8080"), { code: "ECONNREFUSED" });
      }
      return new Response(JSON.stringify({ data: [{ id: "e2e-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");

    const result = await testSingleConnection("provider-e2e");

    expect(result).toMatchObject({ valid: true, error: null });
    expect(mocks.testProxyUrl).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, options]) => Boolean(options?.dispatcher))).toBe(true);
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("provider-e2e", expect.objectContaining({
      testStatus: "active",
      lastError: null,
    }));

    const status = await manager.getLocalProxyStatus();
    const evidence = status.requestFailoverEvidence[status.requestFailoverEvidence.length - 1];
    expect(status.selectedNodeId).toBe("node-b");
    expect(evidence).toMatchObject({
      target: "http://upstream.test",
      fromNodeId: "node-a",
      toNodeId: "node-b",
      attempt: 1,
      phase: "tcp_connect",
      directFallbackAllowed: true,
      switched: true,
    });
  });
});
