import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const MAX_SUBSCRIPTION_BYTES = 2 * 1024 * 1024;
const SUBSCRIPTION_FETCH_ATTEMPTS = 3;
const SUBSCRIPTION_RETRY_DELAY_MS = 250;
const SUPPORTED_SCHEMES = new Set(["ss:", "vmess:", "vless:", "trojan:", "http:", "https:", "socks5:", "socks5h:"]);

function now() { return new Date().toISOString(); }
function text(value) { return typeof value === "string" ? value.trim() : ""; }
function port(value) { const n = Number(value); return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 0; }

function looksLikeSubscriptionPayload(value) {
  const candidate = text(value);
  return /^(?:#.*\r?\n\s*)*(?:(?:ss|vmess|vless|trojan|https?|socks5h?):\/\/|[\[{])/i.test(candidate);
}

function decodeBase64(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  try { return Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="), "base64").toString("utf8"); } catch { return ""; }
}

function decodeSubscription(textValue) {
  const raw = text(textValue).replace(/^\uFEFF/, "");
  if (!raw || looksLikeSubscriptionPayload(raw)) return raw;
  const decoded = decodeBase64(raw);
  return looksLikeSubscriptionPayload(decoded) ? decoded : raw;
}


function parseVmess(uri, index) {
  try {
    const encoded = decodeBase64(uri.slice(8).split("#")[0]);
    const value = JSON.parse(encoded);
    const server = value.add || value.server;
    const nodePort = port(value.port) || 443;
    if (!server || !value.id) return null;
    return { type: "vmess", name: decodeURIComponent(uri.split("#")[1] || value.ps || `VMESS ${index + 1}`), server, port: nodePort, uuid: value.id, alterId: Number(value.aid || 0) || 0, cipher: value.scy || "auto", network: value.net || "tcp", tls: ["tls", "reality"].includes(value.tls), host: value.host || "", sni: value.sni || "", path: value.path || "", params: { type: value.net || "tcp", security: value.tls || "", sni: value.sni || "", host: value.host || "", path: value.path || "" }, uri };
  } catch {
    try {
      const parsed = new URL(uri);
      const nodePort = port(parsed.port) || 443;
      if (!parsed.hostname || !parsed.username) return null;
      const security = parsed.searchParams.get("security") || "";
      return { type: "vmess", name: parsed.hash ? decodeURIComponent(parsed.hash.slice(1)) : `VMESS ${index + 1}`, server: parsed.hostname, port: nodePort, uuid: decodeURIComponent(parsed.username), network: parsed.searchParams.get("type") || "tcp", tls: ["tls", "reality"].includes(security), host: parsed.searchParams.get("host") || "", sni: parsed.searchParams.get("sni") || parsed.searchParams.get("peer") || "", path: parsed.searchParams.get("path") || "", params: Object.fromEntries(parsed.searchParams.entries()), uri };
    } catch { return null; }
  }
}

function parseShadowsocks(uri, index) {
  const raw = text(uri);
  const hashIndex = raw.indexOf("#");
  const fragment = hashIndex >= 0 ? raw.slice(hashIndex + 1) : "";
  const withoutFragment = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const payload = withoutFragment.slice("ss://".length);
  let parsed;
  try {
    if (!payload.includes("@")) {
      const decoded = decodeBase64(payload);
      if (!decoded.includes("@")) return null;
      parsed = new URL(`ss://${decoded}`);
    } else parsed = new URL(withoutFragment);
  } catch { return null; }
  const serverPort = port(parsed.port);
  if (!parsed.hostname || !serverPort) return null;
  let method;
  let password;
  if (parsed.password) {
    method = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
  } else {
    const decoded = decodeBase64(decodeURIComponent(parsed.username));
    const separator = decoded.indexOf(":");
    if (separator <= 0) return null;
    method = decoded.slice(0, separator);
    password = decoded.slice(separator + 1);
  }
  if (!method || !password) return null;
  const pluginSpec = parsed.searchParams.get("plugin") || "";
  const [plugin, ...pluginOptions] = pluginSpec.split(";");
  return { type: "ss", name: fragment ? decodeURIComponent(fragment) : `SS ${index + 1}`, server: parsed.hostname, port: serverPort, params: Object.fromEntries(parsed.searchParams.entries()), outbound: { type: "shadowsocks", server: parsed.hostname, server_port: serverPort, method, password, plugin: plugin === "simple-obfs" ? "obfs-local" : (plugin || undefined), plugin_opts: pluginOptions.join(";") || undefined }, uri: raw };
}

function parseUri(uri, index) {
  const raw = text(uri);
  if (!raw || raw.startsWith("#")) return null;
  if (raw.toLowerCase().startsWith("vmess://")) return parseVmess(raw, index);
  if (raw.toLowerCase().startsWith("ss://")) return parseShadowsocks(raw, index);
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  if (!SUPPORTED_SCHEMES.has(parsed.protocol) || !parsed.hostname) return null;
  const type = parsed.protocol.slice(0, -1);
  const nodePort = port(parsed.port) || (["vless", "trojan", "https"].includes(type) ? 443 : 0);
  if (!nodePort) return null;
  const node = { type, name: parsed.hash ? decodeURIComponent(parsed.hash.slice(1)) : `${type.toUpperCase()} ${index + 1}`, server: parsed.hostname, port: nodePort, uri: raw, params: Object.fromEntries(parsed.searchParams.entries()) };
  if (type === "vless") node.uuid = decodeURIComponent(parsed.username);
  if (type === "trojan") node.password = decodeURIComponent(parsed.username || parsed.pathname.slice(1));
  if (["http", "https", "socks5", "socks5h"].includes(type)) { node.username = decodeURIComponent(parsed.username || ""); node.password = decodeURIComponent(parsed.password || ""); }
  return node;
}

export function parseSubscriptionText(value) {
  const decoded = decodeSubscription(value);
  if (!decoded) return [];
  try {
    const json = JSON.parse(decoded);
    const entries = Array.isArray(json) ? json : (json.outbounds || json.proxies || json.nodes || []);
    if (Array.isArray(entries)) return entries.map((entry, index) => {
      if (typeof entry === "string") return parseUri(entry, index);
      if (!entry || typeof entry !== "object") return null;
      if (entry.uri) return parseUri(entry.uri, index);
      if (!entry.type || ["direct", "block", "dns", "selector", "urltest", "url-test", "fallback", "detour", "route_address"].includes(entry.type)) return null;
      if (!entry.server || !entry.server_port) return null;
      return { type: entry.type === "socks" ? "socks5" : entry.type, name: entry.tag || `${String(entry.type).toUpperCase()} ${index + 1}`, server: entry.server, port: port(entry.server_port), uri: null, outbound: entry };
    }).filter((entry) => entry && entry.port);
  } catch { /* URI list */ }
  return decoded.split(/\r?\n/).map((line, index) => parseUri(line, index)).filter(Boolean);
}

function subscriptionRow(row) {
  if (!row) return null;
  return { ...parseJson(row.data, {}), id: row.id, name: row.name, url: row.url, isActive: row.isActive === 1, lastFetchedAt: row.lastFetchedAt, lastError: row.lastError, createdAt: row.createdAt, updatedAt: row.updatedAt };
}
function nodeRow(row) {
  if (!row) return null;
  return { ...parseJson(row.data, {}), id: row.id, subscriptionId: row.subscriptionId, type: row.type, name: row.name, server: row.server, port: row.port, enabled: row.enabled === 1, healthStatus: row.healthStatus || "unknown", latencyMs: row.latencyMs, lastCheckedAt: row.lastCheckedAt, lastError: row.lastError, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export async function getProxySubscriptions() { const db = await getAdapter(); return db.all("SELECT * FROM proxySubscriptions ORDER BY createdAt DESC").map(subscriptionRow); }
export async function getProxySubscriptionById(id) { const db = await getAdapter(); return subscriptionRow(db.get("SELECT * FROM proxySubscriptions WHERE id = ?", [id])); }

export async function createProxySubscription(input) {
  const db = await getAdapter(); const timestamp = now();
  const subscription = { id: input.id || uuidv4(), name: input.name, url: input.url, isActive: input.isActive !== false, lastFetchedAt: null, lastError: null, createdAt: timestamp, updatedAt: timestamp };
  db.run("INSERT INTO proxySubscriptions(id, name, url, isActive, lastFetchedAt, lastError, data, createdAt, updatedAt) VALUES(?, ?, ?, 1, NULL, NULL, ?, ?, ?)", [subscription.id, subscription.name, subscription.url, stringifyJson({}), timestamp, timestamp]);
  return subscription;
}

export async function updateProxySubscription(id, updates) {
  const db = await getAdapter(); const current = await getProxySubscriptionById(id); if (!current) return null;
  const next = { ...current, ...updates, updatedAt: now() };
  db.run("UPDATE proxySubscriptions SET name=?, url=?, isActive=?, data=?, updatedAt=? WHERE id=?", [next.name, next.url, next.isActive === false ? 0 : 1, stringifyJson({}), next.updatedAt, id]);
  return next;
}

export async function deleteProxySubscription(id) {
  const db = await getAdapter(); let removed = null;
  db.transaction(() => { removed = subscriptionRow(db.get("SELECT * FROM proxySubscriptions WHERE id=?", [id])); db.run("DELETE FROM localProxyNodes WHERE subscriptionId=?", [id]); db.run("DELETE FROM proxySubscriptions WHERE id=?", [id]); });
  return removed;
}

export async function refreshProxySubscription(id) {
  const db = await getAdapter(); const subscription = await getProxySubscriptionById(id); if (!subscription) return null;
  try {
    let nodes = []; let lastError = null;
    for (let attempt = 1; attempt <= SUBSCRIPTION_FETCH_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(subscription.url, { headers: { "User-Agent": "9Router local proxy manager" }, signal: AbortSignal.timeout(15000), cache: "no-store" });
        if (!response.ok) {
          const error = new Error(`Subscription returned HTTP ${response.status}`);
          if (response.status < 500 || attempt === SUBSCRIPTION_FETCH_ATTEMPTS) throw error;
          lastError = error;
        } else {
          const body = await response.text(); if (body.length > MAX_SUBSCRIPTION_BYTES) throw new Error("Subscription exceeds 2 MiB");
          nodes = parseSubscriptionText(body); if (nodes.length) break;
          lastError = new Error("No supported proxy nodes found");
        }
      } catch (error) {
        lastError = error;
        if (attempt === SUBSCRIPTION_FETCH_ATTEMPTS || /exceeds 2 MiB/.test(error.message)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, SUBSCRIPTION_RETRY_DELAY_MS * attempt));
    }
    if (!nodes.length) throw lastError || new Error("No supported proxy nodes found");
    const timestamp = now();
    db.transaction(() => {
      db.run("DELETE FROM localProxyNodes WHERE subscriptionId=?", [id]);
      for (const node of nodes) db.run("INSERT INTO localProxyNodes(id, subscriptionId, type, name, server, port, enabled, healthStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, 1, 'unknown', ?, ?, ?)", [uuidv4(), id, node.type, node.name, node.server, node.port, stringifyJson(node), timestamp, timestamp]);
      db.run("UPDATE proxySubscriptions SET lastFetchedAt=?, lastError=NULL, updatedAt=? WHERE id=?", [timestamp, timestamp, id]);
    });
    return { subscription: await getProxySubscriptionById(id), importedNodes: nodes.length };
  } catch (error) { db.run("UPDATE proxySubscriptions SET lastError=?, updatedAt=? WHERE id=?", [error.message, now(), id]); throw error; }
}

export async function getLocalProxyNodes({ subscriptionId, enabledOnly = false } = {}) {
  const db = await getAdapter(); const where = []; const params = [];
  if (subscriptionId) { where.push("subscriptionId=?"); params.push(subscriptionId); } if (enabledOnly) where.push("enabled=1");
  return db.all(`SELECT * FROM localProxyNodes${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY name COLLATE NOCASE`, params).map(nodeRow);
}
export async function getLocalProxyNodeById(id) { const db = await getAdapter(); return nodeRow(db.get("SELECT * FROM localProxyNodes WHERE id=?", [id])); }

export async function createLocalProxyNode(input) {
  const db = await getAdapter(); const timestamp = now(); const node = { ...input, id: input.id || uuidv4(), enabled: input.enabled !== false, healthStatus: input.healthStatus || "unknown", createdAt: timestamp, updatedAt: timestamp };
  db.run("INSERT INTO localProxyNodes(id, subscriptionId, type, name, server, port, enabled, healthStatus, latencyMs, lastCheckedAt, lastError, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [node.id, node.subscriptionId || null, node.type, node.name, node.server, node.port, node.enabled ? 1 : 0, node.healthStatus, node.latencyMs || null, node.lastCheckedAt || null, node.lastError || null, stringifyJson(node), timestamp, timestamp]); return node;
}
export async function updateLocalProxyNode(id, updates) { const db = await getAdapter(); const current = await getLocalProxyNodeById(id); if (!current) return null; const next = { ...current, ...updates, updatedAt: now() }; db.run("UPDATE localProxyNodes SET name=?, server=?, port=?, enabled=?, healthStatus=?, latencyMs=?, lastCheckedAt=?, lastError=?, data=?, updatedAt=? WHERE id=?", [next.name, next.server, next.port, next.enabled ? 1 : 0, next.healthStatus, next.latencyMs || null, next.lastCheckedAt || null, next.lastError || null, stringifyJson(next), next.updatedAt, id]); return next; }
export async function deleteLocalProxyNode(id) { const db = await getAdapter(); const node = await getLocalProxyNodeById(id); if (node) db.run("DELETE FROM localProxyNodes WHERE id=?", [id]); return node; }
