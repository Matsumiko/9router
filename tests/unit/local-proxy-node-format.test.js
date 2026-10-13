import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLocalProxyNodes: vi.fn(),
  getProxySubscriptions: vi.fn(async () => []),
  getLocalProxyNodeById: vi.fn(),
  updateLocalProxyNode: vi.fn(),
  deleteLocalProxyNodesByHealthStatus: vi.fn(),
}));

vi.mock("@/lib/dataDir", () => ({ DATA_DIR: "/tmp/9router-node-format-test", getDataDir: () => "/tmp/9router-node-format-test" }));
vi.mock("@/lib/db/index.js", () => mocks);
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("@/lib/network/proxyTest.js", () => ({ testProxyUrl: vi.fn() }));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrlResolved: vi.fn() }));
vi.mock("@/lib/runtimeFingerprint.js", () => ({ getRuntimeFingerprint: () => ({ buildIdentity: "test" }) }));
vi.mock("@/lib/network/localProxyHealthScheduler.js", () => ({ getLocalProxyAutoHealthStatus: () => ({ running: false }) }));

afterEach(() => {
  delete globalThis.__nineRouterLocalProxyState;
  vi.resetModules();
  vi.clearAllMocks();
});

describe("local proxy node formats", () => {
  it("parses VMess WebSocket host separately from TLS SNI", async () => {
    const { parseSubscriptionText } = await import("../../src/lib/db/repos/proxySubscriptionsRepo.js");
    const payload = Buffer.from(JSON.stringify({
      v: "2",
      ps: "cdn-vmess",
      add: "edge.example.com",
      port: "443",
      id: "11111111-1111-4111-8111-111111111111",
      aid: "0",
      scy: "auto",
      net: "ws",
      type: "none",
      host: "cdn.example.com",
      sni: "tls.example.com",
      path: "/socket",
      tls: "tls",
    })).toString("base64url");

    const [node] = parseSubscriptionText(`vmess://${payload}`);
    expect(node).toMatchObject({
      type: "vmess",
      server: "edge.example.com",
      port: 443,
      network: "ws",
      host: "cdn.example.com",
      sni: "tls.example.com",
      path: "/socket",
    });
  });

  it("parses legacy SS and preserves plaintext SS-2022 credentials", async () => {
    const { parseSubscriptionText } = await import("../../src/lib/db/repos/proxySubscriptionsRepo.js");
    const legacy = `ss://${Buffer.from("aes-256-gcm:legacy-pass@legacy.example.com:8443").toString("base64url")}#legacy`;
    const [legacyNode] = parseSubscriptionText(legacy);
    expect(legacyNode.outbound).toMatchObject({ method: "aes-256-gcm", password: "legacy-pass", server_port: 8443 });

    const [ss2022Node] = parseSubscriptionText("ss://2022-blake3-aes-128-gcm:plain-pass@secure.example.com:443#ss2022");
    expect(ss2022Node.outbound).toMatchObject({ method: "2022-blake3-aes-128-gcm", password: "plain-pass", server_port: 443 });
  });

  it("renders VLESS WebSocket and Reality as sing-box nested settings", async () => {
    const node = {
      id: "vless-node",
      type: "vless",
      name: "vless-reality",
      server: "edge.example.com",
      port: 443,
      uuid: "11111111-1111-4111-8111-111111111111",
      params: {
        type: "ws",
        security: "reality",
        sni: "tls.example.com",
        host: "cdn.example.com",
        path: "/socket",
        pbk: "public-key",
        sid: "abcd",
        fp: "chrome",
      },
      enabled: true,
      healthStatus: "unknown",
    };
    mocks.getLocalProxyNodes.mockResolvedValue([node]);
    const manager = await import("../../src/lib/network/localProxyManager.js");
    const config = JSON.parse((await manager.rebuildLocalProxyConfig()).json);
    const outbound = config.outbounds.find((entry) => entry.tag === node.id);

    expect(outbound).toMatchObject({
      type: "vless",
      uuid: node.uuid,
      packet_encoding: "xudp",
      flow: "",
      transport: { type: "ws", path: "/socket", headers: { Host: "cdn.example.com" } },
      tls: {
        enabled: true,
        server_name: "tls.example.com",
        reality: { enabled: true, public_key: "public-key", short_id: "abcd" },
        utls: { enabled: true, fingerprint: "chrome" },
      },
    });
    expect(outbound.network).toBeUndefined();
  });

  it("renders VMess WebSocket transport instead of a top-level ws network", async () => {
    mocks.getLocalProxyNodes.mockResolvedValue([{
      id: "vmess-node",
      type: "vmess",
      name: "vmess-ws",
      server: "edge.example.com",
      port: 443,
      uuid: "11111111-1111-4111-8111-111111111111",
      alterId: 0,
      cipher: "auto",
      network: "ws",
      host: "cdn.example.com",
      sni: "tls.example.com",
      path: "/socket",
      tls: true,
      enabled: true,
      healthStatus: "unknown",
    }]);
    const manager = await import("../../src/lib/network/localProxyManager.js");
    const config = JSON.parse((await manager.rebuildLocalProxyConfig()).json);
    const outbound = config.outbounds.find((entry) => entry.tag === "vmess-node");

    expect(outbound.transport).toMatchObject({ type: "ws", path: "/socket", headers: { Host: "cdn.example.com" } });
    expect(outbound.tls).toMatchObject({ enabled: true, server_name: "tls.example.com" });
    expect(outbound.network).toBeUndefined();
  });
  it("defaults the selector to the healthiest enabled node", async () => {
    mocks.getLocalProxyNodes.mockResolvedValue([
      { id: "dead-node", type: "vless", name: "dead", server: "dead.example.com", port: 443, uuid: "11111111-1111-4111-8111-111111111111", params: { type: "ws", path: "/dead", host: "dead.example.com", security: "tls", sni: "dead.example.com" }, enabled: true, healthStatus: "unhealthy", latencyMs: 20 },
      { id: "healthy-node", type: "vless", name: "healthy", server: "healthy.example.com", port: 443, uuid: "22222222-2222-4222-8222-222222222222", params: { type: "ws", path: "/healthy", host: "healthy.example.com", security: "tls", sni: "healthy.example.com" }, enabled: true, healthStatus: "healthy", latencyMs: 100 },
    ]);
    const manager = await import("../../src/lib/network/localProxyManager.js");
    const config = JSON.parse((await manager.rebuildLocalProxyConfig()).json);

    expect(config.outbounds.find((entry) => entry.tag === "proxy-auto").default).toBe("healthy-node");
  });
  it("routes relay DNS directly and resolves target DNS through the selected proxy", async () => {
    mocks.getLocalProxyNodes.mockResolvedValue([
      { id: "relay-node", type: "vless", name: "relay", server: "relay.example.com", port: 443, uuid: "33333333-3333-4333-8333-333333333333", params: { type: "ws", path: "/relay", host: "relay.example.com", security: "tls", sni: "relay.example.com" }, enabled: true, healthStatus: "healthy", latencyMs: 10 },
    ]);
    const manager = await import("../../src/lib/network/localProxyManager.js");
    const config = JSON.parse((await manager.rebuildLocalProxyConfig()).json);

    expect(config.dns).toMatchObject({ final: "dns-remote" });
    expect(config.dns.rules).toContainEqual({ action: "route", domain: ["relay.example.com"], server: "dns-direct" });
    expect(config.dns.servers).toContainEqual({ type: "tls", tag: "dns-remote", server: "8.8.8.8", detour: "proxy-auto", domain_resolver: "dns-local" });
    expect(config.route.default_domain_resolver).toEqual({ server: "dns-direct", strategy: "" });
    expect(config.route.rules).toContainEqual({ action: "sniff", inbound: ["proxy-in"] });
    expect(config.route.rules).toContainEqual({ action: "hijack-dns", protocol: "dns" });
  });
});

describe("local proxy degraded-node cleanup", () => {
  it("deletes only degraded nodes through the explicit bulk endpoint", async () => {
    mocks.deleteLocalProxyNodesByHealthStatus.mockResolvedValue([{ id: "node-a", healthStatus: "degraded" }]);
    const { DELETE } = await import("../../src/app/api/local-proxy/nodes/route.js");
    const response = await DELETE(new Request("http://localhost/api/local-proxy/nodes", { method: "DELETE", body: JSON.stringify({ healthStatus: "degraded", subscriptionId: "sub-1" }), headers: { "Content-Type": "application/json" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, deletedNodes: 1 });
    expect(mocks.deleteLocalProxyNodesByHealthStatus).toHaveBeenCalledWith("degraded", { subscriptionId: "sub-1" });
  });

  it("rejects bulk deletion of non-degraded statuses", async () => {
    const { DELETE } = await import("../../src/app/api/local-proxy/nodes/route.js");
    const response = await DELETE(new Request("http://localhost/api/local-proxy/nodes", { method: "DELETE", body: JSON.stringify({ healthStatus: "healthy" }), headers: { "Content-Type": "application/json" } }));
    expect(response.status).toBe(400);
    expect(mocks.deleteLocalProxyNodesByHealthStatus).not.toHaveBeenCalled();
  });
});
