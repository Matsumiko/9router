import { afterEach, describe, expect, it, vi } from "vitest";

const LOCAL_SIDECAR = "http://127.0.0.1:20129";
const TARGET_URL = "https://upstream.test/v1/chat/completions";
const PROXY_OPTIONS = {
  enabled: true,
  url: LOCAL_SIDECAR,
  strictProxy: true,
};

async function loadProxyAwareFetch(fetchMock) {
  vi.resetModules();
  vi.stubGlobal("fetch", fetchMock);
  const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
  return proxyAwareFetch;
}

function failingProxyError() {
  return new TypeError("local sidecar transport failed before response");
}

afterEach(() => {
  delete globalThis.__nineRouterRequestProxyFailover;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("proxyAwareFetch local-sidecar replay boundaries", () => {
  it.each([
    ["ReadableStream", () => new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } })],
    ["async iterable", () => ({ async *[Symbol.asyncIterator]() { yield "one-shot"; } })],
  ])("does not replay a %s request body after a pre-response failure", async (_label, makeBody) => {
    const fetchMock = vi.fn().mockRejectedValue(failingProxyError());
    const failover = vi.fn(async () => ({ switched: true, nodeId: "alternate" }));
    globalThis.__nineRouterRequestProxyFailover = failover;
    const proxyAwareFetch = await loadProxyAwareFetch(fetchMock);

    await expect(proxyAwareFetch(TARGET_URL, {
      method: "POST",
      body: makeBody(),
      duplex: "half",
    }, PROXY_OPTIONS)).rejects.toThrow(/sidecar transport failed|proxy required/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(failover).not.toHaveBeenCalled();
  });

  it("does not retry after response data has started, even when the body later fails", async () => {
    let failBody;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: token\n\n"));
        failBody = () => controller.error(new Error("connection lost after token"));
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    const failover = vi.fn();
    globalThis.__nineRouterRequestProxyFailover = failover;
    const proxyAwareFetch = await loadProxyAwareFetch(fetchMock);

    const response = await proxyAwareFetch(TARGET_URL, {
      method: "POST",
      body: JSON.stringify({ stream: true }),
      headers: { "content-type": "application/json" },
    }, PROXY_OPTIONS);
    const reader = response.body.getReader();
    const firstChunk = await reader.read();
    expect(firstChunk.done).toBe(false);
    expect(new TextDecoder().decode(firstChunk.value)).toContain("token");

    failBody();
    await expect(reader.read()).rejects.toThrow("connection lost after token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(failover).not.toHaveBeenCalled();
  });


  it("bounds replayable-body failover and reports structured context", async () => {
    const fetchMock = vi.fn().mockRejectedValue(failingProxyError());
    const failover = vi.fn(async () => ({ switched: true, nodeId: "next-node" }));
    globalThis.__nineRouterRequestProxyFailover = failover;
    const proxyAwareFetch = await loadProxyAwareFetch(fetchMock);

    await expect(proxyAwareFetch(TARGET_URL, {
      method: "POST",
      body: JSON.stringify({ replayable: true }),
    }, PROXY_OPTIONS)).rejects.toThrow(/candidates exhausted/i);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(failover).toHaveBeenCalledTimes(3);
    expect(failover.mock.calls[0][2]).toMatchObject({
      target: "https://upstream.test",
      attempt: 1,
      phase: "response_headers",
      directFallbackAllowed: false,
    });
  });

  it("annotates a body failure before the first chunk as response-header/first-token transport evidence", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.error(new Error("upstream stalled before first chunk")); },
    }), { status: 200 }));
    const proxyAwareFetch = await loadProxyAwareFetch(fetchMock);

    const response = await proxyAwareFetch(TARGET_URL, { method: "POST", body: "{}" }, PROXY_OPTIONS);
    await expect(response.body.getReader().read()).rejects.toMatchObject({ proxyPhase: "first_token" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("annotates a body failure after data as stream interruption without retry", async () => {
    let failBody;
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: token\\n\\n"));
        failBody = () => controller.error(new Error("upstream stream interrupted"));
      },
    }), { status: 200 }));
    const proxyAwareFetch = await loadProxyAwareFetch(fetchMock);

    const response = await proxyAwareFetch(TARGET_URL, { method: "POST", body: "{}" }, PROXY_OPTIONS);
    const reader = response.body.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    failBody();
    await expect(reader.read()).rejects.toMatchObject({ proxyPhase: "stream_interruption" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
 });
