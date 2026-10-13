import { Readable } from "stream";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { dbg } from "./debugLog.js";

const originalFetch = globalThis.fetch;
const proxyDispatchers = new Map();

// ─── TLS fingerprinting via got-scraping (browser-like JA3) ───────────────
// Disabled: not in use. Kept commented for future re-enable.
// Restore the original block to re-enable per-host JA3 spoofing.
/*
let _gotScraping = null;
let _gotScrapingChecked = false;
const _gotScrapingLoggedHosts = new Set();

async function getGotScraping() {
  if (_gotScrapingChecked) return _gotScraping;
  _gotScrapingChecked = true;
  try {
    const mod = await import("got-scraping");
    _gotScraping = typeof mod.gotScraping === "function" ? mod.gotScraping : null;
    if (_gotScraping) dbg("TLS", "got-scraping loaded (browser-like JA3 enabled)");
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping unavailable, falling back to native fetch: ${e.message}`);
    _gotScraping = null;
  }
  return _gotScraping;
}

async function gotScrapingFetch(url, options) {
  const gs = await getGotScraping();
  if (!gs) return null;

  const method = (options.method || "GET").toUpperCase();
  const headersInit = options.headers || {};
  const headers = headersInit instanceof Headers
    ? Object.fromEntries(headersInit.entries())
    : { ...headersInit };

  return new Promise((resolve, reject) => {
    let settled = false;
    const stream = gs.stream({
      url,
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : options.body,
      throwHttpErrors: false,
      retry: { limit: 0 },
      timeout: { request: undefined },
      followRedirect: false,
      decompress: true,
    });

    if (options.signal) {
      const onAbort = () => { try { stream.destroy(new Error("aborted")); } catch { } };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    stream.once("response", (res) => {
      if (settled) return;
      settled = true;
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers || {})) {
        if (Array.isArray(v)) v.forEach((x) => resHeaders.append(k, String(x)));
        else if (v != null) resHeaders.set(k, String(v));
      }
      const body = Readable.toWeb(stream);
      resolve(new Response(body, { status: res.statusCode, statusText: res.statusMessage || "", headers: resHeaders }));
    });

    stream.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function tryGotScrapingFetch(url, options) {
  try {
    const res = await gotScrapingFetch(url, options);
    if (res) {
      try {
        const host = new URL(typeof url === "string" ? url : url.toString()).hostname;
        if (!_gotScrapingLoggedHosts.has(host)) {
          _gotScrapingLoggedHosts.add(host);
          dbg("TLS", `using got-scraping for ${host}`);
        }
      } catch { }
    }
    return res;
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping request failed, fallback to native fetch: ${e.message}`);
    return null;
  }
}
*/

// DNS cache — use Map to avoid prototype pollution via malformed hostnames
const DNS_CACHE = new Map();
const TLS_CERT_ERRORS = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function isTlsCertError(err) {
  const code = err?.cause?.code || err?.code;
  return TLS_CERT_ERRORS.has(code);
}
const TRANSPORT_PHASES = Object.freeze({
  DNS: "dns",
  TCP_CONNECT: "tcp_connect",
  TLS: "tls",
  PROXY_TUNNEL: "proxy_tunnel",
  RESPONSE_HEADERS: "response_headers",
  FIRST_TOKEN: "first_token",
  STREAM_INTERRUPTION: "stream_interruption",
  CANCELLED: "cancelled",
});

function errorSignals(error, options) {
  const signals = [];
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && depth < 8 && !seen.has(current); depth += 1) {
    seen.add(current);
    signals.push(String(current.code || ""), String(current.name || ""), String(current.message || ""));
    current = current.cause;
  }
  if (options?.signal?.reason) {
    const reason = options.signal.reason;
    signals.push(String(reason.code || ""), String(reason.name || ""), String(reason.message || reason));
  }
  return signals.join(" ").toLowerCase();
}

function classifyTransportPhase(error, options, proxyUrl) {
  const abortReason = String(options?.signal?.reason?.message || options?.signal?.reason || "");
  if (options?.signal?.aborted && !/fetch connect timeout/i.test(abortReason)) {
    return TRANSPORT_PHASES.CANCELLED;
  }
  if (/fetch connect timeout/i.test(abortReason)) return TRANSPORT_PHASES.RESPONSE_HEADERS;
  const text = errorSignals(error, options);
  if (/enotfound|eai_again|eai_fail|eai_nodata|dns|name resolution/.test(text)) return TRANSPORT_PHASES.DNS;
  if (/tls|certificate|cert_|self_signed|unable_to_verify|altname/.test(text)) return TRANSPORT_PHASES.TLS;
  if (proxyUrl && /proxy|connect tunnel|tunnel|407/.test(text)) return TRANSPORT_PHASES.PROXY_TUNNEL;
  if (/und_err_connect_timeout|econnrefused|econnreset|econnaborted|etimedout|connect timeout|socket/.test(text)) {
    return TRANSPORT_PHASES.TCP_CONNECT;
  }
  return TRANSPORT_PHASES.RESPONSE_HEADERS;
}

function safeEndpoint(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "unknown";
  }
}

function safeProxyEndpoint(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "configured";
  }
}

function annotateTransportError(error, phase, targetUrl, proxyUrl) {
  const annotated = error instanceof Error ? error : new Error(String(error));
  if (!annotated.proxyPhase) annotated.proxyPhase = phase;
  if (!annotated.proxyTarget) annotated.proxyTarget = safeEndpoint(targetUrl);
  if (!annotated.proxyEndpoint && proxyUrl) annotated.proxyEndpoint = safeProxyEndpoint(proxyUrl);
  return annotated;
}

function logTransportError(error) {
  const proxy = error.proxyEndpoint ? ` proxy=${error.proxyEndpoint}` : "";
  console.warn(`[ProxyFetch] phase=${error.proxyPhase} target=${error.proxyTarget}${proxy} error=${error.message}`);
}

function wrapProxyPolicyError(message, error) {
  const wrapped = new Error(`${message}: ${error.message}`, { cause: error });
  if (error?.proxyPhase) wrapped.proxyPhase = error.proxyPhase;
  if (error?.proxyTarget) wrapped.proxyTarget = error.proxyTarget;
  if (error?.proxyEndpoint) wrapped.proxyEndpoint = error.proxyEndpoint;
  return wrapped;
}

function instrumentResponseBody(response, targetUrl, proxyUrl) {
  const reader = response?.body?.getReader?.();
  if (!reader) return response;
  let receivedChunk = false;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          return;
        }
        receivedChunk = true;
        controller.enqueue(result.value);
      } catch (error) {
        const phase = receivedChunk ? TRANSPORT_PHASES.STREAM_INTERRUPTION : TRANSPORT_PHASES.FIRST_TOKEN;
        const annotated = annotateTransportError(error, phase, targetUrl, proxyUrl);
        logTransportError(annotated);
        controller.error(annotated);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
const MITM_BYPASS_HOSTS = [
  "oauth2.googleapis.com",
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "api2.cursor.sh",
];
const GOOGLE_DNS_SERVERS = ["8.8.8.8", "8.8.4.4"];
const HTTPS_PORT = 443;
const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 300;

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Resolve real IP using Google DNS (bypass system DNS)
 */
async function resolveRealIP(hostname) {
  const cached = DNS_CACHE.get(hostname);
  if (cached && Date.now() < cached.expiry) return cached.ip;

  try {
    const dns = await import("dns");
    const { promisify } = await import("util");
    const resolver = new dns.Resolver();
    resolver.setServers(GOOGLE_DNS_SERVERS);
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    const addresses = await resolve4(hostname);
    DNS_CACHE.set(hostname, { ip: addresses[0], expiry: Date.now() + MEMORY_CONFIG.dnsCacheTtlMs });
    return addresses[0];
  } catch (error) {
    console.warn(`[ProxyFetch] DNS resolve failed for ${hostname}:`, error.message);
    return null;
  }
}

/**
 * Check if request should bypass MITM DNS redirect
 */
function shouldBypassMitmDns(url) {
  try {
    const hostname = new URL(url).hostname;
    return MITM_BYPASS_HOSTS.some(host => hostname.includes(host));
  } catch { return false; }
}

function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = normalizeString(noProxyValue);
  if (!noProxy) return false;

  let hostname;
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { return false; }
  const patterns = noProxy.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);

  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

/**
 * Get proxy URL from environment
 */
function getEnvProxyUrl(targetUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  let protocol;
  try { protocol = new URL(targetUrl).protocol; } catch { return null; }

  if (protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.ALL_PROXY || process.env.all_proxy;
  }

  return process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy;
}

/**
 * Normalize proxy URL (allow host:port)
 */
function normalizeProxyUrl(proxyUrl) {
  const normalizedInput = normalizeString(proxyUrl);
  if (!normalizedInput) return null;

  try {

    new URL(normalizedInput);
    return normalizedInput;
  } catch {
    // Allow "127.0.0.1:7890" style values
    return `http://${normalizedInput}`;
  }
}

function resolveConnectionProxyUrl(targetUrl, proxyOptions) {
  const enabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
  if (!enabled) return null;

  const proxyUrlRaw = normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  if (!proxyUrlRaw) return null;

  const noProxy = normalizeString(proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy);
  if (noProxy && shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  return normalizeProxyUrl(proxyUrlRaw);
}

/**
 * Create proxy dispatcher lazily (undici-compatible)
 */
async function getDispatcher(proxyUrl, insecure = false) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized && !insecure) return null;

  const key = `${normalized || "direct"}::${insecure ? "insecure" : "secure"}`;
  if (!proxyDispatchers.has(key)) {
    if (proxyDispatchers.size >= MEMORY_CONFIG.proxyDispatchersMaxSize) {
      proxyDispatchers.delete(proxyDispatchers.keys().next().value);
    }
    const { Agent, ProxyAgent } = await import("undici");
    const connect = insecure ? { rejectUnauthorized: false } : undefined;
    const dispatcher = normalized
      ? new ProxyAgent({ uri: normalized, ...(insecure ? { requestTls: connect } : {}) })
      : new Agent({ connect });
    proxyDispatchers.set(key, dispatcher);
  }
  return proxyDispatchers.get(key);
}

async function fetchWithTlsFallback(url, options, proxyUrl) {
  const targetUrl = typeof url === "string" ? url : url.toString();
  try {
    const dispatcher = proxyUrl ? await getDispatcher(proxyUrl) : undefined;
    const response = await originalFetch(url, dispatcher ? { ...options, dispatcher } : options);
    return instrumentResponseBody(response, targetUrl, proxyUrl);
  } catch (err) {
    const isStrictSsl = process.env.STRICT_SSL === "true" || process.env.STRICT_SSL === "1";
    if (!isStrictSsl && isTlsCertError(err)) {
      if (options.body && typeof options.body.getReader === "function" && options.body.locked) {
        const annotated = annotateTransportError(err, TRANSPORT_PHASES.TLS, targetUrl, proxyUrl);
        logTransportError(annotated);
        throw annotated;
      }
      console.warn(`[ProxyFetch] TLS cert verification failed (${err.cause?.code || err.code}), retrying with insecure TLS: ${targetUrl}`);
      try {
        const insecureDispatcher = await getDispatcher(proxyUrl, true);
        const response = await originalFetch(url, { ...options, dispatcher: insecureDispatcher });
        return instrumentResponseBody(response, targetUrl, proxyUrl);
      } catch (retryError) {
        const annotated = annotateTransportError(retryError, TRANSPORT_PHASES.TLS, targetUrl, proxyUrl);
        logTransportError(annotated);
        throw annotated;
      }
    }
    const annotated = annotateTransportError(err, classifyTransportPhase(err, options, proxyUrl), targetUrl, proxyUrl);
    logTransportError(annotated);
    throw annotated;
  }
}

function isLocalSidecarProxy(proxyUrl) {
  try {
    const parsed = new URL(proxyUrl);
    const configuredPort = String(process.env.NINE_ROUTER_LOCAL_PROXY_PORT || "20129");
    return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && parsed.port === configuredPort;
  } catch { return false; }
}
function shouldAllowDirectFallback(proxyUrl, options, proxyOptions) {
  if (!isLocalSidecarProxy(proxyUrl)) return true;
  if (proxyOptions?.allowDirectFallback === true) return true;
  const method = String(options?.method || "GET").toUpperCase();
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}


function canReplayRequestBody(options) {
  const body = options?.body;
  if (!body) return true;
  if (typeof body === "string" || body instanceof URLSearchParams || body instanceof Uint8Array || Buffer.isBuffer(body)) return true;
  return !(typeof body.getReader === "function" || typeof body.pipe === "function" || typeof body[Symbol.asyncIterator] === "function");
}

async function fetchThroughLocalSidecarWithFailover(url, options, proxyUrl, proxyOptions) {
  const tried = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetchWithTlsFallback(url, options, proxyUrl);
    } catch (proxyError) {
      if (!canReplayRequestBody(options) || options.signal?.aborted) throw proxyError;
      const failover = globalThis.__nineRouterRequestProxyFailover;
      if (typeof failover !== "function") throw proxyError;
      const result = await failover(proxyError.message, tried, {
        target: safeEndpoint(typeof url === "string" ? url : url.toString()),
        attempt: attempt + 1,
        phase: proxyError.proxyPhase || classifyTransportPhase(proxyError, options, proxyUrl),
        directFallbackAllowed: shouldAllowDirectFallback(proxyUrl, options, proxyOptions),
      });
      if (!result?.switched) throw proxyError;
      if (result.nodeId) tried.push(result.nodeId);
    }
  }
  throw new Error("Local sidecar proxy candidates exhausted");
}

/**
 * Create HTTPS request with manual socket connection (bypass DNS)
 */
async function createBypassRequest(parsedUrl, realIP, options) {
  const httpsModule = await import("https");
  const netModule = await import("net");
  // CJS modules expose exports via .default in ESM dynamic import context
  const https = httpsModule.default ?? httpsModule;
  const net = netModule.default ?? netModule;

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();

    socket.connect(HTTPS_PORT, realIP, () => {
      const reqOptions = {
        socket,
        // SNI + cert hostname are validated against the hostname the caller
        // asked for, not the IP we connected to. This keeps the DNS-bypass
        // (avoiding /etc/hosts MITM) while still rejecting on-path attackers
        // that present a different cert. The MITM_BYPASS_HOSTS targets are
        // all public-CA-issued (Google / GitHub / AWS / Cursor) so default
        // verification works without any extra trust store.
        servername: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || "POST",
        headers: {
          ...options.headers,
          Host: parsedUrl.hostname,
        },
      };

      const req = https.request(reqOptions, (res) => {
        const response = {
          ok: res.statusCode >= HTTP_SUCCESS_MIN && res.statusCode < HTTP_SUCCESS_MAX,
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: new Map(Object.entries(res.headers)),
          body: Readable.toWeb(res),
          text: async () => {
            const chunks = [];
            for await (const chunk of res) chunks.push(chunk);
            return Buffer.concat(chunks).toString();
          },
          json: async () => JSON.parse(await response.text()),
        };
        resolve(response);
      });

      req.on("error", reject);
      if (options.body) {
        req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });

    socket.on("error", reject);
  });
}

async function fetchWithProxyPolicy(url, options, proxyUrl, proxyOptions) {
  if (isLocalSidecarProxy(proxyUrl)) return fetchThroughLocalSidecarWithFailover(url, options, proxyUrl, proxyOptions);
  return fetchWithTlsFallback(url, options, proxyUrl);
}

export async function proxyAwareFetch(url, options = {}, proxyOptions = null) {
  const targetUrl = typeof url === "string" ? url : url.toString();

  // Vercel relay: forward request via relay headers
  const vercelRelayUrl = normalizeString(proxyOptions?.vercelRelayUrl);
  if (vercelRelayUrl) {
    const parsed = new URL(targetUrl);
    const baseHeaders = options.headers instanceof Headers
      ? Object.fromEntries(options.headers.entries())
      : { ...(options.headers || {}) };
    const relayHeaders = {
      ...baseHeaders,
      "x-relay-target": `${parsed.protocol}//${parsed.host}`,
      "x-relay-path": `${parsed.pathname}${parsed.search}`,
    };
    return originalFetch(vercelRelayUrl, { ...options, headers: relayHeaders });
  }

  const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);
  const envProxyCandidate = normalizeProxyUrl(getEnvProxyUrl(targetUrl));
  const envProxyUrl = connectionProxyUrl
    ? null
    : (proxyOptions?.bypassLocalProxy && isLocalSidecarProxy(envProxyCandidate) ? null : envProxyCandidate);
  const proxyUrl = connectionProxyUrl || envProxyUrl;

  // MITM DNS bypass: for known MITM-intercepted hosts, resolve real IP to avoid DNS spoof
  if (shouldBypassMitmDns(targetUrl)) {
    if (proxyUrl) {
      // Proxy resolves DNS externally (not affected by /etc/hosts) — use proxy directly
      try {
        return await fetchWithProxyPolicy(url, options, proxyUrl, proxyOptions);
      } catch (proxyError) {
        if (proxyOptions?.strictProxy === true) throw wrapProxyPolicyError("[ProxyFetch] Proxy required but failed (strictProxy=true)", proxyError);
        if (!shouldAllowDirectFallback(proxyUrl, options, proxyOptions)) throw proxyError;
        console.warn(`[ProxyFetch] Proxy failed, falling back to direct bypass: ${proxyError.message}`);
      }
    }
    // No proxy — manually resolve real IP to bypass DNS spoof
    try {
      const parsedUrl = new URL(targetUrl);
      const realIP = await resolveRealIP(parsedUrl.hostname);
      if (realIP) return await createBypassRequest(parsedUrl, realIP, options);
    } catch (error) {
      console.warn(`[ProxyFetch] MITM bypass failed: ${error.message}`);
    }
  }

  if (proxyUrl) {
    try {
      return await fetchWithProxyPolicy(url, options, proxyUrl, proxyOptions);
    } catch (proxyError) {
      // If strictProxy is enabled, fail hard instead of falling back to direct
      if (proxyOptions?.strictProxy === true) throw wrapProxyPolicyError("[ProxyFetch] Proxy required but failed (strictProxy=true)", proxyError);
      if (!shouldAllowDirectFallback(proxyUrl, options, proxyOptions)) throw proxyError;
      console.warn(`[ProxyFetch] Proxy failed, falling back to direct: ${proxyError.message}`);
      return fetchWithTlsFallback(url, options, null);
    }
  }

  // Strict mode means "never leave over the direct IP". Reaching here with a
  // proxy configured but unresolved is exactly that case — an inactive or
  // empty pool, or every proxy removed — so refuse instead of silently
  // exposing the real address (#4333). The catch blocks above only cover a
  // proxy that was actually tried.
  //
  // Gate on a proxy being *intended*: callers like the Qoder executor set
  // strictProxy to mean "do not replay this request directly if the proxy
  // fails" (a replayed COSY signature returns 403), not "a proxy is required".
  // With nothing configured they must keep working.
  const proxyIntended = proxyOptions?.proxyPoolId
    || proxyOptions?.enabled === true
    || proxyOptions?.connectionProxyEnabled === true
    || !!normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  if (proxyOptions?.strictProxy === true && proxyIntended) {
    throw new Error("[ProxyFetch] Proxy required but none resolved (strictProxy=true)");
  }

  // got-scraping disabled — use native fetch directly
  // (Re-enable per-host by wrapping with tryGotScrapingFetch when needed)
  return fetchWithTlsFallback(url, options, null);
}

/**
 * Patched global fetch with env-proxy support and MITM DNS bypass
 */
async function patchedFetch(url, options = {}) {
  return proxyAwareFetch(url, options, null);
}

// Idempotency guard — only patch once to avoid wrapping multiple times
if (globalThis.fetch !== patchedFetch) {
  globalThis.fetch = patchedFetch;
}

export default patchedFetch;
