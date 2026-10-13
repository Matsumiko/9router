import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

const originalFetch = globalThis.fetch;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Google provider proxy policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    proxyAwareFetch.mockResolvedValue(jsonResponse({ access_token: "new-access", expires_in: 3600 }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("passes bypassLocalProxy to Google OAuth refresh", async () => {
    const { refreshGoogleToken } = await import("../../open-sse/services/tokenRefresh/providers.js");
    const proxyOptions = { bypassLocalProxy: true, connectionProxyEnabled: false, connectionProxyUrl: "" };

    await refreshGoogleToken("unique-google-refresh-token", "client-id", "client-secret", console, proxyOptions);

    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST" }),
      proxyOptions,
    );
  });

  it("passes bypassLocalProxy to Antigravity project discovery", async () => {
    const { getProjectIdForConnection, removeConnection } = await import("../../open-sse/services/projectId.js");
    const proxyOptions = { bypassLocalProxy: true, connectionProxyEnabled: false, connectionProxyUrl: "" };
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ cloudaicompanionProject: { id: "antigravity-project" } }));

    const projectId = await getProjectIdForConnection("google-proxy-policy-connection", "access-token", "antigravity", proxyOptions);

    expect(projectId).toBe("antigravity-project");
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      expect.objectContaining({ method: "POST" }),
      proxyOptions,
    );
    removeConnection("google-proxy-policy-connection");
  });
});
