import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLocalProxyNodes: vi.fn(),
  getProxySubscriptions: vi.fn(async () => []),
  getLocalProxyNodeById: vi.fn(),
  updateLocalProxyNode: vi.fn(),
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
});
